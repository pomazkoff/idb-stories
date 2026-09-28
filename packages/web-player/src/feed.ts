import { h } from './dom.js';
import type { Group } from './model.js';
import { createRuntime, type Runtime } from './runtime.js';
import { EventTransport } from './transport.js';
import type { FeedHandle, FeedOptions } from './types.js';
import { Viewer } from './viewer.js';

const FETCH_TIMEOUT_MS = 10_000;

interface CacheEntry {
  groups: Group[];
  expiresAt: number;
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

/**
 * Лента кружков + полноэкранный плеер. Любая проблема с ответом (сеть, не 200, не JSON,
 * пустой список, schema_version выше поддерживаемой) — блок молча скрывается (раздел 8).
 */
export function mountFeed(container: HTMLElement, options: FeedOptions): FeedHandle {
  const apiBase = trimSlash(options.apiBaseUrl);
  const endpoint =
    options.eventsEndpoint === undefined ? `${apiBase}/v1/events` : options.eventsEndpoint;
  let transport: EventTransport | null = null;
  try {
    transport = endpoint ? new EventTransport(endpoint) : null;
  } catch {
    transport = null;
  }
  const runtime: Runtime = createRuntime(options, transport ? [(e) => transport?.push(e)] : []);

  const initialHidden = container.hidden;
  let cache: CacheEntry | null = null;
  let inflight: Promise<void> | null = null;
  let abort: AbortController | null = null;
  let destroyed = false;
  let viewer: Viewer | null = null;
  let observer: IntersectionObserver | null = null;
  let row: HTMLUListElement | null = null;
  let items = new Map<string, HTMLLIElement>();
  let current: Group[] = [];

  function hide(): void {
    observer?.disconnect();
    observer = null;
    row = null;
    items = new Map();
    current = [];
    container.replaceChildren();
    container.hidden = true;
  }

  /** Непросмотренные — в порядке ленты, просмотренные — в конце (раздел 8). */
  function ordered(groups: Group[]): Group[] {
    const viewed = (g: Group) => runtime.viewed.isViewed(g.id, g.version);
    return [...groups.filter((g) => !viewed(g)), ...groups.filter(viewed)];
  }

  function circle(group: Group): HTMLLIElement {
    const li = h('li', 'idbs-feed__item');
    const btn = h('button', 'idbs-circle');
    btn.type = 'button';
    btn.dataset.groupId = group.id;
    const ring = h('span', 'idbs-circle__ring');
    const img = h('img', 'idbs-circle__img');
    img.alt = '';
    img.decoding = 'async';
    img.draggable = false;
    if (group.coverUrl) img.src = group.coverUrl;
    else img.hidden = true;
    ring.appendChild(img);
    btn.append(ring, h('span', 'idbs-circle__title', group.title));
    btn.addEventListener('click', () => open(group.id));
    li.appendChild(btn);
    return li;
  }

  function applyViewed(): void {
    if (!row) return;
    const list = ordered(current);
    for (const g of list) {
      const li = items.get(g.id);
      if (!li) continue;
      const viewed = runtime.viewed.isViewed(g.id, g.version);
      const btn = li.firstElementChild;
      if (btn instanceof HTMLElement) {
        btn.classList.toggle('idbs-circle--viewed', viewed);
        const name = g.title.trim() || 'История';
        btn.setAttribute('aria-label', viewed ? `${name}, просмотрено` : name);
      }
      row.appendChild(li); // переставляем существующие узлы: фокус и картинки сохраняются
    }
  }

  function render(groups: Group[], fresh: boolean): void {
    if (groups.length === 0) {
      hide();
      return;
    }
    current = groups;
    if (fresh || !row) {
      observer?.disconnect();
      observer = null;
      row = h('ul', 'idbs-feed');
      row.setAttribute('aria-label', 'Истории');
      items = new Map(groups.map((g) => [g.id, circle(g)]));
      container.replaceChildren(row);
      applyViewed();
      container.hidden = false;
      watchShown(row, groups);
    } else {
      applyViewed();
    }
  }

  /** stories_feed_shown — когда ряд попал во вьюпорт (один раз на каждый ответ сервера). */
  function watchShown(target: HTMLUListElement, groups: Group[]): void {
    const emit = () => {
      if (destroyed || row !== target) return;
      runtime.emit('stories_feed_shown', {
        groups_count: groups.length,
        group_ids: visibleGroupIds(target),
      });
    };
    if (typeof IntersectionObserver !== 'function') {
      emit();
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting && e.intersectionRatio >= 0.5)) return;
        io.disconnect();
        if (observer === io) observer = null;
        emit();
      },
      { threshold: 0.5 },
    );
    observer = io;
    io.observe(target);
  }

  /** Кружки, видимые в ряду (ряд прокручивается по горизонтали). Без раскладки — все. */
  function visibleGroupIds(target: HTMLUListElement): string[] {
    const rowRect = target.getBoundingClientRect();
    const ids: string[] = [];
    for (const btn of target.querySelectorAll<HTMLElement>('.idbs-circle')) {
      const id = btn.dataset.groupId;
      if (!id) continue;
      const r = btn.getBoundingClientRect();
      const noLayout = rowRect.width === 0 || r.width === 0;
      const visible =
        r.right > rowRect.left &&
        r.left < rowRect.right &&
        r.left < window.innerWidth &&
        r.right > 0;
      if (noLayout || visible) ids.push(id);
    }
    return ids;
  }

  function open(groupId: string): void {
    if (destroyed || viewer) return;
    const groups = ordered(current);
    const index = groups.findIndex((g) => g.id === groupId);
    if (index < 0) return;
    const v = new Viewer({
      runtime,
      groups,
      mode: 'overlay',
      parent: document.body,
      autoplay: true,
      markViewed: true,
      onClose: () => {
        viewer = null;
        applyViewed();
      },
    });
    viewer = v;
    v.open(index, 'tap');
  }

  async function load(): Promise<void> {
    abort?.abort();
    const controller = new AbortController();
    abort = controller;
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const headers: Record<string, string> = { Accept: 'application/json', 'X-Platform': 'web' };
      // Ошибка получения токена — не повод скрывать ленту: запрашиваем анонимную.
      const getToken = options.getAuthToken;
      const token = getToken
        ? await Promise.resolve()
            .then(() => getToken())
            .catch(() => null)
        : null;
      if (typeof token === 'string' && token.length > 0) headers.Authorization = `Bearer ${token}`;
      const url = `${apiBase}/v1/feed?placement=${encodeURIComponent(options.placement)}`;
      const res = await fetch(url, {
        method: 'GET',
        headers,
        credentials: 'omit',
        signal: controller.signal,
      });
      if (destroyed || abort !== controller) return;
      if (res.status !== 200) {
        hide();
        return;
      }
      const data: unknown = await res.json();
      if (destroyed || abort !== controller) return;
      const result = runtime.normalize(data);
      if (!result.ok || result.groups.length === 0) {
        hide();
        return;
      }
      runtime.reportForbidden(result.forbidden);
      cache = { groups: result.groups, expiresAt: runtime.now() + result.ttlSec * 1000 };
      render(result.groups, true);
    } catch {
      // Сеть, таймаут, невалидный JSON — блок скрывается, приложение не падает.
      if (!destroyed && abort === controller) hide();
    } finally {
      clearTimeout(timeout);
      if (abort === controller) abort = null;
    }
  }

  function refresh(): Promise<void> {
    if (destroyed) return Promise.resolve();
    if (cache && runtime.now() < cache.expiresAt) {
      render(cache.groups, false);
      return Promise.resolve();
    }
    inflight ??= load().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  container.hidden = true;
  void refresh();

  return {
    refresh,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      abort?.abort();
      abort = null;
      viewer?.dispose();
      viewer = null;
      observer?.disconnect();
      observer = null;
      transport?.destroy();
      transport = null;
      container.replaceChildren();
      container.hidden = initialHidden;
    },
  };
}
