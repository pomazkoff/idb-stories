import { isAllowedMediaUrl } from '@idb-stories/schema/allowlist';

/**
 * Внутренняя модель ленты. Ответ сервера разбирается «терпимо» (без zod, чтобы не тащить его
 * в бандл): неизвестные поля игнорируются, неизвестные `type` слайдов и `kind` элементов
 * пропускаются молча (раздел 8), некорректные группы и слайды отбрасываются.
 */

export const SUPPORTED_SCHEMA_VERSION = 1;

// Лимиты контракта (раздел 5.1): сервер отдаёт не больше 20 групп и 10 слайдов в группе.
const MAX_GROUPS = 20;
const MAX_SLIDES = 10;
const MAX_SKUS = 6;
const DEFAULT_DURATION_MS = 6000;
const MIN_DURATION_MS = 1000;
const MAX_DURATION_MS = 60_000;
const DEFAULT_TTL_SEC = 60;
const MAX_TTL_SEC = 3600;

const TEXT_STYLES = ['title', 'body', 'caption'] as const;
const TEXT_POSITIONS = ['top', 'center', 'bottom'] as const;
const CTA_TYPES = ['deeplink', 'product', 'category', 'url'] as const;
const SKU_RE = /^[A-Za-z0-9_-]{1,64}$/;

export type TextStyle = (typeof TEXT_STYLES)[number];
export type TextPosition = (typeof TEXT_POSITIONS)[number];
export type CtaType = (typeof CTA_TYPES)[number];

export interface TextElement {
  text: string;
  style: TextStyle;
  position: TextPosition;
}

export interface Cta {
  type: CtaType;
  value: string;
  label: string;
}

export interface MediaVariant {
  url: string;
  w: number;
  h: number;
  mime: string | null;
}

interface SlideBase {
  id: string;
  /** Позиция слайда в группе в исходной ленте — уходит в slide_index событий. */
  index: number;
  durationMs: number;
  elements: TextElement[];
  cta: Cta | null;
}

export interface ImageSlide extends SlideBase {
  type: 'image';
  variants: MediaVariant[];
}

export interface VideoSlide extends SlideBase {
  type: 'video';
  variants: MediaVariant[];
  posterUrl: string | null;
}

export interface ProductSlide extends SlideBase {
  type: 'product';
  skus: string[];
}

export type Slide = ImageSlide | VideoSlide | ProductSlide;

export interface Group {
  id: string;
  version: number;
  title: string;
  coverUrl: string | null;
  /** Индекс группы в исходном `feed.groups`. */
  feedIndex: number;
  slides: Slide[];
}

/** Слайд, пропущенный из-за медиа с неразрешённого origin (→ story_media_error forbidden_origin). */
export interface ForbiddenSlide {
  groupId: string;
  groupVersion: number;
  slideId: string;
  slideIndex: number;
  slideType: string;
}

export interface NormalizeOptions {
  mediaOrigins: readonly string[];
  /** Слайды с товарами показываются только если хост умеет получать товары. */
  productsEnabled: boolean;
}

export type NormalizeResult =
  | { ok: true; groups: Group[]; ttlSec: number; forbidden: ForbiddenSlide[] }
  | { ok: false; reason: 'invalid' | 'unsupported_version' };

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function nonEmptyStr(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 && v.length <= 256 ? v : null;
}

function posInt(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null;
}

function oneOf<T extends string>(v: unknown, values: readonly T[]): T | null {
  return typeof v === 'string' && (values as readonly string[]).includes(v) ? (v as T) : null;
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function parseElements(raw: unknown): TextElement[] {
  const out: TextElement[] = [];
  for (const el of arr(raw)) {
    if (!isObj(el) || el.kind !== 'text') continue; // неизвестный kind — молча пропускаем
    const text = str(el.text);
    if (text === null || text.trim() === '') continue;
    out.push({
      text,
      style: oneOf(el.style, TEXT_STYLES) ?? 'body',
      position: oneOf(el.position, TEXT_POSITIONS) ?? 'bottom',
    });
  }
  return out;
}

function parseCta(raw: unknown): Cta | null {
  if (!isObj(raw)) return null;
  const type = oneOf(raw.type, CTA_TYPES);
  const value = str(raw.value);
  if (!type || value === null || value.trim() === '') return null;
  const label = str(raw.label)?.trim();
  return { type, value, label: label ? label : 'Подробнее' };
}

function parseVariants(raw: unknown): MediaVariant[] {
  const out: MediaVariant[] = [];
  for (const v of arr(raw)) {
    if (!isObj(v)) continue;
    const url = str(v.url);
    if (!url) continue;
    out.push({
      url,
      w: typeof v.w === 'number' && v.w > 0 ? v.w : 0,
      h: typeof v.h === 'number' && v.h > 0 ? v.h : 0,
      mime: str(v.mime),
    });
  }
  return out;
}

function parseDuration(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return DEFAULT_DURATION_MS;
  return Math.min(MAX_DURATION_MS, Math.max(MIN_DURATION_MS, Math.round(v)));
}

type SlideParse =
  { kind: 'ok'; slide: Slide } | { kind: 'skip' } | { kind: 'forbidden'; type: string; id: string };

function parseSlide(raw: unknown, index: number, opts: NormalizeOptions): SlideParse {
  if (!isObj(raw)) return { kind: 'skip' };
  const id = nonEmptyStr(raw.id);
  const type = str(raw.type);
  if (!id || !type) return { kind: 'skip' };
  const base = {
    id,
    index,
    durationMs: parseDuration(raw.duration_ms),
    elements: parseElements(raw.elements),
    cta: parseCta(raw.cta),
  };
  const allowed = (url: string) => isAllowedMediaUrl(url, opts.mediaOrigins);

  switch (type) {
    case 'image': {
      const media = isObj(raw.media) ? raw.media : {};
      const all = parseVariants(media.variants).filter(
        (v) => v.mime === null || v.mime.startsWith('image/'),
      );
      if (all.length === 0) return { kind: 'skip' };
      const variants = all.filter((v) => allowed(v.url));
      if (variants.length === 0) return { kind: 'forbidden', type, id };
      return { kind: 'ok', slide: { ...base, type: 'image', variants } };
    }
    case 'video': {
      const media = isObj(raw.media) ? raw.media : {};
      const all = parseVariants(media.variants).filter(
        (v) => v.mime === null || v.mime === 'video/mp4',
      );
      if (all.length === 0) return { kind: 'skip' };
      const variants = all.filter((v) => allowed(v.url));
      if (variants.length === 0) return { kind: 'forbidden', type, id };
      const posterRaw = isObj(media.poster) ? str(media.poster.url) : null;
      // Постер с чужого origin просто игнорируется: видео всё равно покажется.
      const posterUrl = posterRaw && allowed(posterRaw) ? posterRaw : null;
      return { kind: 'ok', slide: { ...base, type: 'video', variants, posterUrl } };
    }
    case 'product': {
      if (!opts.productsEnabled) return { kind: 'skip' };
      const skus = [
        ...new Set(
          arr(raw.product_skus).filter((s): s is string => typeof s === 'string' && SKU_RE.test(s)),
        ),
      ].slice(0, MAX_SKUS);
      if (skus.length === 0) return { kind: 'skip' };
      return { kind: 'ok', slide: { ...base, type: 'product', skus } };
    }
    default:
      // Неизвестный тип слайда (новая версия контракта) — пропускаем молча.
      return { kind: 'skip' };
  }
}

function parseGroup(
  raw: unknown,
  feedIndex: number,
  opts: NormalizeOptions,
  forbidden: ForbiddenSlide[],
): Group | null {
  if (!isObj(raw)) return null;
  const id = nonEmptyStr(raw.id);
  const version = posInt(raw.version);
  if (!id || version === null) return null;
  const title = str(raw.title) ?? '';
  const coverRaw = isObj(raw.cover) ? str(raw.cover.url) : null;
  const coverUrl = coverRaw && isAllowedMediaUrl(coverRaw, opts.mediaOrigins) ? coverRaw : null;

  const slides: Slide[] = [];
  const seen = new Set<string>();
  arr(raw.slides)
    .slice(0, MAX_SLIDES)
    .forEach((rawSlide, index) => {
      const res = parseSlide(rawSlide, index, opts);
      if (res.kind === 'forbidden') {
        forbidden.push({
          groupId: id,
          groupVersion: version,
          slideId: res.id,
          slideIndex: index,
          slideType: res.type,
        });
      } else if (res.kind === 'ok' && !seen.has(res.slide.id)) {
        seen.add(res.slide.id);
        slides.push(res.slide);
      }
    });
  if (slides.length === 0) return null; // группа без отображаемых слайдов пропускается
  return { id, version, title, coverUrl, feedIndex, slides };
}

export function normalizeFeed(raw: unknown, opts: NormalizeOptions): NormalizeResult {
  if (!isObj(raw)) return { ok: false, reason: 'invalid' };
  const version = raw.schema_version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    return { ok: false, reason: 'invalid' };
  }
  if (version > SUPPORTED_SCHEMA_VERSION) return { ok: false, reason: 'unsupported_version' };
  if (!Array.isArray(raw.groups)) return { ok: false, reason: 'invalid' };

  const ttl = raw.ttl_sec;
  const ttlSec =
    typeof ttl === 'number' && Number.isFinite(ttl) && ttl > 0
      ? Math.min(ttl, MAX_TTL_SEC)
      : DEFAULT_TTL_SEC;

  const forbidden: ForbiddenSlide[] = [];
  const groups: Group[] = [];
  const seen = new Set<string>();
  raw.groups.slice(0, MAX_GROUPS).forEach((g, i) => {
    const group = parseGroup(g, i, opts, forbidden);
    if (group && !seen.has(group.id)) {
      seen.add(group.id);
      groups.push(group);
    }
  });
  return { ok: true, groups, ttlSec, forbidden };
}

/** Индекс в нормализованном списке для индекса группы в исходной ленте (или следующей за ней). */
export function groupIndexForFeedIndex(groups: readonly Group[], feedIndex: number): number {
  const i = groups.findIndex((g) => g.feedIndex >= feedIndex);
  return i;
}
