import { LIMITS, PLACEMENTS, PLATFORMS, type Placement, type Platform } from '@idb-stories/schema';
import { useId, useState } from 'react';
import { useSegments } from '../../api/queries.js';
import { useCan } from '../../auth/session.js';
import { MediaAssetStatus, MediaUpload } from '../../components/MediaUpload.js';
import { ru } from '../../i18n/ru.js';
import { timeZoneName } from '../../lib/datetime.js';
import { errorFor, type FieldErrors } from '../../lib/validation.js';
import type { MetaDraft } from './metaDraft.js';

export interface MetaFormProps {
  draft: MetaDraft;
  onChange: (patch: Partial<MetaDraft>) => void;
  errors: FieldErrors;
  disabled: boolean;
  onCoverBusyChange?: (busy: boolean) => void;
}

function FieldError({ id, message }: { id: string; message: string | undefined }) {
  if (!message) return null;
  return (
    <p id={id} className="field__error">
      {message}
    </p>
  );
}

/** Метаданные и таргетинг группы (раздел 4.1). Время вводится в часовом поясе редактора. */
export function MetaForm({ draft, onChange, errors, disabled, onCoverBusyChange }: MetaFormProps) {
  const can = useCan();
  const id = useId();
  const f = (name: string) => `${id}-${name}`;
  const err = (key: string) => errorFor(errors, key);
  const described = (key: string, hint?: boolean) =>
    [hint ? f(`${key}-hint`) : null, err(key) ? f(`${key}-error`) : null].filter(Boolean).join(' ') || undefined;

  const togglePlatform = (p: Platform, on: boolean) =>
    onChange({ platforms: on ? PLATFORMS.filter((x) => x === p || draft.platforms.includes(x)) : draft.platforms.filter((x) => x !== p) });

  return (
    <div className="form-grid">
      <div className="field field--wide">
        <label className="field__label" htmlFor={f('title')}>
          {ru.meta.title}
        </label>
        <p id={f('title-hint')} className="field__hint">
          {ru.meta.titleHint}
        </p>
        <div className="input-with-counter">
          <input
            id={f('title')}
            type="text"
            value={draft.title}
            maxLength={LIMITS.groupTitleMax}
            onChange={(e) => onChange({ title: e.target.value })}
            disabled={disabled}
            required
            aria-invalid={err('title') ? true : undefined}
            aria-describedby={[described('title', true), f('title-count')].filter(Boolean).join(' ')}
          />
          <span id={f('title-count')} className="counter" aria-live="polite">
            {ru.common.chars(draft.title.length, LIMITS.groupTitleMax)}
          </span>
        </div>
        <FieldError id={f('title-error')} message={err('title')} />
      </div>

      <div className="field">
        <label className="field__label" htmlFor={f('placement')}>
          {ru.meta.placement}
        </label>
        <select
          id={f('placement')}
          value={draft.placement}
          onChange={(e) => onChange({ placement: e.target.value as Placement })}
          disabled={disabled}
          aria-describedby={described('placement')}
        >
          {PLACEMENTS.map((p) => (
            <option key={p} value={p}>
              {ru.labels.placement[p]}
            </option>
          ))}
        </select>
        <FieldError id={f('placement-error')} message={err('placement')} />
      </div>

      <div className="field">
        <label className="field__label" htmlFor={f('priority')}>
          {ru.meta.priority}
        </label>
        <input
          id={f('priority')}
          type="number"
          inputMode="numeric"
          step={1}
          min={-1000}
          max={1000}
          value={draft.priority}
          onChange={(e) => onChange({ priority: e.target.value })}
          disabled={disabled}
          aria-invalid={err('priority') ? true : undefined}
          aria-describedby={described('priority', true)}
        />
        <p id={f('priority-hint')} className="field__hint">
          {ru.meta.priorityHint}
        </p>
        <FieldError id={f('priority-error')} message={err('priority')} />
      </div>

      <div className="field">
        <label className="field__label" htmlFor={f('start')}>
          {ru.meta.startAt}
        </label>
        <input
          id={f('start')}
          type="datetime-local"
          value={draft.start}
          onChange={(e) => onChange({ start: e.target.value })}
          disabled={disabled}
          required
          aria-invalid={err('startAt') ? true : undefined}
          aria-describedby={[f('tz'), err('startAt') ? f('startAt-error') : null].filter(Boolean).join(' ')}
        />
        <FieldError id={f('startAt-error')} message={err('startAt')} />
      </div>

      <div className="field">
        <label className="field__label" htmlFor={f('end')}>
          {ru.meta.endAt}
        </label>
        <input
          id={f('end')}
          type="datetime-local"
          value={draft.end}
          onChange={(e) => onChange({ end: e.target.value })}
          disabled={disabled}
          required
          aria-invalid={err('endAt') ? true : undefined}
          aria-describedby={[f('tz'), err('endAt') ? f('endAt-error') : null].filter(Boolean).join(' ')}
        />
        <FieldError id={f('endAt-error')} message={err('endAt')} />
      </div>
      <p id={f('tz')} className="field__hint field--wide">
        {ru.meta.timezoneHint(timeZoneName())}
      </p>

      <fieldset className="field fieldset" aria-describedby={err('platforms') ? f('platforms-error') : undefined}>
        <legend className="field__label">{ru.meta.platforms}</legend>
        <div className="checkbox-row">
          {PLATFORMS.map((p) => (
            <label key={p} className="checkbox">
              <input
                type="checkbox"
                checked={draft.platforms.includes(p)}
                onChange={(e) => togglePlatform(p, e.target.checked)}
                disabled={disabled}
              />
              <span>{ru.labels.platform[p]}</span>
            </label>
          ))}
        </div>
        <FieldError id={f('platforms-error')} message={err('platforms')} />
      </fieldset>

      <fieldset className="field fieldset">
        <legend className="field__label">{ru.meta.minVersions}</legend>
        <p id={f('ver-hint')} className="field__hint">
          {ru.meta.minVersionsHint}
        </p>
        <div className="input-pair">
          <div>
            <label className="field__label field__label--small" htmlFor={f('ios')}>
              {ru.meta.minIos}
            </label>
            <input
              id={f('ios')}
              type="text"
              inputMode="decimal"
              value={draft.minIos}
              placeholder={ru.meta.versionPlaceholder}
              maxLength={14}
              onChange={(e) => onChange({ minIos: e.target.value })}
              disabled={disabled || !draft.platforms.includes('ios')}
              aria-invalid={err('minAppVersion.ios') ? true : undefined}
              aria-describedby={[f('ver-hint'), err('minAppVersion.ios') ? f('ios-error') : null].filter(Boolean).join(' ')}
            />
            <FieldError id={f('ios-error')} message={err('minAppVersion.ios')} />
          </div>
          <div>
            <label className="field__label field__label--small" htmlFor={f('android')}>
              {ru.meta.minAndroid}
            </label>
            <input
              id={f('android')}
              type="text"
              inputMode="decimal"
              value={draft.minAndroid}
              placeholder={ru.meta.versionPlaceholder}
              maxLength={14}
              onChange={(e) => onChange({ minAndroid: e.target.value })}
              disabled={disabled || !draft.platforms.includes('android')}
              aria-invalid={err('minAppVersion.android') ? true : undefined}
              aria-describedby={[f('ver-hint'), err('minAppVersion.android') ? f('android-error') : null]
                .filter(Boolean)
                .join(' ')}
            />
            <FieldError id={f('android-error')} message={err('minAppVersion.android')} />
          </div>
        </div>
      </fieldset>

      {can('segments:read') ? (
        <SegmentsField
          selected={draft.segmentIds}
          onChange={(segmentIds) => onChange({ segmentIds })}
          disabled={disabled}
          error={err('segmentIds')}
        />
      ) : null}

      <div className="field field--wide">
        <p className="field__label" aria-hidden="true">
          {ru.meta.cover}
        </p>
        {can('media:write') && !disabled ? (
          <MediaUpload
            label={ru.meta.coverFile}
            hint={ru.meta.coverHint}
            kind="image"
            purpose="cover"
            assetId={draft.coverAssetId}
            onUploaded={(asset) => onChange({ coverAssetId: asset.id })}
            onBusyChange={onCoverBusyChange}
            error={err('coverAssetId')}
            testId="cover-upload"
          />
        ) : (
          <CoverReadOnly assetId={draft.coverAssetId} />
        )}
      </div>
    </div>
  );
}

function CoverReadOnly({ assetId }: { assetId: string | null }) {
  const can = useCan();
  if (!assetId) return <p className="muted">{ru.media.noFile}</p>;
  if (!can('media:read')) return null;
  return <MediaAssetStatus assetId={assetId} />;
}

interface SegmentsFieldProps {
  selected: string[];
  onChange: (ids: string[]) => void;
  disabled: boolean;
  error: string | undefined;
}

function SegmentsField({ selected, onChange, disabled, error }: SegmentsFieldProps) {
  const segments = useSegments();
  const id = useId();
  const [filter, setFilter] = useState('');
  const items = segments.data?.items ?? [];
  const needle = filter.trim().toLowerCase();
  const visible = needle ? items.filter((s) => s.name.toLowerCase().includes(needle) || selected.includes(s.id)) : items;
  const toggle = (segmentId: string, on: boolean) =>
    onChange(on ? [...selected, segmentId] : selected.filter((x) => x !== segmentId));

  return (
    <fieldset className="field fieldset field--wide" aria-describedby={`${id}-hint`}>
      <legend className="field__label">{ru.meta.segments}</legend>
      <p id={`${id}-hint`} className="field__hint">
        {ru.meta.segmentsHint} {ru.meta.segmentsSelected(selected.length)}
      </p>
      {segments.isError ? (
        <p className="field__error">{ru.meta.segmentsUnavailable}</p>
      ) : items.length === 0 && !segments.isPending ? (
        <p className="muted">{ru.meta.segmentsEmpty}</p>
      ) : (
        <>
          {items.length > 8 ? (
            <div className="segments__filter">
              <label className="field__label field__label--small" htmlFor={`${id}-filter`}>
                {ru.meta.segmentsFilter}
              </label>
              <input id={`${id}-filter`} type="search" value={filter} onChange={(e) => setFilter(e.target.value)} />
            </div>
          ) : null}
          <div className="segments">
            {visible.map((s) => (
              <label key={s.id} className="checkbox">
                <input
                  type="checkbox"
                  checked={selected.includes(s.id)}
                  onChange={(e) => toggle(s.id, e.target.checked)}
                  disabled={disabled}
                />
                <span>{s.name}</span>
              </label>
            ))}
          </div>
        </>
      )}
      {error ? <p className="field__error">{error}</p> : null}
    </fieldset>
  );
}
