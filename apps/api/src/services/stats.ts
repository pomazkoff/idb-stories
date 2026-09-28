import type { FeedGroup, GroupStats } from '@idb-stories/schema';
import type { AppDeps } from '../context.js';
import { notFound } from '../http/errors.js';

const ratio = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 10_000) / 10_000 : null);

const zero = () => ({
  impressions: 0,
  opens: 0,
  slideViews: 0,
  slideCompletes: 0,
  ctaClicks: 0,
  productClicks: 0,
  addToCart: 0,
  closes: 0,
  mediaErrors: 0,
});
type Counters = ReturnType<typeof zero>;
const KEYS = Object.keys(zero()) as (keyof Counters)[];

/**
 * Статистика группы по дневным агрегатам (раздел 6.2, экран 4): показы кружка, открытия,
 * воронка досмотра по слайдам, CTR на CTA, добавления в корзину из слайдов.
 * Атрибуция заказов по story_ref считается в аналитике ИДБ (открытый вопрос №4).
 */
export async function groupStats(
  deps: AppDeps,
  groupId: string,
  from: string,
  to: string,
): Promise<GroupStats> {
  const group = await deps.prisma.storyGroup.findUnique({
    where: { id: groupId },
    include: { slides: { orderBy: { position: 'asc' } } },
  });
  if (!group) throw notFound('Группа не найдена');
  const rows = await deps.prisma.statDaily.findMany({
    where: {
      groupId,
      day: { gte: new Date(`${from}T00:00:00Z`), lte: new Date(`${to}T00:00:00Z`) },
    },
  });

  const totals = zero();
  const daily = new Map<string, Counters>();
  const slides = new Map<string, Counters>();
  for (const r of rows) {
    const date = r.day.toISOString().slice(0, 10);
    const d = daily.get(date) ?? zero();
    const s = r.slideId ? (slides.get(r.slideId) ?? zero()) : null;
    for (const k of KEYS) {
      totals[k] += r[k];
      d[k] += r[k];
      if (s) s[k] += r[k];
    }
    daily.set(date, d);
    if (s) slides.set(r.slideId, s);
  }

  // Порядок и типы слайдов: текущая рабочая копия, затем слайды из прошлых версий.
  const meta = new Map<string, { position: number | null; type: string | null }>();
  group.slides.forEach((s, i) => meta.set(s.id, { position: i, type: s.type }));
  const latest = await deps.prisma.publishedSnapshot.findFirst({
    where: { groupId, publishedAt: { not: null } },
    orderBy: { version: 'desc' },
    select: { payload: true },
  });
  (latest?.payload as FeedGroup | undefined)?.slides.forEach((s) => {
    if (!meta.has(s.id)) meta.set(s.id, { position: null, type: s.type });
  });

  const slideIds = [...new Set([...meta.keys(), ...slides.keys()])].filter(
    (id) => slides.has(id) || meta.get(id)?.position !== null,
  );
  return {
    groupId,
    from,
    to,
    totals: {
      ...totals,
      openRate: ratio(totals.opens, totals.impressions),
      ctr: ratio(totals.ctaClicks, totals.opens),
    },
    slides: slideIds
      .map((id) => {
        const c = slides.get(id) ?? zero();
        const m = meta.get(id) ?? { position: null, type: null };
        return {
          slideId: id,
          position: m.position,
          type: m.type,
          views: c.slideViews,
          completes: c.slideCompletes,
          ctaClicks: c.ctaClicks,
          productClicks: c.productClicks,
          addToCart: c.addToCart,
          mediaErrors: c.mediaErrors,
          reach: ratio(c.slideViews, totals.opens),
          completionRate: ratio(c.slideCompletes, c.slideViews),
          ctr: ratio(c.ctaClicks, c.slideViews),
        };
      })
      .sort((a, b) => (a.position ?? 999) - (b.position ?? 999)),
    daily: [...daily.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, c]) => ({ date, ...c })),
  };
}
