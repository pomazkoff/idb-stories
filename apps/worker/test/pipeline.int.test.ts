import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MediaProcessJob, type EventsIngestJob } from '@idb-stories/core';
import type { AdminGroup, AdminMediaAsset, GroupStats } from '@idb-stories/schema';
import { createTestApi, type Session, type TestApi } from '../../api/test/helpers.js';
import { actors, approved, type Actors } from '../../api/test/fixtures.js';
import { applyMediaResult } from '../src/jobs/media-results.js';
import { ingestEvents } from '../src/jobs/events-ingest.js';
import { runRetention } from '../src/jobs/retention.js';
import { processMedia } from '../src/media/process.js';
import { createLogger } from '@idb-stories/core';

const require = createRequire(import.meta.url);

describe('медиа: загрузка → карантин → воркер → результат', () => {
  let api: TestApi;
  let editor: Session;
  let tmp: string;

  beforeAll(async () => {
    api = await createTestApi();
    editor = await api.login('mock-editor');
    tmp = await mkdtemp(path.join(os.tmpdir(), 'pipeline-'));
  });
  afterAll(async () => {
    await api.close();
    await rm(tmp, { recursive: true, force: true });
  });

  async function uploadAndProcess(
    file: Buffer,
    contentType: string,
    kind: 'image' | 'video' = 'image',
  ) {
    const res = await api.admin(editor, 'POST', '/admin/v1/media/upload-url', {
      kind,
      purpose: 'slide',
      contentType,
      size: file.length,
      fileName: 'x',
    });
    expect(res.statusCode, res.body).toBe(201);
    const { asset, upload } = res.json<{
      asset: AdminMediaAsset;
      upload: { url: string; expiresAt: string };
    }>();
    expect(asset.status).toBe('uploaded');
    // presigned PUT: 10 минут, фиксированные тип и размер
    const signed = api.storage.presigned.at(-1)!;
    expect(signed).toMatchObject({
      bucket: api.config.s3.buckets.quarantine,
      contentType,
      contentLength: file.length,
    });
    expect(Date.parse(upload.expiresAt) - Date.now()).toBeLessThanOrEqual(600_000);

    // до загрузки complete не принимается
    expect(
      (await api.admin(editor, 'POST', `/admin/v1/media/${asset.id}/complete`)).statusCode,
    ).toBe(409);
    await api.storage.put(api.config.s3.buckets.quarantine, `uploads/${asset.id}`, file, {
      contentType,
    });
    const done = await api.admin(editor, 'POST', `/admin/v1/media/${asset.id}/complete`);
    expect(done.statusCode).toBe(202);
    expect(done.json<AdminMediaAsset>().status).toBe('processing');

    const [job] = await api.deps.queues.mediaProcess.getJobs(['waiting'], 0, 0);
    expect(job?.id).toBe(asset.id);
    await job!.remove();
    const result = await processMedia(
      {
        storage: api.storage,
        buckets: {
          quarantine: api.config.s3.buckets.quarantine,
          media: api.config.s3.buckets.media,
        },
        tmpDir: tmp,
        timeoutMs: 60_000,
        tools: {
          ffmpegPath: require('ffmpeg-static') as string,
          ffprobePath: (require('ffprobe-static') as { path: string }).path,
          threads: 1,
        },
        logger: createLogger({ name: 't', level: 'silent' }),
      },
      MediaProcessJob.parse(job!.data),
    );
    await applyMediaResult(api.db.app, api.deps.security, result);
    return (await api.admin(editor, 'GET', `/admin/v1/media/${asset.id}`)).json<AdminMediaAsset>();
  }

  it('годный JPEG → ready, превью только по подписанным URL на 15 минут', async () => {
    const jpeg = await sharp({
      create: { width: 1080, height: 1920, channels: 3, background: '#936' },
    })
      .jpeg()
      .toBuffer();
    const media = await uploadAndProcess(jpeg, 'image/jpeg');
    expect(media).toMatchObject({ status: 'ready', width: 1080, height: 1920, rejectReason: null });
    expect(media.previews.length).toBe(2);
    for (const p of media.previews) {
      expect(p.url).toContain('X-Amz-Signature');
      expect(p.url).toContain('X-Amz-Expires=900');
      expect(p.url).toContain(`/${api.config.s3.buckets.media}/`);
    }
    // до публикации в публичном bucket ничего нет (T5)
    expect(
      [...api.storage.objects.keys()].some((k) => k.startsWith(`${api.config.s3.buckets.public}/`)),
    ).toBe(false);
  });

  it('SVG под видом JPEG → rejected с причиной и событием безопасности', async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    );
    const media = await uploadAndProcess(svg, 'image/jpeg');
    expect(media.status).toBe('rejected');
    expect(media.rejectReason).toMatch(/SVG/);
    const ev = api.adapters.siem.events.find((e) => e.type === 'media.rejected');
    expect(ev?.details).toMatchObject({
      reason: expect.stringMatching(/SVG/),
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(ev?.actorId).toBe(editor.userId);
  });

  it('завершить чужую загрузку нельзя', async () => {
    const other = await api.login('mock-editor-2');
    const res = await api.admin(editor, 'POST', '/admin/v1/media/upload-url', {
      kind: 'image',
      purpose: 'cover',
      contentType: 'image/png',
      size: 10,
    });
    const { asset } = res.json<{ asset: AdminMediaAsset }>();
    const before = api.adapters.siem.events.filter((e) => e.type === 'access.denied').length;
    expect(
      (await api.admin(other, 'POST', `/admin/v1/media/${asset.id}/complete`)).statusCode,
    ).toBe(403);
    // любой 403 — событие безопасности, не только отказ по матрице прав
    expect(api.adapters.siem.events.filter((e) => e.type === 'access.denied').length).toBe(
      before + 1,
    );
  });

  it('лимиты размера проверяются уже при выдаче presigned URL', async () => {
    const res = await api.admin(editor, 'POST', '/admin/v1/media/upload-url', {
      kind: 'image',
      purpose: 'slide',
      contentType: 'image/jpeg',
      size: 16 * 1024 * 1024,
    });
    expect(res.statusCode).toBe(400);
    const svg = await api.admin(editor, 'POST', '/admin/v1/media/upload-url', {
      kind: 'image',
      purpose: 'slide',
      contentType: 'image/svg+xml',
      size: 100,
    });
    expect(svg.statusCode).toBe(400);
  });
});

describe('события → агрегаты → статистика', () => {
  let api: TestApi;
  let a: Actors;
  let analyst: Session;
  let group: AdminGroup;

  beforeAll(async () => {
    api = await createTestApi();
    a = await actors(api);
    analyst = await api.login('mock-analyst');
    group = await approved(api, a);
  });
  afterAll(async () => {
    await api.close();
  });

  const ev = (event: string, extra: Record<string, unknown> = {}) => ({
    event_id: randomUUID(),
    event,
    ts: new Date().toISOString(),
    session_id: 's1',
    platform: 'web',
    app_version: 'web',
    placement: 'home',
    ...extra,
  });

  it('POST /v1/events: валидные принимаются, невалидные считаются, дубли отсекаются', async () => {
    const slide = group.slides[0]!;
    const g = { group_id: group.id, group_version: 1 };
    const s = { ...g, slide_id: slide.id, slide_index: 0, slide_type: 'image' };
    const events = [
      ev('stories_feed_shown', { groups_count: 1, group_ids: [group.id] }),
      ev('stories_feed_shown', { groups_count: 1, group_ids: [group.id] }),
      ev('story_group_open', { ...g, source: 'tap' }),
      ev('story_slide_view', s),
      ev('story_slide_complete', s),
      ev('story_cta_click', { ...s, cta_type: 'category', cta_value: 'cat_123' }),
      ev('story_close', { ...g, reason: 'end', watched_slides: 1 }),
      ev('story_slide_view', { ...s, user_id: 'must-be-dropped' }),
      { event: 'story_slide_view', event_id: 'not-a-uuid' },
      ev('unknown_event'),
      ev('story_group_open', { group_id: randomUUID(), group_version: 1, source: 'tap' }),
    ];
    const res = await api.publicApp.inject({
      method: 'POST',
      url: '/v1/events',
      payload: { events },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ accepted: 9, rejected: 2 });

    const again = await api.publicApp.inject({
      method: 'POST',
      url: '/v1/events',
      payload: { events: events.slice(0, 3) },
    });
    expect(again.json()).toEqual({ accepted: 3, rejected: 0 });

    const jobs = await api.deps.queues.eventsIngest.getJobs(['waiting']);
    expect(jobs.length).toBe(1); // повтор целиком из дублей в очередь не попал
    const job = jobs[0]!.data as EventsIngestJob;
    expect(JSON.stringify(job)).not.toContain('must-be-dropped');

    const first = await ingestEvents(
      api.db.app,
      job.events,
      new Date(job.receivedAt),
      'Europe/Moscow',
    );
    expect(first.inserted).toBe(9);
    // повтор задачи (ретрай BullMQ) не удваивает агрегаты
    const retry = await ingestEvents(
      api.db.app,
      job.events,
      new Date(job.receivedAt),
      'Europe/Moscow',
    );
    expect(retry.inserted).toBe(0);

    const today = new Date().toISOString().slice(0, 10);
    const stats = await api.admin(
      analyst,
      'GET',
      `/admin/v1/stats/groups/${group.id}?from=2026-01-01&to=${today > '2026-12-31' ? today : '2026-12-31'}`,
    );
    expect(stats.statusCode, stats.body).toBe(200);
    const body = stats.json<GroupStats>();
    expect(body.totals).toMatchObject({
      impressions: 2,
      opens: 1,
      slideViews: 2,
      slideCompletes: 1,
      ctaClicks: 1,
      closes: 1,
      openRate: 0.5,
      ctr: 1,
    });
    expect(body.slides[0]).toMatchObject({
      slideId: group.slides[0]!.id,
      position: 0,
      views: 2,
      completes: 1,
      ctaClicks: 1,
      completionRate: 0.5,
    });
    // 2 × stories_feed_shown (без group_id) + событие о несуществующей группе
    expect(await api.db.owner.storyEventRaw.count({ where: { groupId: null } })).toBe(3);
  });

  it('sendBeacon: JSON в теле text/plain принимается', async () => {
    const res = await api.publicApp.inject({
      method: 'POST',
      url: '/v1/events',
      headers: { 'content-type': 'text/plain;charset=UTF-8' },
      payload: JSON.stringify({
        events: [ev('story_group_open', { group_id: group.id, group_version: 1, source: 'tap' })],
      }),
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ accepted: 1, rejected: 0 });
    const bad = await api.publicApp.inject({
      method: 'POST',
      url: '/v1/events',
      headers: { 'content-type': 'text/plain' },
      payload: 'not json',
    });
    expect(bad.statusCode).toBe(400);
  });

  it('слишком большой батч и тело больше 64 КБ отклоняются', async () => {
    const many = Array.from({ length: 51 }, () => ev('story_group_open'));
    expect(
      (await api.publicApp.inject({ method: 'POST', url: '/v1/events', payload: { events: many } }))
        .statusCode,
    ).toBe(400);
    const big = { events: [{ ...ev('x'), pad: 'a'.repeat(70 * 1024) }] };
    expect(
      (await api.publicApp.inject({ method: 'POST', url: '/v1/events', payload: big })).statusCode,
    ).toBe(413);
  });

  it('ретеншн удаляет сырые события старше 30 дней', async () => {
    const future = new Date(Date.now() + 31 * 86400_000);
    const res = await runRetention(api.db.app, { rawEventsDays: 30, statsDays: 730 }, future);
    expect(res.rawEvents).toBeGreaterThan(0);
    expect(await api.db.owner.storyEventRaw.count()).toBe(0);
    expect(await api.db.owner.statDaily.count()).toBeGreaterThan(0);
  });
});
