import { checkCta, withStoryRef } from '@idb-stories/schema/allowlist';
import { button, focusable, h, isInteractive, setIcon } from './dom.js';
import { formatPrice } from './format.js';
import {
  createImage,
  createVideo,
  type MediaHandle,
  pickVariant,
  preloadImage,
  targetWidth,
} from './media.js';
import type { Cta, Group, ProductSlide, Slide } from './model.js';
import type { Runtime } from './runtime.js';
import type { CatalogProduct } from './types.js';

type PauseReason = 'user' | 'hold' | 'buffering' | 'loading' | 'hidden' | 'finished';
export type OpenSource = 'tap' | 'swipe' | 'auto';
export type CloseReason = 'swipe' | 'button' | 'end';

/** Удержание дольше 200 мс — пауза, а не тап. */
export const HOLD_MS = 200;
/** Слайд считается просмотренным через 1 с показа (story_slide_view). */
export const VIEW_MS = 1000;
const SWIPE_PX = 50;
const TAP_SLOP_PX = 15;
/** Страховочный таймер видео сверх длительности: основной переход — по событию ended. */
const VIDEO_GRACE_MS = 2000;
const HARD_PAUSES: readonly PauseReason[] = ['user', 'hold', 'hidden', 'finished'];

/** Таймер слайда с паузой: считает только время, когда слайд реально играет. */
class Countdown {
  private remaining: number;
  private startedAt: number | null = null;
  private handle: ReturnType<typeof setTimeout> | null = null;
  private done = false;

  constructor(
    private duration: number,
    private readonly now: () => number,
    private readonly onDone: () => void,
  ) {
    this.remaining = duration;
  }

  get running(): boolean {
    return this.startedAt !== null;
  }

  start(): void {
    if (this.done || this.startedAt !== null) return;
    this.startedAt = this.now();
    this.handle = setTimeout(() => this.fire(), Math.max(0, this.remaining));
  }

  pause(): void {
    if (this.startedAt === null) return;
    if (this.handle !== null) clearTimeout(this.handle);
    this.handle = null;
    this.remaining -= this.now() - this.startedAt;
    this.startedAt = null;
  }

  setDuration(ms: number): void {
    const wasRunning = this.running;
    this.pause();
    this.remaining += ms - this.duration;
    this.duration = ms;
    if (wasRunning) this.start();
  }

  progress(): number {
    if (this.done) return 1;
    const elapsed =
      this.duration - this.remaining + (this.startedAt !== null ? this.now() - this.startedAt : 0);
    return Math.min(1, Math.max(0, elapsed / this.duration));
  }

  remainingMs(): number {
    return Math.max(0, this.duration * (1 - this.progress()));
  }

  cancel(): void {
    if (this.handle !== null) clearTimeout(this.handle);
    this.handle = null;
    this.startedAt = null;
    this.done = true;
  }

  private fire(): void {
    this.handle = null;
    this.startedAt = null;
    this.remaining = 0;
    this.done = true;
    this.onDone();
  }
}

function prefersReducedMotion(): boolean {
  try {
    return (
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    );
  } catch {
    return false;
  }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function safeImageUrl(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  try {
    const url = new URL(v, document.baseURI);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

/** Ответ каталога приходит от хоста, но всё равно проверяется: в наличии, нужный SKU, порядок слайда. */
function sanitizeProducts(list: unknown, skus: readonly string[]): CatalogProduct[] {
  if (!Array.isArray(list)) return [];
  const bySku = new Map<string, CatalogProduct>();
  for (const item of list as unknown[]) {
    if (!isObj(item)) continue;
    const { sku, name, priceRub, inStock } = item;
    if (typeof sku !== 'string' || !skus.includes(sku) || bySku.has(sku)) continue;
    if (inStock !== true || typeof name !== 'string' || name.trim() === '') continue;
    if (typeof priceRub !== 'number' || !Number.isFinite(priceRub) || priceRub < 0) continue;
    bySku.set(sku, { sku, name, priceRub, inStock: true, imageUrl: safeImageUrl(item.imageUrl) });
  }
  return skus.flatMap((s) => {
    const p = bySku.get(s);
    return p ? [p] : [];
  });
}

let scrollLocks = 0;

function lockScroll(): void {
  if (scrollLocks++ === 0) document.documentElement.classList.add('idbs-scroll-lock');
}

function unlockScroll(): void {
  scrollLocks = Math.max(0, scrollLocks - 1);
  if (scrollLocks === 0) document.documentElement.classList.remove('idbs-scroll-lock');
}

export interface ViewerConfig {
  runtime: Runtime;
  groups: Group[];
  /** overlay — полноэкранный модальный диалог; inline — внутри контейнера (предпросмотр в админке). */
  mode: 'overlay' | 'inline';
  parent: HTMLElement;
  /** false — слайды стартуют на паузе и не переключаются сами (как при reduce motion). */
  autoplay: boolean;
  /** Записывать ли «просмотрено» (в предпросмотре — нет). */
  markViewed: boolean;
  onClose?: (lastGroupId: string | null) => void;
}

interface Gesture {
  id: number;
  x: number;
  y: number;
  held: boolean;
}

export class Viewer {
  readonly root: HTMLDivElement;
  private readonly stage: HTMLDivElement;
  private readonly progressEl: HTMLDivElement;
  private readonly avatar: HTMLImageElement;
  private readonly titleEl: HTMLDivElement;
  private readonly pauseBtn: HTMLButtonElement;
  private readonly muteBtn: HTMLButtonElement;
  private readonly slot: HTMLDivElement;
  private readonly endPanel: HTMLDivElement;
  private fills: HTMLDivElement[] = [];
  private segs: HTMLDivElement[] = [];

  private readonly runtime: Runtime;
  private groups: Group[];
  private gi = -1;
  private si = -1;
  private dir: 1 | -1 = 1;
  private startIndex = 0;
  private token = 0;
  private readonly pauses = new Set<PauseReason>();
  private timer: Countdown | null = null;
  private viewTimer: ReturnType<typeof setTimeout> | null = null;
  private holdTimer: ReturnType<typeof setTimeout> | null = null;
  private gesture: Gesture | null = null;
  private media: MediaHandle | null = null;
  private readonly preloaded = new Map<string, MediaHandle>();
  private readonly preloadedCovers = new Set<string>();
  private readonly products = new Map<string, Promise<CatalogProduct[]>>();
  private readonly skipped = new Set<string>();
  private readonly watched = new Set<string>();
  private muted = true;
  private mounted = false;
  private closed = false;
  private disposed = false;
  private readonly autoAdvance: boolean;
  private prevFocus: HTMLElement | null = null;
  private readonly keyTarget: Document | HTMLElement;

  constructor(private readonly cfg: ViewerConfig) {
    this.runtime = cfg.runtime;
    this.groups = cfg.groups;
    this.autoAdvance = cfg.autoplay && !prefersReducedMotion();

    const overlay = cfg.mode === 'overlay';
    this.root = h('div', `idbs-viewer ${overlay ? 'idbs-viewer--overlay' : 'idbs-viewer--inline'}`);
    this.root.setAttribute('role', overlay ? 'dialog' : 'region');
    if (overlay) this.root.setAttribute('aria-modal', 'true');
    this.root.tabIndex = overlay ? -1 : 0;
    this.keyTarget = overlay ? document : this.root;

    this.stage = h('div', 'idbs-stage');
    this.slot = h('div', 'idbs-slot');

    const chrome = h('div', 'idbs-chrome');
    this.progressEl = h('div', 'idbs-progress');
    this.progressEl.setAttribute('aria-hidden', 'true');
    this.progressEl.setAttribute('aria-live', 'off');

    const header = h('div', 'idbs-header');
    this.avatar = h('img', 'idbs-header__avatar');
    this.avatar.alt = '';
    this.avatar.hidden = true;
    this.titleEl = h('div', 'idbs-header__title');
    this.pauseBtn = button('idbs-btn idbs-btn--pause', 'Пауза');
    this.muteBtn = button('idbs-btn idbs-btn--mute', 'Включить звук');
    this.muteBtn.hidden = true;
    const closeBtn = button('idbs-btn idbs-btn--close', 'Закрыть');
    setIcon(closeBtn, 'close');
    setIcon(this.pauseBtn, 'pause');
    setIcon(this.muteBtn, 'muted');
    header.append(this.avatar, this.titleEl, this.pauseBtn, this.muteBtn, closeBtn);

    const prevBtn = button('idbs-sr-only idbs-nav-prev', 'Предыдущий слайд');
    const nextBtn = button('idbs-sr-only idbs-nav-next', 'Следующий слайд');
    chrome.append(this.progressEl, header);

    const spinner = h('div', 'idbs-spinner');
    spinner.setAttribute('aria-hidden', 'true');

    this.endPanel = h('div', 'idbs-end');
    this.endPanel.hidden = true;
    const endText = h('p', 'idbs-end__text', 'Просмотр завершён');
    const replay = button('idbs-end__replay', 'Смотреть снова', 'Смотреть снова');
    this.endPanel.append(endText, replay);

    this.stage.append(chrome, this.slot, spinner, prevBtn, nextBtn);
    this.root.append(this.stage, this.endPanel);

    closeBtn.addEventListener('click', () => this.close('button'));
    this.pauseBtn.addEventListener('click', () => this.togglePause());
    this.muteBtn.addEventListener('click', () => this.toggleMute());
    prevBtn.addEventListener('click', () => this.prev());
    nextBtn.addEventListener('click', () => this.next('tap'));
    replay.addEventListener('click', () => this.restart());
    this.stage.addEventListener('pointerdown', this.onPointerDown);
    this.stage.addEventListener('pointerup', this.onPointerUp);
    this.stage.addEventListener('pointercancel', this.onPointerCancel);
    this.stage.addEventListener('contextmenu', this.onContextMenu);
  }

  // -------------------------------------------------------------------------
  // Жизненный цикл
  // -------------------------------------------------------------------------

  /** Открывает группу `groupIndex` (индекс в нормализованном списке). */
  open(groupIndex: number, source: OpenSource): void {
    if (this.disposed) return;
    this.startIndex = Math.max(0, Math.min(groupIndex, this.groups.length - 1));
    this.mount();
    this.enterAt(this.startIndex, source);
  }

  close(reason: CloseReason): void {
    if (this.closed || this.disposed || !this.mounted) return;
    const group = this.groups[this.gi];
    this.closed = true;
    this.teardownSlide();
    this.token++;
    this.clearGesture();
    if (group) {
      this.runtime.emit('story_close', {
        group_id: group.id,
        group_version: group.version,
        reason,
        watched_slides: this.watched.size,
      });
    }
    if (this.cfg.mode === 'overlay') {
      this.unmount();
    } else {
      this.stage.hidden = true;
      this.endPanel.hidden = false;
    }
    this.cfg.onClose?.(group?.id ?? null);
    if (this.cfg.mode === 'overlay') this.restoreFocus();
  }

  /** Убирает плеер без событий (destroy хоста). */
  dispose(): void {
    if (this.disposed) return;
    this.teardownSlide();
    this.token++;
    this.clearGesture();
    this.clearPreloaded();
    if (this.mounted) this.unmount();
    this.disposed = true;
    this.closed = true;
  }

  /** Предпросмотр: подменить ленту, сохранив текущую группу и слайд, если они остались. */
  setGroups(groups: Group[]): void {
    if (this.disposed) return;
    const cur = this.groups[this.gi];
    const curSlide = cur?.slides[this.si];
    const prevGi = this.gi;
    const prevSi = this.si;
    this.groups = groups;
    this.skipped.clear();
    this.products.clear();
    this.clearPreloaded();
    if (groups.length === 0) return;
    this.startIndex = Math.min(this.startIndex, groups.length - 1);
    if (this.closed || !this.mounted) return;

    const gi = cur ? groups.findIndex((g) => g.id === cur.id) : -1;
    const group = groups[gi];
    if (!group) {
      this.gi = -1;
      this.enterAt(Math.max(0, Math.min(prevGi, groups.length - 1)), 'tap');
      return;
    }
    let si = curSlide ? group.slides.findIndex((s) => s.id === curSlide.id) : -1;
    if (si < 0) si = Math.max(0, Math.min(prevSi, group.slides.length - 1));
    this.gi = gi;
    this.renderGroupChrome(group);
    this.go(gi, si, 1, null);
  }

  private restart(): void {
    if (this.disposed) return;
    this.closed = false;
    this.stage.hidden = false;
    this.endPanel.hidden = true;
    this.gi = -1;
    this.si = -1;
    this.skipped.clear();
    this.enterAt(this.startIndex, 'tap');
    this.root.focus({ preventScroll: true });
  }

  private mount(): void {
    if (this.mounted) return;
    this.mounted = true;
    this.closed = false;
    this.cfg.parent.appendChild(this.root);
    this.keyTarget.addEventListener('keydown', this.onKeyDown as EventListener);
    document.addEventListener('visibilitychange', this.onVisibility);
    if (document.hidden) this.pauses.add('hidden');
    if (this.cfg.mode === 'overlay') {
      lockScroll();
      const active = document.activeElement;
      this.prevFocus = active instanceof HTMLElement ? active : null;
      this.root.focus({ preventScroll: true });
    }
  }

  private unmount(): void {
    if (!this.mounted) return;
    this.mounted = false;
    this.keyTarget.removeEventListener('keydown', this.onKeyDown as EventListener);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.root.remove();
    if (this.cfg.mode === 'overlay') unlockScroll();
  }

  private restoreFocus(): void {
    const el = this.prevFocus;
    this.prevFocus = null;
    if (el?.isConnected) el.focus({ preventScroll: true });
  }

  // -------------------------------------------------------------------------
  // Навигация
  // -------------------------------------------------------------------------

  private key(gi: number, si: number): string {
    const g = this.groups[gi];
    return `${g?.id ?? ''}:${g?.slides[si]?.id ?? ''}`;
  }

  /** Первый непропущенный слайд группы, начиная с `from`, в направлении `dir`; -1 — нет. */
  private findSlide(gi: number, from: number, dir: 1 | -1): number {
    const group = this.groups[gi];
    if (!group) return -1;
    for (let i = from; i >= 0 && i < group.slides.length; i += dir) {
      if (!this.skipped.has(this.key(gi, i))) return i;
    }
    return -1;
  }

  private enterAt(gi: number, source: OpenSource): void {
    const n = this.groups.length;
    for (let i = 0; i < n; i++) {
      const g = (gi + i) % n;
      const s = this.findSlide(g, 0, 1);
      if (s >= 0) {
        this.go(g, s, 1, source);
        return;
      }
    }
    this.close('end');
  }

  next(source: OpenSource = 'tap'): void {
    if (this.closed) return;
    const s = this.findSlide(this.gi, this.si + 1, 1);
    if (s >= 0) this.go(this.gi, s, 1, null);
    else this.nextGroup(source);
  }

  prev(): void {
    if (this.closed) return;
    const s = this.findSlide(this.gi, this.si - 1, -1);
    if (s >= 0) {
      this.go(this.gi, s, -1, null);
      return;
    }
    for (let g = this.gi - 1; g >= 0; g--) {
      const k = this.findSlide(g, 0, 1);
      if (k >= 0) {
        this.go(g, k, 1, 'tap');
        return;
      }
    }
    // Самое начало: перезапускаем текущий слайд (или ближайший доступный).
    const k = this.findSlide(this.gi, this.si, 1);
    if (k >= 0) this.go(this.gi, k, 1, null);
    else this.nextGroup('auto');
  }

  nextGroup(source: OpenSource): void {
    if (this.closed) return;
    for (let g = this.gi + 1; g < this.groups.length; g++) {
      const k = this.findSlide(g, 0, 1);
      if (k >= 0) {
        this.go(g, k, 1, source);
        return;
      }
    }
    this.close('end');
  }

  prevGroup(source: OpenSource): void {
    if (this.closed) return;
    for (let g = this.gi - 1; g >= 0; g--) {
      const k = this.findSlide(g, 0, 1);
      if (k >= 0) {
        this.go(g, k, 1, source);
        return;
      }
    }
  }

  togglePause(): void {
    if (this.closed) return;
    if (this.pauses.has('finished')) {
      this.next('tap');
      return;
    }
    if (this.pauses.has('user')) this.pauses.delete('user');
    else this.pauses.add('user');
    this.apply();
  }

  private toggleMute(): void {
    this.muted = !this.muted;
    const video = this.currentVideo();
    if (video) video.muted = this.muted;
    this.renderMute();
  }

  /** Слайд не показать (ошибка медиа, нет товаров): пропускаем его в текущем направлении. */
  private skipCurrent(): void {
    this.skipped.add(this.key(this.gi, this.si));
    const seg = this.segs[this.si];
    if (seg) seg.hidden = true;
    if (this.dir === 1) this.next('auto');
    else this.prev();
  }

  private go(gi: number, si: number, dir: 1 | -1, source: OpenSource | null): void {
    if (this.closed || this.disposed) return;
    const group = this.groups[gi];
    const slide = group?.slides[si];
    if (!group || !slide) return;
    this.teardownSlide();
    const token = ++this.token;
    const groupChanged = gi !== this.gi;
    this.gi = gi;
    this.si = si;
    this.dir = dir;
    if (groupChanged) this.enterGroup(group, source ?? 'auto');

    this.pauses.delete('user');
    this.pauses.delete('finished');
    this.pauses.delete('loading');
    this.pauses.delete('buffering');
    if (!this.autoAdvance) this.pauses.add('user');

    this.renderSlide(group, slide, token);
    this.preloadNext();
    this.apply();
  }

  private enterGroup(group: Group, source: OpenSource): void {
    this.watched.clear();
    this.renderGroupChrome(group);
    this.runtime.emit('story_group_open', {
      group_id: group.id,
      group_version: group.version,
      source,
    });
    if (this.cfg.markViewed) this.runtime.viewed.markViewed(group.id, group.version);
  }

  // -------------------------------------------------------------------------
  // Отрисовка
  // -------------------------------------------------------------------------

  private renderGroupChrome(group: Group): void {
    this.root.setAttribute('aria-label', group.title.trim() || 'Истории');
    this.titleEl.textContent = group.title;
    if (group.coverUrl) {
      this.avatar.src = group.coverUrl;
      this.avatar.hidden = false;
    } else {
      this.avatar.removeAttribute('src');
      this.avatar.hidden = true;
    }
    this.segs = [];
    this.fills = [];
    const gi = this.groups.indexOf(group);
    group.slides.forEach((_, i) => {
      const seg = h('div', 'idbs-progress__seg');
      const fill = h('div', 'idbs-progress__fill');
      seg.appendChild(fill);
      seg.hidden = this.skipped.has(this.key(gi, i));
      this.segs.push(seg);
      this.fills.push(fill);
    });
    this.progressEl.replaceChildren(...this.segs);
  }

  private renderSlide(group: Group, slide: Slide, token: number): void {
    const visible = this.segs.filter((s) => !s.hidden).length || group.slides.length;
    const position = this.segs.slice(0, this.si + 1).filter((s) => !s.hidden).length || 1;
    const el = h('div', `idbs-slide idbs-slide--${slide.type}`);
    el.setAttribute('role', 'group');
    el.setAttribute('aria-roledescription', 'слайд');
    el.setAttribute('aria-label', `Слайд ${position} из ${visible}`);

    const layers = {
      top: h('div', 'idbs-layer idbs-layer--top'),
      center: h('div', 'idbs-layer idbs-layer--center'),
      bottom: h('div', 'idbs-layer idbs-layer--bottom'),
    };
    for (const t of slide.elements) {
      // T3: только textContent — HTML и Markdown не интерпретируются.
      layers[t.position].appendChild(h('p', `idbs-text idbs-text--${t.style}`, t.text));
    }

    const duration = slide.type === 'video' ? slide.durationMs + VIDEO_GRACE_MS : slide.durationMs;
    this.timer = new Countdown(duration, this.runtime.now, () => this.slideEnded(token));

    if (slide.type === 'product') {
      this.renderProducts(group, slide, token, layers.center);
    } else {
      const handle = this.takeMedia(group, slide);
      if (!handle) {
        // Недостижимо: нормализация оставляет только слайды с медиа.
        this.pauses.add('loading');
      } else {
        const mediaBox = h('div', 'idbs-media');
        mediaBox.appendChild(handle.el);
        el.appendChild(mediaBox);
        this.media = handle;
        if (handle.el instanceof HTMLVideoElement) this.bindVideo(handle.el, token);
        if (handle.state !== 'loaded') this.pauses.add('loading');
        handle.onSettled((state) => {
          // Колбэк может прийти синхронно — откладываем, чтобы не менять слайд посреди go().
          setTimeout(() => {
            if (token !== this.token) return;
            if (state === 'error') {
              this.mediaFailed(group, slide);
            } else {
              this.pauses.delete('loading');
              this.contentReady(group, slide, token);
              this.apply();
            }
          }, 0);
        });
      }
    }

    if (slide.cta) layers.bottom.appendChild(this.ctaButton(group, slide, slide.cta));
    el.append(h('div', 'idbs-shade'), layers.top, layers.center, layers.bottom);
    this.slot.replaceChildren(el);
    this.muteBtn.hidden = slide.type !== 'video';
    this.renderMute();
  }

  private takeMedia(group: Group, slide: Slide): MediaHandle | null {
    if (slide.type === 'product') return null;
    const key = `${group.id}:${slide.id}`;
    const pre = this.preloaded.get(key);
    if (pre && pre.state !== 'error') {
      this.preloaded.delete(key);
      pre.el.className = slide.type === 'video' ? 'idbs-media__video' : 'idbs-media__img';
      return pre;
    }
    return this.createMedia(slide);
  }

  private createMedia(slide: Slide): MediaHandle | null {
    if (slide.type === 'product') return null;
    const variant = pickVariant(slide.variants, targetWidth(this.stage));
    if (!variant) return null;
    return slide.type === 'video'
      ? createVideo(variant.url, slide.posterUrl, 'idbs-media__video')
      : createImage(variant.url, 'idbs-media__img');
  }

  private bindVideo(video: HTMLVideoElement, token: number): void {
    video.muted = this.muted;
    const live = () => token === this.token;
    let lastTime = 0;
    const setBuffering = (on: boolean) => {
      if (!live() || this.pauses.has('buffering') === on) return;
      if (on) this.pauses.add('buffering');
      else this.pauses.delete('buffering');
      this.apply();
    };
    // Буферизация — таймер слайда стоит (раздел 8).
    video.addEventListener('waiting', () => setBuffering(true));
    video.addEventListener('stalled', () => setBuffering(true));
    video.addEventListener('playing', () => setBuffering(false));
    video.addEventListener('canplay', () => setBuffering(false));
    video.addEventListener('timeupdate', () => {
      if (video.currentTime > lastTime) setBuffering(false);
      lastTime = video.currentTime;
    });
    video.addEventListener('loadedmetadata', () => {
      if (!live() || !Number.isFinite(video.duration) || video.duration <= 0) return;
      this.timer?.setDuration(video.duration * 1000 + VIDEO_GRACE_MS);
      this.apply();
    });
    // Для видео переход — по окончанию.
    video.addEventListener('ended', () => {
      if (live()) this.slideEnded(token);
    });
  }

  private renderProducts(
    group: Group,
    slide: ProductSlide,
    token: number,
    layer: HTMLElement,
  ): void {
    const list = h('ul', 'idbs-products');
    list.setAttribute('aria-label', 'Товары');
    layer.appendChild(list);
    this.pauses.add('loading');
    this.loadProducts(slide.skus)
      .then((products) => {
        if (token !== this.token) return;
        if (products.length === 0) {
          // Всё не в наличии или каталог недоступен — слайд пропускается (раздел 5.1).
          this.skipCurrent();
          return;
        }
        for (const p of products) list.appendChild(this.productCard(group, slide, p));
        this.pauses.delete('loading');
        this.contentReady(group, slide, token);
        this.apply();
      })
      .catch((err: unknown) => console.error('[idb-stories] product slide failed', err));
  }

  private loadProducts(skus: string[]): Promise<CatalogProduct[]> {
    const key = skus.join(',');
    let p = this.products.get(key);
    if (!p) {
      const get = this.runtime.getProducts;
      p = get
        ? Promise.resolve()
            .then(() => get([...skus]))
            .then((list) => sanitizeProducts(list, skus))
            .catch(() => [])
        : Promise.resolve([]);
      this.products.set(key, p);
    }
    return p;
  }

  private productCard(group: Group, slide: Slide, p: CatalogProduct): HTMLLIElement {
    const li = h('li', 'idbs-product');
    const main = h('button', 'idbs-product__main');
    main.type = 'button';
    if (p.imageUrl) {
      const img = h('img', 'idbs-product__img');
      img.alt = '';
      img.decoding = 'async';
      img.src = p.imageUrl;
      main.appendChild(img);
    }
    main.append(
      h('span', 'idbs-product__name', p.name),
      h('span', 'idbs-product__price', formatPrice(p.priceRub)),
    );
    main.addEventListener('click', () => this.productClick(group, slide, p.sku));
    li.appendChild(main);

    const onAddToCart = this.runtime.onAddToCart;
    if (onAddToCart) {
      const cart = h('button', 'idbs-product__cart', 'В корзину');
      cart.type = 'button';
      cart.setAttribute('aria-label', `В корзину: ${p.name}`);
      cart.addEventListener('click', () => {
        if (cart.disabled) return;
        cart.disabled = true;
        const storyRef = `${group.id}:${slide.id}`;
        Promise.resolve()
          .then(() => onAddToCart(p.sku, storyRef))
          .then(
            () => {
              this.runtime.emit('story_add_to_cart', {
                ...this.slideFields(group, slide),
                sku: p.sku,
              });
              cart.textContent = 'Добавлено';
              cart.setAttribute('aria-label', `Добавлено в корзину: ${p.name}`);
            },
            (err: unknown) => {
              console.error('[idb-stories] onAddToCart failed', err);
              cart.disabled = false;
            },
          )
          .catch(() => undefined);
      });
      li.appendChild(cart);
    }
    return li;
  }

  private productClick(group: Group, slide: Slide, sku: string): void {
    this.runtime.emit('story_product_click', { ...this.slideFields(group, slide), sku });
    const onCta = this.runtime.onCta;
    if (!onCta) return;
    try {
      onCta({ type: 'product', value: sku, href: null, storyRef: `${group.id}:${slide.id}` });
    } catch (err) {
      console.error('[idb-stories] onCta failed', err);
    }
  }

  private ctaButton(group: Group, slide: Slide, cta: Cta): HTMLButtonElement {
    const b = h('button', 'idbs-cta', cta.label);
    b.type = 'button';
    b.addEventListener('click', () => this.ctaClick(group, slide, cta));
    return b;
  }

  private ctaClick(group: Group, slide: Slide, cta: Cta): void {
    // T4: повторная проверка по allowlist на клиенте перед любым переходом (раздел 10.4).
    const res = checkCta(cta.type, cta.value, this.runtime.ctaAllowlist);
    if (!res.ok) {
      console.warn(`[idb-stories] CTA отклонён: ${res.reason}`);
      return;
    }
    let href: string | null = null;
    if (cta.type === 'url' || cta.type === 'deeplink') {
      try {
        href = withStoryRef(res.normalized, group.id, slide.id);
      } catch {
        return;
      }
    }
    this.runtime.emit('story_cta_click', {
      ...this.slideFields(group, slide),
      cta_type: cta.type,
      cta_value: cta.value.trim(),
    });
    const action = {
      type: cta.type,
      value: res.normalized,
      href,
      storyRef: `${group.id}:${slide.id}`,
    };
    const onCta = this.runtime.onCta;
    if (onCta) {
      try {
        onCta(action);
      } catch (err) {
        console.error('[idb-stories] onCta failed', err);
      }
    } else if (href) {
      window.location.assign(href);
    }
  }

  private renderMute(): void {
    setIcon(this.muteBtn, this.muted ? 'muted' : 'sound');
    this.muteBtn.setAttribute('aria-label', this.muted ? 'Включить звук' : 'Выключить звук');
    this.muteBtn.setAttribute('aria-pressed', String(!this.muted));
  }

  // -------------------------------------------------------------------------
  // Воспроизведение
  // -------------------------------------------------------------------------

  private slideFields(group: Group, slide: Slide) {
    return {
      group_id: group.id,
      group_version: group.version,
      slide_id: slide.id,
      slide_index: slide.index,
      slide_type: slide.type,
    };
  }

  /** Контент слайда показан: через 1 с — story_slide_view. */
  private contentReady(group: Group, slide: Slide, token: number): void {
    if (this.viewTimer !== null) return;
    this.viewTimer = setTimeout(() => {
      this.viewTimer = null;
      if (token !== this.token) return;
      this.watched.add(slide.id);
      this.runtime.emit('story_slide_view', this.slideFields(group, slide));
    }, VIEW_MS);
  }

  private slideEnded(token: number): void {
    if (token !== this.token || this.closed || this.pauses.has('finished')) return;
    const group = this.groups[this.gi];
    const slide = group?.slides[this.si];
    if (!group || !slide) return;
    this.timer?.cancel();
    this.runtime.emit('story_slide_complete', this.slideFields(group, slide));
    if (this.autoAdvance) {
      this.next('auto');
    } else {
      // reduce motion / autoplay=false: сами не переключаемся, ждём действия пользователя.
      this.pauses.add('finished');
      this.apply();
    }
  }

  private mediaFailed(group: Group, slide: Slide): void {
    this.runtime.emit('story_media_error', {
      ...this.slideFields(group, slide),
      error_code: 'load_failed',
    });
    this.skipCurrent();
  }

  private currentVideo(): HTMLVideoElement | null {
    const el = this.media?.el;
    return el instanceof HTMLVideoElement ? el : null;
  }

  private playVideo(video: HTMLVideoElement): void {
    const token = this.token;
    let result: Promise<void> | undefined;
    try {
      result = video.play();
    } catch {
      return;
    }
    result?.catch((err: unknown) => {
      if (token !== this.token || (err instanceof DOMException && err.name === 'AbortError'))
        return;
      if (!video.muted) {
        // Автовоспроизведение со звуком запрещено браузером — пробуем без звука.
        this.muted = true;
        video.muted = true;
        this.renderMute();
        this.playVideo(video);
        return;
      }
      this.pauses.add('user');
      this.apply();
    });
  }

  /** Единая точка применения состояния: таймер, видео, прогресс, классы. */
  private apply(): void {
    if (this.closed) return;
    const running = this.pauses.size === 0;
    if (running) this.timer?.start();
    else this.timer?.pause();

    const hardPaused = HARD_PAUSES.some((r) => this.pauses.has(r));
    const video = this.currentVideo();
    if (video && this.media?.state !== 'error') {
      if (hardPaused) {
        if (!video.paused) video.pause();
      } else if (video.paused && !video.ended) {
        this.playVideo(video);
      }
    }

    this.root.classList.toggle('idbs-viewer--paused', hardPaused);
    this.root.classList.toggle('idbs-viewer--holding', this.pauses.has('hold'));
    this.root.classList.toggle(
      'idbs-viewer--loading',
      this.pauses.has('loading') || this.pauses.has('buffering'),
    );
    const showPlay = this.pauses.has('user') || this.pauses.has('finished');
    setIcon(this.pauseBtn, showPlay ? 'play' : 'pause');
    this.pauseBtn.setAttribute('aria-label', showPlay ? 'Воспроизвести' : 'Пауза');
    this.renderProgress(running);
  }

  private renderProgress(running: boolean): void {
    this.fills.forEach((fill, i) => {
      if (i === this.si) return;
      fill.style.transition = 'none';
      fill.style.transform = i < this.si ? 'scaleX(1)' : 'scaleX(0)';
    });
    const fill = this.fills[this.si];
    if (!fill) return;
    let progress = this.timer?.progress() ?? 0;
    let remaining = this.timer?.remainingMs() ?? 0;
    const video = this.currentVideo();
    if (video && Number.isFinite(video.duration) && video.duration > 0) {
      progress = Math.min(1, video.currentTime / video.duration);
      remaining = ((video.duration - video.currentTime) * 1000) / (video.playbackRate || 1);
    }
    if (this.pauses.has('finished')) progress = 1;
    fill.style.transition = 'none';
    fill.style.transform = `scaleX(${progress})`;
    if (running && remaining > 0) {
      // Принудительный reflow, чтобы переход начался с текущего значения.
      fill.getBoundingClientRect();
      fill.style.transition = `transform ${Math.round(remaining)}ms linear`;
      fill.style.transform = 'scaleX(1)';
    }
  }

  private teardownSlide(): void {
    this.timer?.cancel();
    this.timer = null;
    if (this.viewTimer !== null) clearTimeout(this.viewTimer);
    this.viewTimer = null;
    const media = this.media;
    this.media = null;
    if (media) {
      media.cancel();
      if (media.el instanceof HTMLVideoElement) stopVideo(media.el);
    }
  }

  private preloadNext(): void {
    const target = this.peekNext();
    const keep = target ? this.key(target.gi, target.si) : null;
    for (const [key, handle] of this.preloaded) {
      if (key !== keep) {
        handle.cancel();
        if (handle.el instanceof HTMLVideoElement) stopVideo(handle.el);
        this.preloaded.delete(key);
      }
    }
    if (target && keep && !this.preloaded.has(keep)) {
      const slide = this.groups[target.gi]?.slides[target.si];
      if (slide?.type === 'product') {
        void this.loadProducts(slide.skus);
      } else if (slide) {
        const handle = this.createMedia(slide);
        if (handle) this.preloaded.set(keep, handle);
      }
    }
    const cover = this.groups[this.gi + 1]?.coverUrl;
    if (cover && !this.preloadedCovers.has(cover)) {
      this.preloadedCovers.add(cover);
      preloadImage(cover);
    }
  }

  private peekNext(): { gi: number; si: number } | null {
    const s = this.findSlide(this.gi, this.si + 1, 1);
    if (s >= 0) return { gi: this.gi, si: s };
    for (let g = this.gi + 1; g < this.groups.length; g++) {
      const k = this.findSlide(g, 0, 1);
      if (k >= 0) return { gi: g, si: k };
    }
    return null;
  }

  private clearPreloaded(): void {
    for (const handle of this.preloaded.values()) {
      handle.cancel();
      if (handle.el instanceof HTMLVideoElement) stopVideo(handle.el);
    }
    this.preloaded.clear();
  }

  // -------------------------------------------------------------------------
  // Ввод
  // -------------------------------------------------------------------------

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (this.closed || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    switch (e.key) {
      case 'ArrowRight':
        e.preventDefault();
        this.next('tap');
        break;
      case 'ArrowLeft':
        e.preventDefault();
        this.prev();
        break;
      case 'Escape':
      case 'Esc':
        e.preventDefault();
        this.close('button');
        break;
      case ' ':
      case 'Spacebar':
        if (isInteractive(e.target, this.root)) return; // пробел на кнопке — это нажатие кнопки
        e.preventDefault();
        this.togglePause();
        break;
      case 'Tab':
        if (this.cfg.mode === 'overlay') this.trapFocus(e);
        break;
      default:
        break;
    }
  };

  private trapFocus(e: KeyboardEvent): void {
    const items = focusable(this.root);
    const first = items[0];
    const last = items[items.length - 1];
    if (!first || !last) {
      e.preventDefault();
      return;
    }
    const active = document.activeElement;
    const inside = active !== this.root && this.root.contains(active);
    if (e.shiftKey && (active === first || !inside)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !inside)) {
      e.preventDefault();
      first.focus();
    }
  }

  private readonly onVisibility = (): void => {
    if (document.hidden) this.pauses.add('hidden');
    else this.pauses.delete('hidden');
    this.apply();
  };

  private readonly onContextMenu = (e: Event): void => {
    // Долгое нажатие на мобильных — это пауза, а не меню «сохранить картинку».
    if (!isInteractive(e.target, this.stage)) e.preventDefault();
  };

  private readonly onPointerDown = (e: PointerEvent): void => {
    if (this.closed || this.gesture) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (isInteractive(e.target, this.stage)) return;
    this.gesture = { id: e.pointerId, x: e.clientX, y: e.clientY, held: false };
    try {
      this.stage.setPointerCapture(e.pointerId);
    } catch {
      // не критично
    }
    this.holdTimer = setTimeout(() => {
      this.holdTimer = null;
      if (!this.gesture) return;
      this.gesture.held = true;
      this.pauses.add('hold');
      this.apply();
    }, HOLD_MS);
  };

  private readonly onPointerUp = (e: PointerEvent): void => {
    const g = this.gesture;
    if (!g || g.id !== e.pointerId) return;
    this.clearGesture();
    const dx = e.clientX - g.x;
    const dy = e.clientY - g.y;
    const ax = Math.abs(dx);
    const ay = Math.abs(dy);
    if (ay > SWIPE_PX && dy > 0 && ay > ax) {
      this.close('swipe');
    } else if (ax > SWIPE_PX && ax > ay) {
      if (dx < 0) this.nextGroup('swipe');
      else this.prevGroup('swipe');
    } else if (!g.held && ax < TAP_SLOP_PX && ay < TAP_SLOP_PX) {
      const rect = this.stage.getBoundingClientRect();
      const width = rect.width || this.stage.clientWidth || window.innerWidth;
      const x = e.clientX - rect.left;
      // Левая треть — назад, остальное — вперёд.
      if (x < width / 3) this.prev();
      else this.next('tap');
    }
  };

  private readonly onPointerCancel = (): void => {
    this.clearGesture();
  };

  private clearGesture(): void {
    if (this.holdTimer !== null) clearTimeout(this.holdTimer);
    this.holdTimer = null;
    const held = this.gesture?.held ?? false;
    this.gesture = null;
    if (held || this.pauses.has('hold')) {
      this.pauses.delete('hold');
      this.apply();
    }
  }
}

function stopVideo(video: HTMLVideoElement): void {
  try {
    video.pause();
    video.removeAttribute('src');
    video.load();
  } catch {
    // уже выгружено
  }
}
