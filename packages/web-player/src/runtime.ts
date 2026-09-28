import type { StoryEvent } from '@idb-stories/schema';
import type { CtaAllowlist } from '@idb-stories/schema/allowlist';
import { createEmitter, defaultSessionId, type Emit } from './events.js';
import { normalizeFeed, type ForbiddenSlide, type NormalizeResult } from './model.js';
import type { CatalogProduct, CtaAction, Placement, PlayerOptions } from './types.js';
import { ViewedStore } from './viewed.js';

/** Разобранные опции плеера, общие для ленты, оверлея и предпросмотра. */
export interface Runtime {
  placement: Placement;
  mediaOrigins: string[];
  ctaAllowlist: CtaAllowlist;
  getProducts: ((skus: string[]) => Promise<CatalogProduct[]>) | null;
  onCta: ((cta: CtaAction) => void) | null;
  onAddToCart: ((sku: string, storyRef: string) => void | Promise<void>) | null;
  now: () => number;
  emit: Emit;
  viewed: ViewedStore;
  normalize(raw: unknown): NormalizeResult;
  reportForbidden(list: readonly ForbiddenSlide[]): void;
}

/** `https://cdn.example/` → `https://cdn.example`; мусор отбрасывается. */
function normalizeOrigins(origins: readonly string[] | undefined): string[] {
  const out = new Set<string>();
  for (const o of origins ?? []) {
    try {
      const origin = new URL(o).origin;
      if (origin !== 'null') out.add(origin);
    } catch {
      // некорректный origin в конфигурации игнорируется
    }
  }
  return [...out];
}

export function createRuntime(
  options: PlayerOptions,
  extraSinks: ((event: StoryEvent) => void)[] = [],
): Runtime {
  const now = options.now ?? (() => Date.now());
  const sinks = [...extraSinks];
  if (options.onEvent) sinks.push(options.onEvent);
  const emit = createEmitter({
    placement: options.placement,
    sessionId: options.sessionId ?? defaultSessionId(),
    appVersion: options.appVersion ?? 'web',
    now,
    sinks,
  });
  const mediaOrigins = normalizeOrigins(options.mediaOrigins);
  const getProducts = options.getProducts ?? null;
  const reported = new Set<string>();

  return {
    placement: options.placement,
    mediaOrigins,
    ctaAllowlist: options.ctaAllowlist ?? { deeplinkSchemes: [], urlDomains: [] },
    getProducts,
    onCta: options.onCta ?? null,
    onAddToCart: options.onAddToCart ?? null,
    now,
    emit,
    viewed: new ViewedStore(options.storage),
    normalize: (raw) => normalizeFeed(raw, { mediaOrigins, productsEnabled: getProducts !== null }),
    reportForbidden(list) {
      for (const f of list) {
        const key = `${f.groupId}:${f.groupVersion}:${f.slideId}`;
        if (reported.has(key)) continue;
        reported.add(key);
        emit('story_media_error', {
          group_id: f.groupId,
          group_version: f.groupVersion,
          slide_id: f.slideId,
          slide_index: f.slideIndex,
          slide_type: f.slideType,
          error_code: 'forbidden_origin',
        });
      }
    },
  };
}
