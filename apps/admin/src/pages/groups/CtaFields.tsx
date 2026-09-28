import { CTA_TYPES, LIMITS, type CtaType } from '@idb-stories/schema';
import { useId, useState } from 'react';
import type { CtaAllowlist } from '../../api/types.js';
import { ru } from '../../i18n/ru.js';
import { ctaError, type CtaDraft } from './slideDraft.js';

export interface CtaFieldsProps {
  value: CtaDraft;
  onChange: (next: CtaDraft) => void;
  allowlist: CtaAllowlist | null;
  disabled: boolean;
  /** Ошибки с сервера или общей проверки формы: `cta.value`, `cta.label`, `cta`. */
  errors: Record<string, string>;
}

function placeholder(type: CtaType, allowlist: CtaAllowlist | null): string {
  switch (type) {
    case 'deeplink':
      return ru.cta.placeholders.deeplink(allowlist?.deeplinkSchemes[0] ?? 'idb');
    case 'url':
      return ru.cta.placeholders.url(allowlist?.urlDomains[0] ?? 'iledebeaute.ru');
    case 'product':
      return ru.cta.placeholders.product;
    case 'category':
      return ru.cta.placeholders.category;
  }
}

/**
 * Кнопка CTA: тип только из допустимых (deeplink, product, category, url), значение сразу
 * проверяется по allowlist (checkCta из @idb-stories/schema) — та же проверка повторится на сервере.
 */
export function CtaFields({ value, onChange, allowlist, disabled, errors }: CtaFieldsProps) {
  const id = useId();
  const [touched, setTouched] = useState(false);
  const liveError = touched ? ctaError(value, allowlist) : undefined;
  const valueError = liveError ?? errors['cta.value'] ?? errors.cta;
  const labelError = errors['cta.label'];
  const set = (patch: Partial<CtaDraft>) => onChange({ ...value, ...patch });

  return (
    <fieldset className="fieldset cta-fields">
      <legend className="field__label">{ru.cta.title}</legend>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={value.enabled}
          onChange={(e) => set({ enabled: e.target.checked })}
          disabled={disabled}
        />
        <span>{ru.cta.enable}</span>
      </label>
      {value.enabled ? (
        <div className="form-grid">
          <div className="field">
            <label className="field__label" htmlFor={`${id}-type`}>
              {ru.cta.type}
            </label>
            <select
              id={`${id}-type`}
              value={value.type}
              onChange={(e) => set({ type: e.target.value as CtaType })}
              disabled={disabled}
            >
              {CTA_TYPES.map((t) => (
                <option key={t} value={t}>
                  {ru.labels.ctaType[t]}
                </option>
              ))}
            </select>
          </div>
          <div className="field field--wide">
            <label className="field__label" htmlFor={`${id}-value`}>
              {ru.cta.value}
            </label>
            <input
              id={`${id}-value`}
              type="text"
              value={value.value}
              placeholder={placeholder(value.type, allowlist)}
              maxLength={2048}
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => {
                setTouched(true);
                set({ value: e.target.value });
              }}
              onBlur={() => setTouched(true)}
              disabled={disabled}
              aria-invalid={valueError ? true : undefined}
              aria-describedby={`${id}-hint${valueError ? ` ${id}-value-error` : ''}`}
            />
            <p id={`${id}-hint`} className="field__hint">
              {allowlist
                ? ru.cta.allowlistHint(allowlist.deeplinkSchemes.join(', '), allowlist.urlDomains.join(', '))
                : ru.cta.allowlistUnavailable}
            </p>
            {valueError ? (
              <p id={`${id}-value-error`} className="field__error" role="alert">
                {valueError}
              </p>
            ) : null}
          </div>
          <div className="field">
            <label className="field__label" htmlFor={`${id}-label`}>
              {ru.cta.label}
            </label>
            <div className="input-with-counter">
              <input
                id={`${id}-label`}
                type="text"
                value={value.label}
                maxLength={LIMITS.ctaLabelMax}
                placeholder={ru.cta.labelPlaceholder}
                onChange={(e) => set({ label: e.target.value })}
                disabled={disabled}
                aria-invalid={labelError ? true : undefined}
                aria-describedby={`${id}-label-count${labelError ? ` ${id}-label-error` : ''}`}
              />
              <span id={`${id}-label-count`} className="counter">
                {ru.common.chars(value.label.length, LIMITS.ctaLabelMax)}
              </span>
            </div>
            {labelError ? (
              <p id={`${id}-label-error`} className="field__error">
                {labelError}
              </p>
            ) : null}
          </div>
        </div>
      ) : null}
    </fieldset>
  );
}
