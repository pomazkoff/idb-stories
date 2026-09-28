import { dayInZone } from '@idb-stories/core';
import { Prisma, type PrismaClient } from '@idb-stories/db';
import type { Platform, StoryEvent } from '@idb-stories/schema';

type Counter =
  | 'impressions'
  | 'opens'
  | 'slide_views'
  | 'slide_completes'
  | 'cta_clicks'
  | 'product_clicks'
  | 'add_to_cart'
  | 'closes'
  | 'media_errors';
const COUNTERS: Counter[] = [
  'impressions',
  'opens',
  'slide_views',
  'slide_completes',
  'cta_clicks',
  'product_clicks',
  'add_to_cart',
  'closes',
  'media_errors',
];

interface AggKey {
  day: string;
  groupId: string;
  groupVersion: number;
  slideId: string;
  platform: Platform;
}

/** Доверяем времени клиента, только если оно в разумных пределах от времени приёма. */
function eventDate(e: StoryEvent, receivedAt: Date): Date {
  const ts = Date.parse(e.ts);
  const r = receivedAt.getTime();
  return Number.isFinite(ts) && ts >= r - 24 * 3600_000 && ts <= r + 5 * 60_000
    ? new Date(ts)
    : receivedAt;
}

function contributions(
  e: StoryEvent,
): { groupId: string; groupVersion: number; slideId: string; counter: Counter }[] {
  switch (e.event) {
    case 'stories_feed_shown':
      // версия кружка в событии не передаётся — показы копятся в строке с версией 0
      return (e.group_ids ?? []).map((groupId) => ({
        groupId,
        groupVersion: 0,
        slideId: '',
        counter: 'impressions',
      }));
    case 'story_group_open':
      return [
        { groupId: e.group_id, groupVersion: e.group_version, slideId: '', counter: 'opens' },
      ];
    case 'story_close':
      return [
        { groupId: e.group_id, groupVersion: e.group_version, slideId: '', counter: 'closes' },
      ];
    case 'story_slide_view':
      return [
        {
          groupId: e.group_id,
          groupVersion: e.group_version,
          slideId: e.slide_id,
          counter: 'slide_views',
        },
      ];
    case 'story_slide_complete':
      return [
        {
          groupId: e.group_id,
          groupVersion: e.group_version,
          slideId: e.slide_id,
          counter: 'slide_completes',
        },
      ];
    case 'story_cta_click':
      return [
        {
          groupId: e.group_id,
          groupVersion: e.group_version,
          slideId: e.slide_id,
          counter: 'cta_clicks',
        },
      ];
    case 'story_product_click':
      return [
        {
          groupId: e.group_id,
          groupVersion: e.group_version,
          slideId: e.slide_id,
          counter: 'product_clicks',
        },
      ];
    case 'story_add_to_cart':
      return [
        {
          groupId: e.group_id,
          groupVersion: e.group_version,
          slideId: e.slide_id,
          counter: 'add_to_cart',
        },
      ];
    case 'story_media_error':
      return [
        {
          groupId: e.group_id,
          groupVersion: e.group_version,
          slideId: e.slide_id,
          counter: 'media_errors',
        },
      ];
    default:
      return [];
  }
}

function groupIdOf(e: StoryEvent): string | null {
  return 'group_id' in e ? e.group_id : null;
}

/**
 * Сырые события (30 дней) и дневные агрегаты (2 года) в одной транзакции. Агрегируются только
 * реально вставленные события (event_id — первичный ключ), поэтому повтор задачи не удваивает
 * счётчики. События о несуществующих группах отбрасываются, чтобы флуд не засорял статистику (T8).
 */
export async function ingestEvents(
  prisma: PrismaClient,
  events: StoryEvent[],
  receivedAt: Date,
  timeZone: string,
): Promise<{ inserted: number; aggregated: number }> {
  const ids = new Set<string>();
  for (const e of events) {
    const gid = groupIdOf(e);
    if (gid) ids.add(gid);
    if (e.event === 'stories_feed_shown') for (const g of e.group_ids ?? []) ids.add(g);
  }
  const known = new Set(
    (
      await prisma.storyGroup.findMany({ where: { id: { in: [...ids] } }, select: { id: true } })
    ).map((g) => g.id),
  );

  return prisma.$transaction(async (tx) => {
    const created = await tx.storyEventRaw.createManyAndReturn({
      data: events.map((e) => ({
        eventId: e.event_id,
        event: e.event,
        ts: new Date(e.ts),
        receivedAt,
        platform: e.platform,
        placement: e.placement,
        appVersion: e.app_version,
        sessionId: e.session_id,
        groupId: groupIdOf(e) && known.has(groupIdOf(e)!) ? groupIdOf(e) : null,
        groupVersion: 'group_version' in e ? e.group_version : null,
        slideId: 'slide_id' in e ? e.slide_id : null,
        payload: e,
      })),
      skipDuplicates: true,
      select: { eventId: true },
    });
    const fresh = new Set(created.map((c) => c.eventId));

    const agg = new Map<string, AggKey & Record<Counter, number>>();
    for (const e of events) {
      if (!fresh.has(e.event_id)) continue;
      const day = dayInZone(eventDate(e, receivedAt), timeZone);
      for (const c of contributions(e)) {
        if (!known.has(c.groupId)) continue;
        const key = `${day}|${c.groupId}|${c.groupVersion}|${c.slideId}|${e.platform}`;
        let row = agg.get(key);
        if (!row) {
          row = {
            day,
            groupId: c.groupId,
            groupVersion: c.groupVersion,
            slideId: c.slideId,
            platform: e.platform,
          } as AggKey & Record<Counter, number>;
          for (const k of COUNTERS) row[k] = 0;
          agg.set(key, row);
        }
        row[c.counter] += 1;
      }
    }
    if (agg.size > 0) {
      const values = [...agg.values()].map(
        (r) =>
          Prisma.sql`(${r.day}::date, ${r.groupId}::uuid, ${r.groupVersion}, ${r.slideId}, ${r.platform}::"Platform", ${Prisma.join(
            COUNTERS.map((k) => r[k]),
          )})`,
      );
      await tx.$executeRaw`
        INSERT INTO stat_daily (day, group_id, group_version, slide_id, platform, ${Prisma.raw(COUNTERS.join(', '))})
        VALUES ${Prisma.join(values)}
        ON CONFLICT (day, group_id, group_version, slide_id, platform) DO UPDATE SET
        ${Prisma.raw(COUNTERS.map((k) => `${k} = stat_daily.${k} + EXCLUDED.${k}`).join(', '))}`;
    }
    return { inserted: fresh.size, aggregated: agg.size };
  });
}
