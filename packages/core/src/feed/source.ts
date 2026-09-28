import type { Placement, Platform, SlideType } from '@idb-stories/schema';

/**
 * Нормализованное представление рабочей копии. Сохраняется в снимке при согласовании
 * и используется для diff «рабочая копия ↔ последняя опубликованная версия» (раздел 6.2, экран 3).
 */
export interface GroupSourceView {
  title: string;
  placement: Placement;
  priority: number;
  startAt: string;
  endAt: string;
  platforms: Platform[];
  minAppVersion: { ios: string | null; android: string | null };
  segmentIds: string[];
  coverAssetId: string | null;
  slides: {
    id: string;
    position: number;
    type: SlideType;
    durationMs: number;
    mediaAssetId: string | null;
    elements: unknown;
    cta: unknown;
    productSkus: string[];
  }[];
}

export interface SourceGroupInput {
  title: string;
  placement: Placement;
  priority: number;
  startAt: Date;
  endAt: Date;
  platforms: readonly Platform[];
  minAppVersionIos: string | null;
  minAppVersionAndroid: string | null;
  segmentIds: readonly string[];
  coverAssetId: string | null;
  slides: readonly {
    id: string;
    position: number;
    type: SlideType;
    durationMs: number;
    mediaAssetId: string | null;
    elements: unknown;
    cta: unknown;
    productSkus: readonly string[];
  }[];
}

export function toSourceView(g: SourceGroupInput): GroupSourceView {
  return {
    title: g.title,
    placement: g.placement,
    priority: g.priority,
    startAt: g.startAt.toISOString(),
    endAt: g.endAt.toISOString(),
    platforms: [...g.platforms].sort(),
    minAppVersion: { ios: g.minAppVersionIos, android: g.minAppVersionAndroid },
    segmentIds: [...g.segmentIds].sort(),
    coverAssetId: g.coverAssetId,
    slides: [...g.slides]
      .sort((a, b) => a.position - b.position)
      .map((s, index) => ({
        id: s.id,
        position: index,
        type: s.type,
        durationMs: s.durationMs,
        mediaAssetId: s.mediaAssetId,
        elements: s.elements ?? [],
        cta: s.cta ?? null,
        productSkus: [...s.productSkus],
      })),
  };
}

export interface DiffChange {
  path: string;
  before: unknown;
  after: unknown;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function diffSourceViews(
  before: GroupSourceView | null,
  after: GroupSourceView,
): DiffChange[] {
  const changes: DiffChange[] = [];
  const b = before ?? null;
  const fields = [
    'title',
    'placement',
    'priority',
    'startAt',
    'endAt',
    'platforms',
    'minAppVersion',
    'segmentIds',
    'coverAssetId',
  ] as const;
  for (const f of fields) {
    const was = b ? b[f] : null;
    if (!same(was, after[f])) changes.push({ path: f, before: was, after: after[f] });
  }
  const oldSlides = new Map((b?.slides ?? []).map((s) => [s.id, s]));
  const newSlides = new Map(after.slides.map((s) => [s.id, s]));
  for (const s of after.slides) {
    const old = oldSlides.get(s.id);
    if (!old) {
      changes.push({ path: `slides[${s.id}]`, before: null, after: s });
      continue;
    }
    for (const key of [
      'position',
      'type',
      'durationMs',
      'mediaAssetId',
      'elements',
      'cta',
      'productSkus',
    ] as const) {
      if (!same(old[key], s[key]))
        changes.push({ path: `slides[${s.id}].${key}`, before: old[key], after: s[key] });
    }
  }
  for (const s of b?.slides ?? []) {
    if (!newSlides.has(s.id)) changes.push({ path: `slides[${s.id}]`, before: s, after: null });
  }
  return changes;
}
