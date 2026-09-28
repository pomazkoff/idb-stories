import type { FeedResponse } from '@idb-stories/schema';
import { groupIndexForFeedIndex } from './model.js';
import { createRuntime } from './runtime.js';
import type { ViewerHandle, ViewerOptions } from './types.js';
import { Viewer } from './viewer.js';

export { mountFeed } from './feed.js';
export { mountPreview } from './preview.js';
export { SUPPORTED_SCHEMA_VERSION } from './model.js';
export type {
  CatalogProduct,
  CtaAction,
  FeedHandle,
  FeedOptions,
  Placement,
  PlayerOptions,
  PreviewHandle,
  PreviewOptions,
  ViewerHandle,
  ViewerOptions,
} from './types.js';
export type { CtaAllowlist } from '@idb-stories/schema/allowlist';

/**
 * Открывает полноэкранный плеер на группе `groupIndex` (индекс в `feed.groups`).
 * Если показывать нечего — ничего не делает и возвращает пустой close().
 */
export function openViewer(
  feed: FeedResponse,
  groupIndex: number,
  options: ViewerOptions,
): ViewerHandle {
  const runtime = createRuntime(options);
  const result = runtime.normalize(feed);
  if (!result.ok || result.groups.length === 0) return { close() {} };
  runtime.reportForbidden(result.forbidden);
  const start = groupIndexForFeedIndex(result.groups, groupIndex);
  if (start < 0) return { close() {} };
  const viewer = new Viewer({
    runtime,
    groups: result.groups,
    mode: 'overlay',
    parent: options.container ?? document.body,
    autoplay: true,
    markViewed: true,
  });
  viewer.open(start, 'tap');
  return { close: () => viewer.close('button') };
}
