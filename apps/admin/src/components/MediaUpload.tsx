import type { MediaKind, MediaPurpose } from '@idb-stories/schema';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState, type ChangeEvent } from 'react';
import { isAbortError } from '../api/client.js';
import { qk, useMediaAsset } from '../api/queries.js';
import type { AdminMediaAsset } from '../api/types.js';
import { acceptAttribute, uploadMedia, type UploadPhase } from '../api/upload.js';
import { ru } from '../i18n/ru.js';
import { MediaStatusBadge } from './Badges.js';
import { errorText } from './ErrorMessage.js';

type UploadState =
  | { phase: 'idle' }
  | { phase: UploadPhase; progress: number }
  | { phase: 'error'; message: string };

export interface MediaUploadProps {
  label: string;
  hint?: string;
  kind: MediaKind;
  purpose: MediaPurpose;
  assetId: string | null;
  onUploaded: (asset: AdminMediaAsset) => void;
  onBusyChange?: (busy: boolean) => void;
  disabled?: boolean;
  /** Ошибка поля из валидации формы. */
  error?: string | undefined;
  /** Метка для e2e-тестов. */
  testId?: string;
}

/**
 * Загрузка файла с прогрессом (XHR PUT в quarantine) и статусом обработки воркером.
 * Отклонённый файл показывается с причиной от воркера.
 */
export function MediaUpload({
  label,
  hint,
  kind,
  purpose,
  assetId,
  onUploaded,
  onBusyChange,
  disabled = false,
  error,
  testId,
}: MediaUploadProps) {
  const inputId = useId();
  const hintId = useId();
  const errorId = useId();
  const client = useQueryClient();
  const abortRef = useRef<AbortController | null>(null);
  const [state, setState] = useState<UploadState>({ phase: 'idle' });

  useEffect(() => () => abortRef.current?.abort(), []);

  const busy = state.phase === 'preparing' || state.phase === 'uploading' || state.phase === 'finishing';

  async function start(file: File) {
    const controller = new AbortController();
    abortRef.current = controller;
    setState({ phase: 'preparing', progress: 0 });
    onBusyChange?.(true);
    try {
      const asset = await uploadMedia(file, kind, purpose, {
        signal: controller.signal,
        onPhase: (phase) => setState((s) => ({ phase, progress: 'progress' in s ? s.progress : 0 })),
        onProgress: (fraction) => setState({ phase: 'uploading', progress: fraction }),
      });
      client.setQueryData(qk.media(asset.id), asset);
      setState({ phase: 'idle' });
      onUploaded(asset);
    } catch (err) {
      setState({ phase: 'error', message: isAbortError(err) ? ru.media.uploadCancelled : errorText(err) });
    } finally {
      abortRef.current = null;
      onBusyChange?.(false);
    }
  }

  function onChange(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    // Сбрасываем выбор, чтобы тот же файл можно было выбрать повторно после ошибки.
    input.value = '';
    if (file) void start(file);
  }

  const localError = state.phase === 'error' ? state.message : undefined;
  const shownError = localError ?? error;
  const pct = 'progress' in state ? Math.round(state.progress * 100) : 0;
  const describedBy = [hint ? hintId : null, shownError ? errorId : null].filter(Boolean).join(' ') || undefined;

  return (
    <div className="media-upload" data-testid={testId}>
      <label className="field__label" htmlFor={inputId}>
        {label}
      </label>
      {hint ? (
        <p id={hintId} className="field__hint">
          {hint}
        </p>
      ) : null}
      <input
        id={inputId}
        type="file"
        className="media-upload__input"
        accept={acceptAttribute(kind)}
        onChange={onChange}
        disabled={disabled || busy}
        aria-describedby={describedBy}
        aria-invalid={shownError ? true : undefined}
      />
      {busy ? (
        <div className="media-upload__progress">
          <progress max={100} value={state.phase === 'uploading' ? pct : undefined} aria-label={ru.media.uploading(pct)} />
          <span role="status">
            {state.phase === 'preparing'
              ? ru.media.preparing
              : state.phase === 'finishing'
                ? ru.media.finishing
                : ru.media.uploading(pct)}
          </span>
          <button type="button" className="btn btn--small" onClick={() => abortRef.current?.abort()}>
            {ru.media.cancelUpload}
          </button>
        </div>
      ) : null}
      {shownError ? (
        <p id={errorId} className="field__error" role="alert">
          {shownError}
        </p>
      ) : null}
      {assetId ? <MediaAssetStatus assetId={assetId} testId={testId ? `${testId}-status` : undefined} /> : null}
    </div>
  );
}

function pickPreview(asset: AdminMediaAsset): { url: string; w: number; h: number } | null {
  if (asset.kind === 'video') return asset.poster;
  const images = [...asset.previews].filter((p) => p.mime.startsWith('image/')).sort((a, b) => a.w - b.w);
  return images.find((p) => p.w >= 200) ?? images[images.length - 1] ?? null;
}

/** Статус обработки и миниатюра готового файла (подписанный URL, TTL 15 минут). */
export function MediaAssetStatus({ assetId, testId }: { assetId: string; testId?: string | undefined }) {
  const media = useMediaAsset(assetId);
  if (media.isPending) {
    return (
      <p className="media-status" data-testid={testId}>
        {ru.app.loading}
      </p>
    );
  }
  if (media.isError) {
    return (
      <p className="media-status field__error" data-testid={testId}>
        {errorText(media.error)}
      </p>
    );
  }
  const asset = media.data;
  const preview = asset.status === 'ready' ? pickPreview(asset) : null;
  return (
    <div className="media-status">
      {preview ? (
        <img
          className="media-status__thumb"
          src={preview.url}
          alt={ru.media.preview}
          width={Math.round((preview.w / preview.h) * 96)}
          height={96}
          referrerPolicy="no-referrer"
        />
      ) : null}
      <div className="media-status__info">
        <span role="status" aria-live="polite" data-testid={testId} data-status={asset.status}>
          <MediaStatusBadge status={asset.status} />
        </span>
        {asset.status === 'rejected' ? (
          <p className="field__error">{asset.rejectReason ? ru.media.rejected(asset.rejectReason) : ru.media.rejectedNoReason}</p>
        ) : null}
        {asset.status === 'ready' && asset.width && asset.height ? (
          <span className="muted small">
            {ru.media.size(asset.width, asset.height)}
            {asset.durationMs ? `, ${ru.media.duration(Math.round(asset.durationMs / 100) / 10)}` : ''}
          </span>
        ) : null}
      </div>
    </div>
  );
}
