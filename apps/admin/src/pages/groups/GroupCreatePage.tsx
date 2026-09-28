import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { api } from '../../api/endpoints.js';
import { storeGroup } from '../../api/queries.js';
import type { GroupCreateInput } from '../../api/types.js';
import { ErrorMessage } from '../../components/ErrorMessage.js';
import { PageHeader } from '../../components/Status.js';
import { ru } from '../../i18n/ru.js';
import { serverFieldErrors, type FieldErrors } from '../../lib/validation.js';
import { MetaForm } from './MetaForm.js';
import { buildCreate, newGroupDraft, type MetaDraft } from './metaDraft.js';

/** Шаг 1 создания группы: параметры и обложка. Слайды добавляются в редакторе. */
export function GroupCreatePage() {
  const navigate = useNavigate();
  const client = useQueryClient();
  const [draft, setDraft] = useState<MetaDraft>(() => newGroupDraft());
  const [errors, setErrors] = useState<FieldErrors>({});
  const [coverBusy, setCoverBusy] = useState(false);

  const create = useMutation({
    mutationFn: (body: GroupCreateInput) => api.createGroup(body),
    onSuccess: (group) => {
      storeGroup(client, group);
      void navigate(`/groups/${group.id}`, { replace: true });
    },
    onError: (error) => setErrors(serverFieldErrors(error)),
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (coverBusy) return;
    const built = buildCreate(draft);
    if (!built.ok) {
      setErrors(built.errors);
      return;
    }
    setErrors({});
    create.mutate(built.body);
  };

  const hasErrors = Object.keys(errors).length > 0;

  return (
    <div className="stack">
      <title>{ru.app.pageTitle(ru.meta.createTitle)}</title>
      <p>
        <Link to="/groups">{ru.editor.backToList}</Link>
      </p>
      <PageHeader title={ru.meta.createTitle}>
        <p className="muted">{ru.meta.createIntro}</p>
      </PageHeader>
      <form className="card stack" onSubmit={submit} noValidate>
        <MetaForm
          draft={draft}
          onChange={(patch) => setDraft((d) => ({ ...d, ...patch }))}
          errors={errors}
          disabled={create.isPending}
          onCoverBusyChange={setCoverBusy}
        />
        {hasErrors && !create.isError ? (
          <p className="field__error" role="alert">
            {ru.errors.fixFields}
          </p>
        ) : null}
        <ErrorMessage error={create.error} hideFieldList={hasErrors} />
        <div className="actions">
          <button type="submit" className="btn btn--primary" disabled={create.isPending || coverBusy}>
            {create.isPending ? ru.meta.creating : ru.meta.createButton}
          </button>
          {coverBusy ? <span className="muted small">{ru.meta.coverUploading}</span> : null}
        </div>
      </form>
    </div>
  );
}
