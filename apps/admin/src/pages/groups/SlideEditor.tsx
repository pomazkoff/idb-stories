import { LIMITS, TEXT_POSITIONS, TEXT_STYLES } from '@idb-stories/schema';
import { useEffect, useId, useRef, type FormEvent } from 'react';
import type { CtaAllowlist } from '../../api/types.js';
import { useCan } from '../../auth/session.js';
import { ErrorMessage } from '../../components/ErrorMessage.js';
import { Notice } from '../../components/Status.js';
import { MediaAssetStatus, MediaUpload } from '../../components/MediaUpload.js';
import { ru } from '../../i18n/ru.js';
import type { FieldErrors } from '../../lib/validation.js';
import { CtaFields } from './CtaFields.js';
import {
  newTextDraft,
  parseSkus,
  type SlideDraft,
  type TextDraft,
  type TextPosition,
  type TextStyle,
} from './slideDraft.js';

export interface SlideEditorProps {
  title: string;
  draft: SlideDraft;
  onChange: (patch: Partial<SlideDraft>) => void;
  errors: FieldErrors;
  allowlist: CtaAllowlist | null;
  readOnly: boolean;
  isNew: boolean;
  dirty: boolean;
  saving: boolean;
  saveError: unknown;
  mediaBusy: boolean;
  onMediaBusyChange: (busy: boolean) => void;
  onSave: () => void;
  onCancel: () => void;
  onDelete?: (() => void) | undefined;
  slideIds: readonly string[];
  /** Увеличивается, когда пользователь выбрал слайд, — фокус переходит в редактор. */
  focusTick: number;
  notice: string | null;
}

/** Редактор слайда: медиа, длительность, тексты (до 3), товары, CTA. */
export function SlideEditor({
  title,
  draft,
  onChange,
  errors,
  allowlist,
  readOnly,
  isNew,
  dirty,
  saving,
  saveError,
  mediaBusy,
  onMediaBusyChange,
  onSave,
  onCancel,
  onDelete,
  slideIds,
  focusTick,
  notice,
}: SlideEditorProps) {
  const can = useCan();
  const id = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (focusTick > 0) headingRef.current?.focus();
  }, [focusTick]);
  const disabled = readOnly || saving;
  const headingId = `${id}-heading`;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!mediaBusy) onSave();
  };

  const setText = (index: number, patch: Partial<TextDraft>) =>
    onChange({ texts: draft.texts.map((t, i) => (i === index ? { ...t, ...patch } : t)) });

  const skuCount = parseSkus(draft.skus).length;

  return (
    <form className="card stack slide-editor" onSubmit={submit} aria-labelledby={headingId} noValidate>
      <h3 id={headingId} ref={headingRef} className="section-title" tabIndex={-1}>
        {title}
      </h3>

      {draft.type === 'image' || draft.type === 'video' ? (
        can('media:write') && !readOnly ? (
          <MediaUpload
            label={draft.type === 'image' ? ru.slides.mediaImage : ru.slides.mediaVideo}
            hint={draft.type === 'image' ? ru.slides.mediaImageHint : ru.slides.mediaVideoHint}
            kind={draft.type}
            purpose="slide"
            assetId={draft.mediaAssetId}
            onUploaded={(asset) => onChange({ mediaAssetId: asset.id })}
            onBusyChange={onMediaBusyChange}
            disabled={saving}
            error={errors.mediaAssetId}
            testId="slide-media-upload"
          />
        ) : draft.mediaAssetId && can('media:read') ? (
          <MediaAssetStatus assetId={draft.mediaAssetId} />
        ) : null
      ) : (
        <div className="field">
          <label className="field__label" htmlFor={`${id}-skus`}>
            {ru.slides.skusLabel}
          </label>
          <input
            id={`${id}-skus`}
            type="text"
            value={draft.skus}
            onChange={(e) => onChange({ skus: e.target.value })}
            disabled={disabled}
            spellCheck={false}
            autoComplete="off"
            aria-invalid={errors.productSkus ? true : undefined}
            aria-describedby={`${id}-skus-hint${errors.productSkus ? ` ${id}-skus-error` : ''}`}
          />
          <p id={`${id}-skus-hint`} className="field__hint">
            {ru.slides.skusHint} {ru.slides.skusCount(skuCount)}
          </p>
          {errors.productSkus ? (
            <p id={`${id}-skus-error`} className="field__error">
              {errors.productSkus}
            </p>
          ) : null}
        </div>
      )}

      {draft.type !== 'video' ? (
        <div className="field field--narrow">
          <label className="field__label" htmlFor={`${id}-duration`}>
            {ru.slides.duration}
          </label>
          <input
            id={`${id}-duration`}
            type="number"
            min={LIMITS.slideDurationMinMs / 1000}
            max={LIMITS.slideDurationMaxMs / 1000}
            step={1}
            value={draft.durationSec}
            onChange={(e) => onChange({ durationSec: e.target.value })}
            disabled={disabled}
            aria-invalid={errors.durationMs ? true : undefined}
            aria-describedby={`${id}-duration-hint${errors.durationMs ? ` ${id}-duration-error` : ''}`}
          />
          <p id={`${id}-duration-hint`} className="field__hint">
            {ru.slides.durationHint}
          </p>
          {errors.durationMs ? (
            <p id={`${id}-duration-error`} className="field__error">
              {errors.durationMs}
            </p>
          ) : null}
        </div>
      ) : null}

      <fieldset className="fieldset">
        <legend className="field__label">{ru.slides.textsTitle}</legend>
        <p className="field__hint">{ru.slides.textsHint}</p>
        <ol className="texts">
          {draft.texts.map((t, index) => {
            const n = index + 1;
            const textError = errors[`elements.${index}.text`];
            return (
              <li key={t.key} className="texts__item">
                <div className="field field--wide">
                  <label className="field__label" htmlFor={`${id}-text-${t.key}`}>
                    {ru.slides.textLabel(n)}
                  </label>
                  <textarea
                    id={`${id}-text-${t.key}`}
                    value={t.text}
                    rows={2}
                    maxLength={LIMITS.textElementMax}
                    onChange={(e) => setText(index, { text: e.target.value })}
                    disabled={disabled}
                    aria-invalid={textError ? true : undefined}
                    aria-describedby={`${id}-text-${t.key}-count${textError ? ` ${id}-text-${t.key}-error` : ''}`}
                  />
                  <span id={`${id}-text-${t.key}-count`} className="counter">
                    {ru.common.chars(t.text.length, LIMITS.textElementMax)}
                  </span>
                  {textError ? (
                    <p id={`${id}-text-${t.key}-error`} className="field__error">
                      {textError}
                    </p>
                  ) : null}
                </div>
                <div className="texts__options">
                  <div className="field">
                    <label className="field__label field__label--small" htmlFor={`${id}-style-${t.key}`}>
                      {ru.slides.textStyle(n)}
                    </label>
                    <select
                      id={`${id}-style-${t.key}`}
                      value={t.style}
                      onChange={(e) => setText(index, { style: e.target.value as TextStyle })}
                      disabled={disabled}
                    >
                      {TEXT_STYLES.map((s) => (
                        <option key={s} value={s}>
                          {ru.labels.textStyle[s]}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="field">
                    <label className="field__label field__label--small" htmlFor={`${id}-pos-${t.key}`}>
                      {ru.slides.textPosition(n)}
                    </label>
                    <select
                      id={`${id}-pos-${t.key}`}
                      value={t.position}
                      onChange={(e) => setText(index, { position: e.target.value as TextPosition })}
                      disabled={disabled}
                    >
                      {TEXT_POSITIONS.map((p) => (
                        <option key={p} value={p}>
                          {ru.labels.textPosition[p]}
                        </option>
                      ))}
                    </select>
                  </div>
                  {!readOnly ? (
                    <button
                      type="button"
                      className="btn btn--ghost btn--small"
                      onClick={() => onChange({ texts: draft.texts.filter((_, i) => i !== index) })}
                      disabled={disabled}
                    >
                      {ru.slides.removeText(n)}
                    </button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ol>
        {!readOnly ? (
          <button
            type="button"
            className="btn btn--small"
            onClick={() => onChange({ texts: [...draft.texts, newTextDraft()] })}
            disabled={disabled || draft.texts.length >= LIMITS.elementsPerSlideMax}
          >
            {ru.slides.addText}
          </button>
        ) : null}
      </fieldset>

      <CtaFields
        value={draft.cta}
        onChange={(cta) => onChange({ cta })}
        allowlist={allowlist}
        disabled={disabled}
        errors={errors}
      />

      <ErrorMessage error={saveError} slideIds={slideIds} />
      <Notice>{notice}</Notice>

      {!readOnly ? (
        <div className="actions">
          <button type="submit" className="btn btn--primary" disabled={saving || mediaBusy || (!isNew && !dirty)}>
            {saving ? ru.common.saving : isNew ? ru.slides.create : ru.slides.save}
          </button>
          {isNew || dirty ? (
            <button type="button" className="btn" onClick={onCancel} disabled={saving}>
              {isNew ? ru.slides.closeNew : ru.slides.cancel}
            </button>
          ) : null}
          {onDelete ? (
            <button type="button" className="btn btn--danger-ghost" onClick={onDelete} disabled={saving}>
              {ru.slides.delete}
            </button>
          ) : null}
          {mediaBusy ? <span className="muted small">{ru.slides.waitUpload}</span> : null}
        </div>
      ) : null}
    </form>
  );
}
