import { LIMITS, type SlideType } from '@idb-stories/schema';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState, type FormEvent } from 'react';
import { Link, useBlocker, useParams } from 'react-router';
import { isApiError } from '../../api/client.js';
import { api } from '../../api/endpoints.js';
import { latestRevision, qk, storeGroup, useSettings } from '../../api/queries.js';
import type { AdminGroup, GroupUpdateInput, SlideInput } from '../../api/types.js';
import { ConfirmDialog } from '../../components/ConfirmDialog.js';
import { ErrorMessage } from '../../components/ErrorMessage.js';
import { Loading, Notice, PageHeader, QueryError } from '../../components/Status.js';
import { ru } from '../../i18n/ru.js';
import { useNotice } from '../../lib/hooks.js';
import { serverFieldErrors, type FieldErrors } from '../../lib/validation.js';
import { MetaForm } from './MetaForm.js';
import { buildUpdate, draftFromGroup, isDirty, type MetaDraft } from './metaDraft.js';
import { PreviewPanel } from './PreviewPanel.js';
import { SlideEditor } from './SlideEditor.js';
import { SlidesList } from './SlidesList.js';
import {
  buildSlide,
  draftFromSlide,
  isSlideDraftDirty,
  newSlideDraft,
  slideServerFieldErrors,
  type SlideDraft,
} from './slideDraft.js';
import { GroupStatusInfo, WorkflowActions } from './WorkflowPanel.js';

export function GroupEditorPage() {
  const { id = '' } = useParams();
  const [formKey, setFormKey] = useState(0);
  const query = useQuery({ queryKey: qk.group(id), queryFn: ({ signal }) => api.getGroup(id, signal) });

  // После конфликта ревизий: перечитать группу и заново инициализировать формы.
  const reload = () => {
    void query.refetch().then(() => setFormKey((k) => k + 1));
  };

  if (query.isPending) return <Loading label={ru.editor.loading} />;
  if (query.isError) {
    if (isApiError(query.error) && query.error.status === 404) {
      return (
        <div className="card stack">
          <p>{ru.editor.notFound}</p>
          <p>
            <Link to="/groups">{ru.editor.backToList}</Link>
          </p>
        </div>
      );
    }
    return <QueryError error={query.error} onRetry={() => void query.refetch()} />;
  }
  return <GroupEditor key={`${id}:${formKey}`} group={query.data} onReload={reload} />;
}

type Selection = { kind: 'none' } | { kind: 'new'; type: SlideType } | { kind: 'edit'; slideId: string };

/** Поля черновика слайда → ключи ошибок, которые нужно сбросить при их изменении. */
const ERROR_KEYS: Record<keyof SlideDraft, string> = {
  type: 'type',
  mediaAssetId: 'mediaAssetId',
  durationSec: 'durationMs',
  skus: 'productSkus',
  texts: 'elements',
  cta: 'cta',
};

function withoutKeys(errors: FieldErrors, prefixes: string[]): FieldErrors {
  return Object.fromEntries(
    Object.entries(errors).filter(([k]) => !prefixes.some((p) => k === p || k.startsWith(`${p}.`))),
  );
}

function initialSelection(group: AdminGroup): Selection {
  const first = group.slides[0];
  return first ? { kind: 'edit', slideId: first.id } : { kind: 'none' };
}

function draftFor(selection: Selection, group: AdminGroup): SlideDraft | null {
  if (selection.kind === 'new') return newSlideDraft(selection.type);
  if (selection.kind === 'edit') {
    const slide = group.slides.find((s) => s.id === selection.slideId);
    return slide ? draftFromSlide(slide) : null;
  }
  return null;
}

function GroupEditor({ group, onReload }: { group: AdminGroup; onReload: () => void }) {
  const client = useQueryClient();
  const ids = { meta: useId(), slides: useId(), workflow: useId() };
  const readOnly = !group.actions.canEdit;
  const settings = useSettings();
  const allowlist = settings.data?.ctaAllowlist ?? null;

  // --- Параметры группы -----------------------------------------------------
  const metaBase = draftFromGroup(group);
  const [meta, setMeta] = useState<MetaDraft>(() => draftFromGroup(group));
  const [metaErrors, setMetaErrors] = useState<FieldErrors>({});
  const [metaNotice, setMetaNotice] = useNotice();
  const [coverBusy, setCoverBusy] = useState(false);
  const metaDirty = isDirty(meta, metaBase);

  const saveMeta = useMutation({
    mutationFn: (body: GroupUpdateInput) => api.updateGroup(group.id, body),
    onMutate: () => setMetaNotice(null),
    onSuccess: (updated) => {
      storeGroup(client, updated);
      setMeta(draftFromGroup(updated));
      setMetaErrors({});
      setMetaNotice(ru.meta.saved);
    },
    onError: (error) => setMetaErrors(serverFieldErrors(error)),
  });

  const submitMeta = (event: FormEvent) => {
    event.preventDefault();
    if (coverBusy || !metaDirty) return;
    const built = buildUpdate(meta, metaBase, latestRevision(client, group.id, group.revision));
    if (!built.ok) {
      setMetaErrors(built.errors);
      return;
    }
    setMetaErrors({});
    saveMeta.mutate(built.body);
  };

  // --- Слайды ---------------------------------------------------------------
  const [selection, setSelection] = useState<Selection>(() => initialSelection(group));
  const [slideDraft, setSlideDraft] = useState<SlideDraft | null>(() => draftFor(initialSelection(group), group));
  const [slideErrors, setSlideErrors] = useState<FieldErrors>({});
  const [slideError, setSlideError] = useState<unknown>(null);
  const [slideNotice, setSlideNotice] = useNotice();
  const [mediaBusy, setMediaBusy] = useState(false);
  const [pendingSelection, setPendingSelection] = useState<Selection | null>(null);
  const [confirmDeleteSlide, setConfirmDeleteSlide] = useState(false);
  const [localOrder, setLocalOrder] = useState<string[] | null>(null);
  const [focusTick, setFocusTick] = useState(0);

  const selectedSlide = selection.kind === 'edit' ? (group.slides.find((s) => s.id === selection.slideId) ?? null) : null;
  const editing = selection.kind === 'new' || (selection.kind === 'edit' && selectedSlide !== null);
  const slideDirty = editing && slideDraft !== null && isSlideDraftDirty(slideDraft, selectedSlide);
  const slideIds = group.slides.map((s) => s.id);

  const applySelection = (next: Selection, source: AdminGroup = group) => {
    setSelection(next);
    setSlideDraft(draftFor(next, source));
    setSlideErrors({});
    setSlideError(null);
    setSlideNotice(null);
    setMediaBusy(false);
  };

  const requestSelection = (next: Selection) => {
    setFocusTick((t) => t + 1);
    if (slideDirty) setPendingSelection(next);
    else applySelection(next);
  };

  const saveSlide = useMutation({
    mutationFn: ({ body, slideId }: { body: SlideInput; slideId: string | null }) =>
      slideId ? api.updateSlide(group.id, slideId, body) : api.createSlide(group.id, body),
    onMutate: () => {
      setSlideError(null);
      setSlideNotice(null);
    },
    onSuccess: (updated, { slideId }) => {
      const before = new Set(group.slides.map((s) => s.id));
      storeGroup(client, updated);
      const targetId = slideId ?? updated.slides.find((s) => !before.has(s.id))?.id ?? null;
      applySelection(targetId ? { kind: 'edit', slideId: targetId } : { kind: 'none' }, updated);
      setSlideNotice(ru.slides.savedNote);
    },
    onError: (error) => {
      const fields = isApiError(error)
        ? { ...serverFieldErrors(error), ...slideServerFieldErrors(error.code, error.message) }
        : {};
      setSlideErrors(fields);
      const shownAtField = isApiError(error) && Object.keys(slideServerFieldErrors(error.code, error.message)).length > 0;
      setSlideError(shownAtField ? null : error);
    },
  });

  const onSaveSlide = () => {
    if (!slideDraft) return;
    const built = buildSlide(slideDraft, allowlist);
    if (!built.ok) {
      setSlideErrors(built.errors);
      return;
    }
    setSlideErrors({});
    saveSlide.mutate({ body: built.body, slideId: selection.kind === 'edit' ? selection.slideId : null });
  };

  const deleteSlide = useMutation({
    mutationFn: (slideId: string) => api.deleteSlide(group.id, slideId),
    onSuccess: (updated) => {
      storeGroup(client, updated);
      setConfirmDeleteSlide(false);
      const first = updated.slides[0];
      applySelection(first ? { kind: 'edit', slideId: first.id } : { kind: 'none' }, updated);
    },
  });

  const reorder = useMutation({
    mutationFn: (order: string[]) => api.reorderSlides(group.id, latestRevision(client, group.id, group.revision), order),
    onMutate: (order) => setLocalOrder(order),
    onSuccess: (updated) => storeGroup(client, updated),
    onSettled: () => setLocalOrder(null),
  });

  const slides = localOrder
    ? localOrder.flatMap((sid) => group.slides.filter((s) => s.id === sid))
    : group.slides;
  const canAdd = !readOnly && group.slides.length < LIMITS.slidesPerGroupMax;
  const selectedNumber = selectedSlide ? slideIds.indexOf(selectedSlide.id) + 1 : 0;

  // --- Несохранённые изменения ---------------------------------------------
  const dirty = metaDirty || slideDirty || coverBusy || mediaBusy;
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) => dirty && currentLocation.pathname !== nextLocation.pathname,
  );

  const statusNote = readOnly
    ? ru.editor.readOnly
    : group.status === 'in_review'
      ? ru.editor.inReview
      : group.status === 'approved' || group.status === 'published' || group.status === 'archived'
        ? ru.editor.editResetsStatus
        : null;

  return (
    <div className="stack">
      <title>{ru.app.pageTitle(group.title)}</title>
      <p>
        <Link to="/groups">{ru.editor.backToList}</Link>
      </p>
      <PageHeader title={group.title}>
        <GroupStatusInfo group={group} />
      </PageHeader>
      {statusNote ? <p className="alert alert--info">{statusNote}</p> : null}

      <section className="card stack" aria-labelledby={ids.workflow}>
        <h2 id={ids.workflow} className="section-title">
          {ru.workflow.title}
        </h2>
        <WorkflowActions group={group} dirty={metaDirty || slideDirty} onReload={onReload} />
      </section>

      <div className="editor-layout">
        <div className="editor-main stack">
          <section className="card stack" aria-labelledby={ids.meta}>
            <h2 id={ids.meta} className="section-title">
              {ru.meta.sectionTitle}
            </h2>
            <form className="stack" onSubmit={submitMeta} noValidate>
              <MetaForm
                draft={meta}
                onChange={(patch) => {
                  setMeta((d) => ({ ...d, ...patch }));
                  setMetaNotice(null);
                }}
                errors={metaErrors}
                disabled={readOnly || saveMeta.isPending}
                onCoverBusyChange={setCoverBusy}
              />
              <ErrorMessage error={saveMeta.error} onReload={onReload} />
              {!readOnly ? (
                <div className="actions">
                  <button
                    type="submit"
                    className="btn btn--primary"
                    disabled={!metaDirty || saveMeta.isPending || coverBusy}
                  >
                    {saveMeta.isPending ? ru.common.saving : ru.meta.saveButton}
                  </button>
                  {metaDirty ? (
                    <>
                      <button
                        type="button"
                        className="btn"
                        onClick={() => {
                          setMeta(draftFromGroup(group));
                          setMetaErrors({});
                        }}
                        disabled={saveMeta.isPending}
                      >
                        {ru.meta.discard}
                      </button>
                      <span className="muted small">{ru.meta.unsaved}</span>
                    </>
                  ) : null}
                </div>
              ) : null}
              <Notice>{metaNotice}</Notice>
            </form>
          </section>

          <section className="card stack" aria-labelledby={ids.slides}>
            <div className="section-head">
              <h2 id={ids.slides} className="section-title">
                {ru.slides.sectionTitle}{' '}
                <span className="muted">
                  {group.slides.length} / {LIMITS.slidesPerGroupMax}
                </span>
              </h2>
            </div>
            {slides.length === 0 ? (
              <p className="muted">{ru.slides.empty}</p>
            ) : (
              <>
                <SlidesList
                  slides={slides}
                  selectedId={selection.kind === 'edit' ? selection.slideId : null}
                  onSelect={(slideId) => requestSelection({ kind: 'edit', slideId })}
                  onReorder={(order) => reorder.mutate(order)}
                  editable={!readOnly}
                  busy={reorder.isPending}
                />
                {!readOnly && slides.length > 1 ? <p className="field__hint">{ru.slides.reorderHint}</p> : null}
                {reorder.isPending ? (
                  <p className="muted small" role="status">
                    {ru.slides.reordering}
                  </p>
                ) : null}
                <ErrorMessage error={reorder.error} onReload={onReload} />
              </>
            )}
            {!readOnly ? (
              <div className="actions actions--wrap" role="group" aria-label={ru.slides.addGroup}>
                {(['image', 'video', 'product'] as const).map((type) => (
                  <button
                    key={type}
                    type="button"
                    className="btn"
                    onClick={() => requestSelection({ kind: 'new', type })}
                    disabled={!canAdd}
                  >
                    {type === 'image' ? ru.slides.addImage : type === 'video' ? ru.slides.addVideo : ru.slides.addProduct}
                  </button>
                ))}
                {!canAdd ? <span className="muted small">{ru.slides.limitReached}</span> : null}
              </div>
            ) : null}
          </section>

          {editing && slideDraft ? (
            <SlideEditor
              key={selection.kind === 'edit' ? selection.slideId : `new-${selection.kind === 'new' ? selection.type : ''}`}
              focusTick={focusTick}
              title={
                selection.kind === 'new'
                  ? ru.slides.newTitle(ru.labels.slideType[selection.type])
                  : ru.slides.editTitle(selectedNumber, ru.labels.slideType[slideDraft.type])
              }
              draft={slideDraft}
              onChange={(patch) => {
                setSlideDraft((d) => (d ? { ...d, ...patch } : d));
                setSlideNotice(null);
                const keys = Object.keys(patch) as (keyof SlideDraft)[];
                setSlideErrors((e) => withoutKeys(e, keys.map((k) => ERROR_KEYS[k])));
              }}
              errors={slideErrors}
              allowlist={allowlist}
              readOnly={readOnly}
              isNew={selection.kind === 'new'}
              dirty={slideDirty}
              saving={saveSlide.isPending}
              saveError={slideError}
              notice={slideNotice}
              mediaBusy={mediaBusy}
              onMediaBusyChange={setMediaBusy}
              onSave={onSaveSlide}
              onCancel={() =>
                applySelection(selection.kind === 'new' ? initialSelection(group) : selection)
              }
              onDelete={selection.kind === 'edit' && !readOnly ? () => setConfirmDeleteSlide(true) : undefined}
              slideIds={slideIds}
            />
          ) : slides.length > 0 ? (
            <p className="muted">{ru.slides.selectPrompt}</p>
          ) : null}
        </div>

        <aside className="editor-side">
          <PreviewPanel groupId={group.id} revision={group.revision} placement={group.placement} />
        </aside>
      </div>

      {pendingSelection ? (
        <ConfirmDialog
          title={ru.slides.discardTitle}
          confirmLabel={ru.slides.discardConfirm}
          danger
          onConfirm={() => {
            applySelection(pendingSelection);
            setPendingSelection(null);
          }}
          onCancel={() => setPendingSelection(null)}
        >
          <p>{ru.slides.discardText}</p>
        </ConfirmDialog>
      ) : null}

      {confirmDeleteSlide && selection.kind === 'edit' ? (
        <ConfirmDialog
          title={ru.slides.deleteTitle}
          confirmLabel={ru.slides.delete}
          danger
          pending={deleteSlide.isPending}
          error={deleteSlide.error}
          onConfirm={() => deleteSlide.mutate(selection.slideId)}
          onCancel={() => {
            setConfirmDeleteSlide(false);
            deleteSlide.reset();
          }}
        >
          <p>{ru.slides.deleteText(selectedNumber)}</p>
        </ConfirmDialog>
      ) : null}

      {blocker.state === 'blocked' ? (
        <ConfirmDialog
          title={ru.common.unsavedTitle}
          confirmLabel={ru.common.unsavedLeave}
          danger
          onConfirm={() => blocker.proceed()}
          onCancel={() => blocker.reset()}
        >
          <p>{ru.common.unsavedText}</p>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
