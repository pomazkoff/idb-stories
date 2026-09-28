import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { isApiError } from '../../api/client.js';
import { api } from '../../api/endpoints.js';
import { latestRevision, qk, storeGroup, useSegments } from '../../api/queries.js';
import type { AdminGroup } from '../../api/types.js';
import { useCan } from '../../auth/session.js';
import { ErrorMessage } from '../../components/ErrorMessage.js';
import { Modal } from '../../components/Modal.js';
import { Loading, Notice, PageHeader, QueryError } from '../../components/Status.js';
import { ru } from '../../i18n/ru.js';
import { useNotice } from '../../lib/hooks.js';
import { formatDateTime } from '../../lib/datetime.js';
import { describeDiff } from '../../lib/diff.js';
import { PreviewPanel } from '../groups/PreviewPanel.js';
import { GroupStatusInfo, WorkflowActions } from '../groups/WorkflowPanel.js';

export function ReviewPage() {
  const { id = '' } = useParams();
  const query = useQuery({ queryKey: qk.group(id), queryFn: ({ signal }) => api.getGroup(id, signal) });

  if (query.isPending) return <Loading label={ru.editor.loading} />;
  if (query.isError) {
    if (isApiError(query.error) && query.error.status === 404) {
      return (
        <div className="card stack">
          <p>{ru.editor.notFound}</p>
          <p>
            <Link to="/review">{ru.review.backToQueue}</Link>
          </p>
        </div>
      );
    }
    return <QueryError error={query.error} onRetry={() => void query.refetch()} />;
  }
  return <Review group={query.data} onReload={() => void query.refetch()} />;
}

function Review({ group, onReload }: { group: AdminGroup; onReload: () => void }) {
  const client = useQueryClient();
  const can = useCan();
  const reasonId = useId();
  const diffTitleId = useId();
  const [rejectOpen, setRejectOpen] = useState(false);
  const [notice, setNotice] = useNotice();
  const { actions } = group;
  const inReview = group.status === 'in_review';

  const approve = useMutation({
    mutationFn: () => api.approve(group.id, latestRevision(client, group.id, group.revision)),
    onMutate: () => setNotice(null),
    onSuccess: (updated) => {
      storeGroup(client, updated);
      setNotice(ru.review.approved);
    },
  });

  const reload = () => {
    approve.reset();
    void client.invalidateQueries({ queryKey: qk.diff(group.id) });
    onReload();
  };

  return (
    <div className="stack">
      <title>{ru.app.pageTitle(ru.review.pageTitle(group.title))}</title>
      <p>
        <Link to="/review">{ru.review.backToQueue}</Link>
      </p>
      <PageHeader title={ru.review.pageTitle(group.title)}>
        <GroupStatusInfo group={group} />
        <ul className="plain-list small">
          {group.submittedBy ? (
            <li>{ru.review.submittedBy(group.submittedBy.name, formatDateTime(group.submittedAt))}</li>
          ) : null}
          {group.lastEditedBy ? <li>{ru.review.lastEditedBy(group.lastEditedBy.name)}</li> : null}
        </ul>
      </PageHeader>

      <section className="card stack">
        {inReview ? (
          <>
            <div className="actions actions--wrap">
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => approve.mutate()}
                disabled={!actions.canApprove || approve.isPending}
                aria-describedby={actions.approveBlockedReason ? reasonId : undefined}
              >
                {approve.isPending ? ru.review.approving : ru.review.approve}
              </button>
              {actions.canReject ? (
                <button type="button" className="btn btn--danger-ghost" onClick={() => setRejectOpen(true)}>
                  {ru.review.reject}
                </button>
              ) : null}
            </div>
            {actions.approveBlockedReason ? (
              <p id={reasonId} className="alert alert--warning">
                {actions.approveBlockedReason}
              </p>
            ) : null}
          </>
        ) : (
          <>
            <p className="muted">{ru.review.notInReview}</p>
            <WorkflowActions group={group} onReload={reload} editorActions={false} reviewLink={false} />
          </>
        )}
        <ErrorMessage error={approve.error} onReload={reload} slideIds={group.slides.map((s) => s.id)} />
        <Notice>{notice}</Notice>
        {!inReview && can('groups:read') ? (
          <p>
            <Link to={`/groups/${group.id}`}>{ru.common.open}</Link>
          </p>
        ) : null}
      </section>

      <div className="editor-layout">
        <section className="card stack editor-main" aria-labelledby={diffTitleId}>
          <h2 id={diffTitleId} className="section-title">
            {ru.review.diffTitle}
          </h2>
          <DiffView group={group} />
        </section>
        <aside className="editor-side">
          <PreviewPanel groupId={group.id} revision={group.revision} placement={group.placement} />
        </aside>
      </div>

      {rejectOpen ? (
        <RejectDialog
          group={group}
          onClose={() => setRejectOpen(false)}
          onDone={() => {
            setRejectOpen(false);
            setNotice(ru.review.rejected);
          }}
          onReload={reload}
        />
      ) : null}
    </div>
  );
}

function DiffView({ group }: { group: AdminGroup }) {
  const can = useCan();
  const diff = useQuery({
    queryKey: [...qk.diff(group.id), group.revision],
    queryFn: ({ signal }) => api.diff(group.id, signal),
  });
  const segments = useSegments(can('segments:read'));

  if (diff.isPending) return <Loading />;
  if (diff.isError) return <QueryError error={diff.error} onRetry={() => void diff.refetch()} />;

  const segmentNames = new Map((segments.data?.items ?? []).map((s) => [s.id, s.name]));
  const rows = describeDiff(diff.data, { slideIds: group.slides.map((s) => s.id), segmentNames });

  return (
    <>
      <p className="muted small">
        {diff.data.baseVersion !== null ? ru.review.diffBase(diff.data.baseVersion) : ru.review.diffFirst}
      </p>
      {rows.length === 0 ? (
        <p>{ru.review.diffEmpty}</p>
      ) : (
        <div className="table-wrap">
          <table className="table table--diff">
            <caption className="sr-only">{ru.review.diffTitle}</caption>
            <thead>
              <tr>
                <th scope="col">{ru.review.colField}</th>
                <th scope="col">{ru.review.colBefore}</th>
                <th scope="col">{ru.review.colAfter}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key} className={`diff-row diff-row--${row.kind}`}>
                  <th scope="row">{row.label}</th>
                  <td className="diff-before pre-line">{row.before}</td>
                  <td className="diff-after pre-line">{row.after}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function RejectDialog({
  group,
  onClose,
  onDone,
  onReload,
}: {
  group: AdminGroup;
  onClose: () => void;
  onDone: () => void;
  onReload: () => void;
}) {
  const client = useQueryClient();
  const id = useId();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [comment, setComment] = useState('');
  const [error, setError] = useNotice();

  const reject = useMutation({
    mutationFn: () => api.reject(group.id, latestRevision(client, group.id, group.revision), comment.trim()),
    onSuccess: (updated) => {
      storeGroup(client, updated);
      onDone();
    },
  });

  const confirm = () => {
    if (!comment.trim()) {
      setError(ru.review.commentRequired);
      textareaRef.current?.focus();
      return;
    }
    setError(null);
    reject.mutate();
  };

  return (
    <Modal
      title={ru.review.rejectTitle}
      onClose={onClose}
      busy={reject.isPending}
      initialFocusRef={textareaRef}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={reject.isPending}>
            {ru.common.cancel}
          </button>
          <button type="button" className="btn btn--danger" onClick={confirm} disabled={reject.isPending}>
            {reject.isPending ? ru.review.rejecting : ru.review.rejectConfirm}
          </button>
        </>
      }
    >
      <div className="field">
        <label className="field__label" htmlFor={`${id}-comment`}>
          {ru.review.rejectComment}
        </label>
        <p id={`${id}-hint`} className="field__hint">
          {ru.review.rejectCommentHint}
        </p>
        <textarea
          ref={textareaRef}
          id={`${id}-comment`}
          value={comment}
          rows={5}
          maxLength={1000}
          required
          aria-required="true"
          aria-invalid={error ? true : undefined}
          aria-describedby={`${id}-hint${error ? ` ${id}-error` : ''}`}
          onChange={(e) => setComment(e.target.value)}
        />
        <span className="counter">{ru.common.chars(comment.length, 1000)}</span>
        {error ? (
          <p id={`${id}-error`} className="field__error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
      <ErrorMessage error={reject.error} onReload={onReload} />
    </Modal>
  );
}
