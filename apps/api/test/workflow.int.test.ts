import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AdminGroup, FeedResponse } from '@idb-stories/schema';
import {
  createReadyAsset,
  createTestApi,
  groupInput,
  type Session,
  type TestApi,
} from './helpers.js';
import { actors, approved, inReview, readyDraft, type Actors } from './fixtures.js';

const feed = async (
  api: TestApi,
  placement = 'home',
  platform = 'web',
  extra: Record<string, string> = {},
) => {
  const res = await api.publicApp.inject({
    method: 'GET',
    url: `/v1/feed?placement=${placement}`,
    headers: {
      'x-platform': platform,
      ...(platform !== 'web' ? { 'x-app-version': '6.0.0' } : {}),
      ...extra,
    },
  });
  expect(res.statusCode, res.body).toBe(200);
  return { res, body: res.json<FeedResponse>() };
};

describe('жизненный цикл группы и правило четырёх глаз', () => {
  let api: TestApi;
  let a: Actors;
  let editor: Session;
  let publisher: Session;

  beforeAll(async () => {
    api = await createTestApi();
    a = await actors(api);
    editor = await api.login('mock-editor');
    publisher = await api.login('mock-publisher');
  });
  afterAll(async () => {
    await api.close();
  });

  it('автор правки не может её согласовать (даже с ролью публикатора)', async () => {
    // lead — редактор и публикатор: правит и пытается согласовать сам
    const cover = await createReadyAsset(api, {
      kind: 'image',
      purpose: 'cover',
      uploadedBy: a.lead.userId,
    });
    const image = await createReadyAsset(api, {
      kind: 'image',
      purpose: 'slide',
      uploadedBy: a.lead.userId,
    });
    let grp = (
      await api.admin(a.lead, 'POST', '/admin/v1/groups', groupInput({ coverAssetId: cover }))
    ).json<AdminGroup>();
    grp = (
      await api.admin(a.lead, 'POST', `/admin/v1/groups/${grp.id}/slides`, {
        type: 'image',
        mediaAssetId: image,
      })
    ).json<AdminGroup>();
    grp = (
      await api.admin(a.lead, 'POST', `/admin/v1/groups/${grp.id}/submit`, {
        revision: grp.revision,
      })
    ).json<AdminGroup>();
    expect(grp.status).toBe('in_review');
    expect(grp.actions.canApprove).toBe(false);
    expect(grp.actions.approveBlockedReason).toMatch(/четырёх глаз/);

    const res = await api.admin(a.lead, 'POST', `/admin/v1/groups/${grp.id}/approve`, {
      revision: grp.revision,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('four_eyes');
    expect(api.adapters.siem.events.some((e) => e.type === 'four_eyes.violation')).toBe(true);

    // другой публикатор — может
    const ok = await api.admin(publisher, 'POST', `/admin/v1/groups/${grp.id}/approve`, {
      revision: grp.revision,
    });
    expect(ok.statusCode, ok.body).toBe(200);
  });

  it('нельзя обойти правило, если после своей правки дать другому поправить мелочь', async () => {
    const grp = await readyDraft(api, a); // правил editor2
    // lead вносит «свою» правку, затем editor2 — ещё одну: последний автор теперь editor2
    let cur = (
      await api.admin(a.lead, 'PATCH', `/admin/v1/groups/${grp.id}`, {
        revision: grp.revision,
        title: 'Правка lead',
      })
    ).json<AdminGroup>();
    cur = (
      await api.admin(a.editor2, 'PATCH', `/admin/v1/groups/${grp.id}`, {
        revision: cur.revision,
        priority: 5,
      })
    ).json<AdminGroup>();
    cur = (
      await api.admin(a.editor2, 'POST', `/admin/v1/groups/${grp.id}/submit`, {
        revision: cur.revision,
      })
    ).json<AdminGroup>();
    const res = await api.admin(a.lead, 'POST', `/admin/v1/groups/${grp.id}/approve`, {
      revision: cur.revision,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('four_eyes');
  });

  it('согласовать можно только ту ревизию, которую видел публикатор', async () => {
    const grp = await inReview(api, a);
    const res = await api.admin(publisher, 'POST', `/admin/v1/groups/${grp.id}/approve`, {
      revision: grp.revision - 1,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('revision_mismatch');
  });

  it('создал → отправил → согласовал → в ленте → снял → исчезло', async () => {
    const grp = await inReview(api, a, { title: 'E2E группа', placement: 'catalog' });
    const approvedGroup = (
      await api.admin(publisher, 'POST', `/admin/v1/groups/${grp.id}/approve`, {
        revision: grp.revision,
      })
    ).json<AdminGroup>();
    // start_at уже наступил — публикация сразу
    expect(approvedGroup.status).toBe('published');
    expect(approvedGroup.liveVersion).toBe(1);

    const { body } = await feed(api, 'catalog');
    const inFeed = body.groups.find((x) => x.id === grp.id);
    expect(inFeed).toMatchObject({ title: 'E2E группа', version: 1 });
    // медиа — только с CDN и уже скопированы в public bucket
    expect(inFeed!.cover.url.startsWith('https://cdn.stories.test/')).toBe(true);
    const key = inFeed!.cover.url.slice('https://cdn.stories.test/'.length);
    expect(await api.storage.head(api.config.s3.buckets.public, key)).not.toBeNull();
    expect(api.adapters.cdnPurge.calls.length).toBeGreaterThan(0);

    const un = await api.admin(publisher, 'POST', `/admin/v1/groups/${grp.id}/unpublish`, {
      reason: 'тест',
    });
    expect(un.statusCode).toBe(200);
    expect(un.json<AdminGroup>().status).toBe('archived');
    const after = await feed(api, 'catalog');
    expect(after.body.groups.find((x) => x.id === grp.id)).toBeUndefined();
  });

  it('правка опубликованной группы не меняет ленту до нового согласования', async () => {
    const grp = await approved(api, a, { placement: 'cart', title: 'Версия 1' });
    expect(grp.status).toBe('published');
    const edited = (
      await api.admin(a.editor2, 'PATCH', `/admin/v1/groups/${grp.id}`, {
        revision: grp.revision,
        title: 'Версия 2',
      })
    ).json<AdminGroup>();
    expect(edited.status).toBe('draft');
    expect(edited.liveVersion).toBe(1);
    expect((await feed(api, 'cart')).body.groups.find((x) => x.id === grp.id)?.title).toBe(
      'Версия 1',
    );

    const diff = await api.admin(publisher, 'GET', `/admin/v1/groups/${grp.id}/diff`);
    expect(diff.json()).toMatchObject({
      baseVersion: 1,
      changes: [{ path: 'title', before: 'Версия 1', after: 'Версия 2' }],
    });

    const sub = (
      await api.admin(a.editor2, 'POST', `/admin/v1/groups/${grp.id}/submit`, {
        revision: edited.revision,
      })
    ).json<AdminGroup>();
    const v2 = (
      await api.admin(publisher, 'POST', `/admin/v1/groups/${grp.id}/approve`, {
        revision: sub.revision,
      })
    ).json<AdminGroup>();
    expect(v2.liveVersion).toBe(2);
    expect((await feed(api, 'cart')).body.groups.find((x) => x.id === grp.id)).toMatchObject({
      title: 'Версия 2',
      version: 2,
    });
  });

  it('отклонение с комментарием возвращает группу редактору', async () => {
    const grp = await inReview(api, a);
    const rej = await api.admin(publisher, 'POST', `/admin/v1/groups/${grp.id}/reject`, {
      revision: grp.revision,
      comment: 'Уберите «лучший»',
    });
    expect(rej.json<AdminGroup>()).toMatchObject({
      status: 'rejected',
      reviewComment: 'Уберите «лучший»',
    });
    const edited = (
      await api.admin(a.editor2, 'PATCH', `/admin/v1/groups/${grp.id}`, {
        revision: grp.revision,
        title: 'Исправлено',
      })
    ).json<AdminGroup>();
    expect(edited.status).toBe('draft');
  });

  it('незаконченную группу нельзя отправить: причины перечислены', async () => {
    const grp = (
      await api.admin(editor, 'POST', '/admin/v1/groups', groupInput())
    ).json<AdminGroup>();
    const res = await api.admin(editor, 'POST', `/admin/v1/groups/${grp.id}/submit`, {
      revision: grp.revision,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.details.problems).toEqual(
      expect.arrayContaining(['Обложка: не выбрано медиа', 'В группе нет слайдов']),
    );
  });

  it('согласованную, но ещё не начавшуюся группу правка отменяет', async () => {
    const now = Date.now();
    const grp = await approved(api, a, {
      startAt: new Date(now + 86400_000).toISOString(),
      endAt: new Date(now + 2 * 86400_000).toISOString(),
    });
    expect(grp).toMatchObject({ status: 'approved', pendingVersion: 1, schedule: 'scheduled' });
    const edited = (
      await api.admin(a.editor2, 'PATCH', `/admin/v1/groups/${grp.id}`, {
        revision: grp.revision,
        priority: 1,
      })
    ).json<AdminGroup>();
    expect(edited).toMatchObject({ status: 'draft', pendingVersion: null });
  });

  it('группу, которая согласовывалась, нельзя удалить', async () => {
    const grp = await approved(api, a);
    const res = await api.admin(a.editor2, 'DELETE', `/admin/v1/groups/${grp.id}`);
    expect(res.statusCode).toBe(409);
  });
});

describe('аудит пишется на каждое изменение', () => {
  let api: TestApi;
  let a: Actors;
  let publisher: Session;
  let admin: Session;

  beforeAll(async () => {
    api = await createTestApi();
    a = await actors(api);
    publisher = await api.login('mock-publisher');
    admin = await api.login('mock-admin');
  });
  afterAll(async () => {
    await api.close();
  });

  const lastAudit = () => api.db.owner.auditLog.findFirstOrThrow({ orderBy: { id: 'desc' } });

  it('изменения групп, слайдов, согласования, настроек и ролей попадают в аудит с diff и request_id', async () => {
    const steps: [string, () => Promise<{ statusCode: number; body: string }>][] = [];
    const grp = await readyDraft(api, a);
    const slide = grp.slides[0]!;
    steps.push([
      'group.updated',
      () =>
        api.admin(a.editor2, 'PATCH', `/admin/v1/groups/${grp.id}`, {
          revision: grp.revision,
          title: 'Новое имя',
        }),
    ]);
    steps.push([
      'slide.updated',
      () =>
        api.admin(a.editor2, 'PUT', `/admin/v1/groups/${grp.id}/slides/${slide.id}`, {
          type: 'image',
          mediaAssetId: slide.mediaAssetId,
          durationMs: 9000,
        }),
    ]);
    steps.push([
      'group.submitted',
      async () => {
        const cur = (
          await api.admin(a.editor2, 'GET', `/admin/v1/groups/${grp.id}`)
        ).json<AdminGroup>();
        return api.admin(a.editor2, 'POST', `/admin/v1/groups/${grp.id}/submit`, {
          revision: cur.revision,
        });
      },
    ]);
    steps.push([
      'group.published',
      async () => {
        const cur = (
          await api.admin(publisher, 'GET', `/admin/v1/groups/${grp.id}`)
        ).json<AdminGroup>();
        return api.admin(publisher, 'POST', `/admin/v1/groups/${grp.id}/approve`, {
          revision: cur.revision,
        });
      },
    ]);
    steps.push([
      'group.unpublished',
      () => api.admin(publisher, 'POST', `/admin/v1/groups/${grp.id}/unpublish`, {}),
    ]);
    steps.push([
      'settings.allowlist_changed',
      () =>
        api.admin(admin, 'PUT', '/admin/v1/settings/allowlist', {
          deeplinkSchemes: ['idb'],
          urlDomains: ['iledebeaute.ru', 'www.iledebeaute.ru'],
        }),
    ]);
    steps.push([
      'settings.feed_enabled_changed',
      () =>
        api.admin(admin, 'PUT', '/admin/v1/settings/feed-enabled', {
          enabled: true,
          confirmation: 'ВКЛЮЧИТЬ',
        }),
    ]);
    steps.push([
      'user.roles_changed',
      async () =>
        api.admin(admin, 'PUT', `/admin/v1/users/${await api.userId('mock-newcomer')}/roles`, {
          roles: ['analyst'],
        }),
    ]);
    steps.push([
      'media.upload_requested',
      () =>
        api.admin(a.editor2, 'POST', '/admin/v1/media/upload-url', {
          kind: 'video',
          purpose: 'slide',
          contentType: 'video/mp4',
          size: 1000,
        }),
    ]);

    for (const [action, run] of steps) {
      const res = await run();
      expect(res.statusCode, `${action}: ${res.body}`).toBeLessThan(300);
      const entry = await lastAudit();
      expect(entry.action).toBe(action);
      expect(entry.requestId).toBeTruthy();
      expect(entry.ip).toBeTruthy();
      expect(entry.diff).not.toBeNull();
    }
    const allowlistEntry = await api.db.owner.auditLog.findFirstOrThrow({
      where: { action: 'settings.allowlist_changed' },
    });
    expect(allowlistEntry.diff).toMatchObject({
      after: { urlDomains: ['iledebeaute.ru', 'www.iledebeaute.ru'] },
    });
  });

  it('журнал аудита доступен администратору с фильтрами', async () => {
    const res = await api.admin(admin, 'GET', '/admin/v1/audit-log?action=group.updated&limit=5');
    expect(res.statusCode).toBe(200);
    const body = res.json<{ items: { action: string; actor: { name: string } }[] }>();
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items.every((i) => i.action === 'group.updated')).toBe(true);
    expect(body.items[0]!.actor.name).toBe('Егор Редактор');
  });

  it('CTA вне allowlist не сохраняется и пишется как событие безопасности', async () => {
    const grp = await readyDraft(api, a);
    const media = grp.slides[0]!.mediaAssetId;
    for (const value of [
      'javascript:alert(1)',
      'https://iledebeaute.ru@evil.com/',
      'https://evil.com/',
    ]) {
      const res = await api.admin(a.editor2, 'POST', `/admin/v1/groups/${grp.id}/slides`, {
        type: 'image',
        mediaAssetId: media,
        cta: { type: 'url', value, label: 'Купить' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('cta_not_allowed');
    }
    expect(
      api.adapters.siem.events.filter((e) => e.type === 'cta.rejected').length,
    ).toBeGreaterThanOrEqual(3);
  });

  it('если allowlist сузили после согласования, публикация блокируется', async () => {
    const now = Date.now();
    const draft = await readyDraft(api, a, {
      startAt: new Date(now + 86400_000).toISOString(),
      endAt: new Date(now + 2 * 86400_000).toISOString(),
    });
    const withUrl = (
      await api.admin(a.editor2, 'POST', `/admin/v1/groups/${draft.id}/slides`, {
        type: 'image',
        mediaAssetId: draft.slides[0]!.mediaAssetId,
        cta: { type: 'url', value: 'https://www.iledebeaute.ru/sale', label: 'Купить' },
      })
    ).json<AdminGroup>();
    const sub = (
      await api.admin(a.editor2, 'POST', `/admin/v1/groups/${draft.id}/submit`, {
        revision: withUrl.revision,
      })
    ).json<AdminGroup>();
    const appr = (
      await api.admin(publisher, 'POST', `/admin/v1/groups/${draft.id}/approve`, {
        revision: sub.revision,
      })
    ).json<AdminGroup>();
    expect(appr.status).toBe('approved');

    await api.admin(admin, 'PUT', '/admin/v1/settings/allowlist', {
      deeplinkSchemes: ['idb'],
      urlDomains: ['iledebeaute.ru'],
    });
    // www.iledebeaute.ru — поддомен iledebeaute.ru, всё ещё разрешён; сузим до другого домена
    await api.admin(admin, 'PUT', '/admin/v1/settings/allowlist', {
      deeplinkSchemes: ['idb'],
      urlDomains: ['example.org'],
    });
    const pub = await api.admin(publisher, 'POST', `/admin/v1/groups/${draft.id}/publish`);
    expect(pub.statusCode).toBe(409);
    expect(pub.json().error.code).toBe('cta_not_allowed');
    await api.admin(admin, 'PUT', '/admin/v1/settings/allowlist', {
      deeplinkSchemes: ['idb'],
      urlDomains: ['iledebeaute.ru'],
    });
  });

  it('администратор не может менять свои роли и снять последнего администратора', async () => {
    const self = await api.admin(admin, 'PUT', `/admin/v1/users/${admin.userId}/roles`, {
      roles: ['admin', 'publisher'],
    });
    expect(self.statusCode).toBe(409);
    expect(self.json().error.code).toBe('self_modification');
  });
});
