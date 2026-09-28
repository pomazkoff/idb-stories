import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { api } from '../../api/endpoints.js';
import { latestRevision, qk, storeGroup } from '../../api/queries.js';
import type { AdminGroup } from '../../api/types.js';
import { useCan } from '../../auth/session.js';
import { ScheduleBadge, StatusBadge } from '../../components/Badges.js';
import { ConfirmDialog } from '../../components/ConfirmDialog.js';
import { ErrorMessage } from '../../components/ErrorMessage.js';
import { Notice } from '../../components/Status.js';
import { ru } from '../../i18n/ru.js';
import { useNotice } from '../../lib/hooks.js';
import { formatDateTime } from '../../lib/datetime.js';

/** Статус группы, версии, комментарий согласующего. */
export function GroupStatusInfo({ group }: { group: AdminGroup }) {
  return (
    <div className="stack stack--tight">
      <div className="badges">
        <StatusBadge status={group.status} />
        <ScheduleBadge schedule={group.schedule} />
        <span className="muted small">{ru.editor.revision(group.revision)}</span>
      </div>
      <ul className="plain-list small">
        {group.liveVersion !== null ? <li>{ru.editor.liveVersion(group.liveVersion)}</li> : null}
        {group.pendingVersion !== null ? <li>{ru.editor.pendingVersion(group.pendingVersion)}</li> : null}
        {group.liveVersion === null && group.pendingVersion === null ? <li>{ru.editor.noVersions}</li> : null}
      </ul>
      {group.status === 'rejected' && group.reviewComment ? (
        <div className="alert alert--warning">
          <p className="alert__title">{ru.editor.rejectedTitle}</p>
          <p className="alert__text pre-line">{group.reviewComment}</p>
          <p className="alert__meta">
            {ru.editor.rejectedBy(group.reviewedBy?.name ?? ru.common.dash, formatDateTime(group.reviewedAt))}
          </p>
        </div>
      ) : null}
    </div>
  );
}

type Dialog = 'delete' | 'publish' | 'unpublish' | null;

export interface WorkflowActionsProps {
  group: AdminGroup;
  /** Есть несохранённые изменения — отправлять нельзя. */
  dirty?: boolean;
  onReload: () => void;
  /** Показывать действия редактора (отправка, дублирование, удаление). */
  editorActions?: boolean;
  /** Показывать ссылку на экран согласования. */
  reviewLink?: boolean;
}

/** Кнопки по флагам `actions`, которые сервер вычисляет с учётом прав и правила четырёх глаз. */
export function WorkflowActions({
  group,
  dirty = false,
  onReload,
  editorActions = true,
  reviewLink = true,
}: WorkflowActionsProps) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const can = useCan();
  const reasonId = useId();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [reason, setReason] = useState('');
  const [notice, setNotice] = useNotice();
  const { actions } = group;

  const onGroup = (message: string) => (updated: AdminGroup) => {
    storeGroup(client, updated);
    setDialog(null);
    setNotice(message);
  };

  const submit = useMutation({
    mutationFn: () => api.submit(group.id, latestRevision(client, group.id, group.revision)),
    onMutate: () => setNotice(null),
    onSuccess: onGroup(ru.workflow.submitted),
  });
  const duplicate = useMutation({
    mutationFn: () => api.duplicateGroup(group.id),
    onSuccess: (copy) => {
      storeGroup(client, copy);
      void navigate(`/groups/${copy.id}`);
    },
  });
  const remove = useMutation({
    mutationFn: () => api.deleteGroup(group.id),
    onSuccess: () => {
      client.removeQueries({ queryKey: qk.group(group.id) });
      void client.invalidateQueries({ queryKey: qk.groups });
      void navigate('/groups', { replace: true });
    },
  });
  const publish = useMutation({
    mutationFn: () => api.publish(group.id),
    onSuccess: onGroup(ru.workflow.published),
  });
  const unpublish = useMutation({
    mutationFn: () => api.unpublish(group.id, reason.trim() || null),
    onSuccess: onGroup(ru.workflow.unpublished),
  });

  const deletable =
    actions.canEdit &&
    (group.status === 'draft' || group.status === 'rejected') &&
    group.liveVersion === null &&
    group.pendingVersion === null;
  const showReviewLink = reviewLink && can('groups:review') && group.status === 'in_review';
  const inlineError = submit.error ?? duplicate.error;
  const slideIds = group.slides.map((s) => s.id);

  const closeDialog = () => {
    setDialog(null);
    publish.reset();
    unpublish.reset();
    remove.reset();
  };

  return (
    <div className="stack">
      <div className="actions actions--wrap">
        {editorActions && actions.canSubmit ? (
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => submit.mutate()}
            disabled={submit.isPending || dirty}
            aria-describedby={dirty ? reasonId : undefined}
          >
            {submit.isPending ? ru.workflow.submitting : ru.workflow.submit}
          </button>
        ) : null}
        {showReviewLink ? (
          <Link className="btn btn--primary" to={`/review/${group.id}`}>
            {ru.workflow.goReview}
          </Link>
        ) : null}
        {actions.canPublish ? (
          <button type="button" className="btn" onClick={() => setDialog('publish')}>
            {ru.workflow.publish}
          </button>
        ) : null}
        {actions.canUnpublish ? (
          <button type="button" className="btn btn--danger-ghost" onClick={() => setDialog('unpublish')}>
            {ru.workflow.unpublish}
          </button>
        ) : null}
        {editorActions && actions.canEdit ? (
          <button type="button" className="btn" onClick={() => duplicate.mutate()} disabled={duplicate.isPending}>
            {duplicate.isPending ? ru.workflow.duplicating : ru.workflow.duplicate}
          </button>
        ) : null}
        {editorActions && deletable ? (
          <button type="button" className="btn btn--danger-ghost" onClick={() => setDialog('delete')}>
            {ru.workflow.delete}
          </button>
        ) : null}
        {can('stats:read') ? (
          <Link className="btn btn--ghost" to={`/groups/${group.id}/stats`}>
            {ru.workflow.stats}
          </Link>
        ) : null}
      </div>
      {dirty && editorActions && actions.canSubmit ? (
        <p id={reasonId} className="muted small">
          {ru.workflow.submitDirty}
        </p>
      ) : null}
      <Notice>{notice}</Notice>
      <ErrorMessage error={inlineError} onReload={onReload} slideIds={slideIds} />

      {dialog === 'delete' ? (
        <ConfirmDialog
          title={ru.workflow.deleteTitle}
          confirmLabel={ru.common.delete}
          danger
          pending={remove.isPending}
          error={remove.error}
          onConfirm={() => remove.mutate()}
          onCancel={closeDialog}
        >
          <p>{ru.workflow.deleteText}</p>
        </ConfirmDialog>
      ) : null}
      {dialog === 'publish' ? (
        <ConfirmDialog
          title={ru.workflow.publishTitle}
          confirmLabel={ru.workflow.publish}
          pending={publish.isPending}
          error={publish.error}
          onConfirm={() => publish.mutate()}
          onCancel={closeDialog}
          onReload={onReload}
        >
          <p>{ru.workflow.publishText}</p>
        </ConfirmDialog>
      ) : null}
      {dialog === 'unpublish' ? (
        <ConfirmDialog
          title={ru.workflow.unpublishTitle}
          confirmLabel={ru.workflow.unpublish}
          danger
          pending={unpublish.isPending}
          error={unpublish.error}
          onConfirm={() => unpublish.mutate()}
          onCancel={closeDialog}
        >
          <p>{ru.workflow.unpublishText}</p>
          <div className="field">
            <label className="field__label" htmlFor={`${reasonId}-reason`}>
              {ru.workflow.unpublishReason}
            </label>
            <textarea
              id={`${reasonId}-reason`}
              value={reason}
              maxLength={500}
              rows={3}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
