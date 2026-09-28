import type { FeedResponse } from '@idb-stories/schema';
import { h } from './dom.js';
import { groupIndexForFeedIndex, SUPPORTED_SCHEMA_VERSION } from './model.js';
import { createRuntime } from './runtime.js';
import type { PreviewHandle, PreviewOptions } from './types.js';
import { Viewer } from './viewer.js';

/**
 * Предпросмотр для админки: плеер внутри контейнера (рамка телефона), без оверлея и без
 * блокировки прокрутки страницы. «Просмотрено» не записывается.
 */
export function mountPreview(
  container: HTMLElement,
  feed: FeedResponse,
  options: PreviewOptions,
): PreviewHandle {
  const runtime = createRuntime(options);
  let viewer: Viewer | null = null;
  let message: HTMLElement | null = null;
  let destroyed = false;

  function showMessage(text: string): void {
    viewer?.dispose();
    viewer = null;
    message ??= h('div', 'idbs-preview-empty');
    message.textContent = text;
    container.replaceChildren(message);
  }

  function apply(next: FeedResponse): void {
    const result = runtime.normalize(next);
    if (!result.ok) {
      showMessage(
        result.reason === 'unsupported_version'
          ? `Версия формата ленты не поддерживается (поддерживается ${SUPPORTED_SCHEMA_VERSION})`
          : 'Некорректные данные для предпросмотра',
      );
      return;
    }
    if (result.groups.length === 0) {
      showMessage('Нет слайдов для предпросмотра');
      return;
    }
    runtime.reportForbidden(result.forbidden);
    if (message) {
      message.remove();
      message = null;
    }
    if (viewer) {
      viewer.setGroups(result.groups);
      return;
    }
    viewer = new Viewer({
      runtime,
      groups: result.groups,
      mode: 'inline',
      parent: container,
      autoplay: options.autoplay ?? true,
      markViewed: false,
    });
    const start = groupIndexForFeedIndex(result.groups, options.startGroup ?? 0);
    viewer.open(start < 0 ? 0 : start, 'tap');
  }

  apply(feed);

  return {
    update(next) {
      if (!destroyed) apply(next);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      viewer?.dispose();
      viewer = null;
      message?.remove();
      message = null;
    },
  };
}
