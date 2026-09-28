import {
  CTA_REJECT_MESSAGES,
  LIMITS,
  SlideInput,
  checkCta,
  type CtaType,
  type SlideType,
} from '@idb-stories/schema';
import type { AdminSlide, CtaAllowlist } from '../../api/types.js';
import { ru } from '../../i18n/ru.js';
import { validate, type FieldErrors } from '../../lib/validation.js';

export type TextStyle = 'title' | 'body' | 'caption';
export type TextPosition = 'top' | 'center' | 'bottom';

export interface TextDraft {
  /** Ключ для React-списка (не отправляется на сервер). */
  key: string;
  text: string;
  style: TextStyle;
  position: TextPosition;
}

export interface CtaDraft {
  enabled: boolean;
  type: CtaType;
  value: string;
  label: string;
}

export interface SlideDraft {
  type: SlideType;
  mediaAssetId: string | null;
  durationSec: string;
  skus: string;
  texts: TextDraft[];
  cta: CtaDraft;
}

let keySeq = 0;
export function nextTextKey(): string {
  keySeq += 1;
  return `text-${keySeq}`;
}

const EMPTY_CTA: CtaDraft = { enabled: false, type: 'url', value: '', label: '' };

export function newSlideDraft(type: SlideType): SlideDraft {
  return {
    type,
    mediaAssetId: null,
    durationSec: String(LIMITS.slideDurationDefaultMs / 1000),
    skus: '',
    texts: [],
    cta: { ...EMPTY_CTA },
  };
}

export function newTextDraft(): TextDraft {
  return { key: nextTextKey(), text: '', style: 'title', position: 'bottom' };
}

export function draftFromSlide(slide: AdminSlide): SlideDraft {
  return {
    type: slide.type,
    mediaAssetId: slide.mediaAssetId,
    durationSec: String(slide.durationMs / 1000),
    skus: slide.productSkus.join(', '),
    texts: slide.elements
      .filter((e) => e.kind === 'text')
      .map((e) => ({ key: nextTextKey(), text: e.text, style: e.style, position: e.position })),
    cta: slide.cta
      ? { enabled: true, type: slide.cta.type, value: slide.cta.value, label: slide.cta.label }
      : { ...EMPTY_CTA },
  };
}

/** Содержательное представление черновика (без ключей) — для сравнения «есть ли изменения». */
function signature(d: SlideDraft): string {
  return JSON.stringify({
    type: d.type,
    mediaAssetId: d.mediaAssetId,
    durationSec: d.type === 'video' ? null : Number(d.durationSec),
    skus: d.type === 'product' ? parseSkus(d.skus) : [],
    texts: d.texts.map((t) => [t.text, t.style, t.position]),
    cta: d.cta.enabled ? [d.cta.type, d.cta.value.trim(), d.cta.label] : null,
  });
}

export function slideSignature(slide: AdminSlide): string {
  return JSON.stringify({
    type: slide.type,
    mediaAssetId: slide.mediaAssetId,
    durationSec: slide.type === 'video' ? null : slide.durationMs / 1000,
    skus: slide.type === 'product' ? slide.productSkus : [],
    texts: slide.elements.filter((e) => e.kind === 'text').map((t) => [t.text, t.style, t.position]),
    cta: slide.cta ? [slide.cta.type, slide.cta.value, slide.cta.label] : null,
  });
}

export function isSlideDraftDirty(draft: SlideDraft, slide: AdminSlide | null): boolean {
  if (!slide) {
    return (
      draft.mediaAssetId !== null ||
      draft.texts.length > 0 ||
      draft.cta.enabled ||
      draft.skus.trim() !== '' ||
      Number(draft.durationSec) !== LIMITS.slideDurationDefaultMs / 1000
    );
  }
  return signature(draft) !== slideSignature(slide);
}

export function parseSkus(value: string): string[] {
  return value
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Клиентская проверка CTA по allowlist — та же функция, что на сервере и в плеере (раздел 10.4). */
export function ctaError(cta: CtaDraft, allowlist: CtaAllowlist | null): string | undefined {
  if (!cta.enabled || !allowlist || cta.value.trim() === '') return undefined;
  const res = checkCta(cta.type, cta.value, allowlist);
  return res.ok ? undefined : CTA_REJECT_MESSAGES[res.reason];
}

function friendlier(errors: FieldErrors): FieldErrors {
  const out: FieldErrors = {};
  for (const [key, message] of Object.entries(errors)) {
    if (key === 'durationMs') out[key] = ru.validation.durationRange;
    else if (key === 'productSkus' || key.startsWith('productSkus.')) out.productSkus ??= ru.validation.skusRange;
    else if (key === 'mediaAssetId') out[key] = ru.validation.mediaRequired;
    else out[key] = message;
  }
  return out;
}

/** Формат SKU — как в схеме `Sku` (@idb-stories/schema). */
const SKU_RE = /^[A-Za-z0-9_-]{1,64}$/;

export type BuiltSlide = { ok: true; body: SlideInput } | { ok: false; errors: FieldErrors };

export function buildSlide(draft: SlideDraft, allowlist: CtaAllowlist | null): BuiltSlide {
  const errors: FieldErrors = {};
  const elements = draft.texts.map((t) => ({ kind: 'text' as const, text: t.text, style: t.style, position: t.position }));
  const cta = draft.cta.enabled ? { type: draft.cta.type, value: draft.cta.value.trim(), label: draft.cta.label } : null;
  const ctaProblem = ctaError(draft.cta, allowlist);
  if (ctaProblem) errors['cta.value'] = ctaProblem;
  const seconds = Number(draft.durationSec.replace(',', '.'));
  const durationMs = Number.isFinite(seconds) ? Math.round(seconds * 1000) : Number.NaN;

  let input: unknown;
  switch (draft.type) {
    case 'image':
      if (!draft.mediaAssetId) errors.mediaAssetId = ru.validation.mediaRequired;
      input = { type: 'image', mediaAssetId: draft.mediaAssetId, durationMs, elements, cta };
      break;
    case 'video':
      if (!draft.mediaAssetId) errors.mediaAssetId = ru.validation.mediaRequired;
      input = { type: 'video', mediaAssetId: draft.mediaAssetId, elements, cta };
      break;
    case 'product': {
      const skus = parseSkus(draft.skus);
      const invalid = skus.find((sku) => !SKU_RE.test(sku));
      if (skus.length < LIMITS.productSkusMin || skus.length > LIMITS.productSkusMax) {
        errors.productSkus = ru.validation.skusRange;
      } else if (new Set(skus).size !== skus.length) {
        errors.productSkus = ru.validation.skusUnique;
      } else if (invalid) {
        errors.productSkus = ru.validation.skuFormat(invalid);
      }
      input = { type: 'product', productSkus: skus, durationMs, elements, cta };
      break;
    }
  }
  const res = validate(SlideInput, input);
  const all = { ...(res.ok ? {} : friendlier(res.errors)), ...errors };
  if (!res.ok || Object.keys(errors).length > 0) return { ok: false, errors: all };
  return { ok: true, body: res.data };
}

/** Коды ошибок сервера, относящиеся к конкретным полям слайда. */
export function slideServerFieldErrors(code: string, message: string): FieldErrors {
  switch (code) {
    case 'cta_not_allowed':
      return { 'cta.value': message };
    case 'media_not_found':
    case 'media_kind_mismatch':
    case 'media_rejected':
      return { mediaAssetId: message };
    default:
      return {};
  }
}
