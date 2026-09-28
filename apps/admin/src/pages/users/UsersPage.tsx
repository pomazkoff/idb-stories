import { ROLES, type Role } from '@idb-stories/schema';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../api/endpoints.js';
import { qk } from '../../api/queries.js';
import type { AdminUserDto } from '../../api/types.js';
import { useCan, useMe } from '../../auth/session.js';
import { ErrorMessage } from '../../components/ErrorMessage.js';
import { Loading, PageHeader, QueryError } from '../../components/Status.js';
import { ru } from '../../i18n/ru.js';
import { formatDateTime } from '../../lib/datetime.js';

/** Пользователи и роли (администратор). Свои роли и статус менять нельзя — сервер вернёт 409. */
export function UsersPage() {
  const users = useQuery({ queryKey: qk.users, queryFn: ({ signal }) => api.users(signal) });

  return (
    <div className="stack">
      <title>{ru.app.pageTitle(ru.users.title)}</title>
      <PageHeader title={ru.users.title}>
        <p className="muted">{ru.users.intro}</p>
      </PageHeader>
      {users.isPending ? (
        <Loading />
      ) : users.isError ? (
        <QueryError error={users.error} onRetry={() => void users.refetch()} />
      ) : users.data.items.length === 0 ? (
        <p className="empty">{ru.users.empty}</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <caption className="sr-only">{ru.users.caption}</caption>
            <thead>
              <tr>
                <th scope="col">{ru.users.colName}</th>
                <th scope="col">{ru.users.colRoles}</th>
                <th scope="col">{ru.users.colStatus}</th>
                <th scope="col">{ru.users.colLastLogin}</th>
                <th scope="col">{ru.users.colActions}</th>
              </tr>
            </thead>
            <tbody>
              {users.data.items.map((user) => (
                <UserRow key={user.id} user={user} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function UserRow({ user }: { user: AdminUserDto }) {
  const me = useMe();
  const can = useCan();
  const client = useQueryClient();
  const [error, setError] = useState<unknown>(null);
  const self = user.id === me.user.id;
  const editable = can('users:write') && !self;

  const replaceUser = (updated: AdminUserDto) => {
    setError(null);
    client.setQueryData<{ items: AdminUserDto[] }>(qk.users, (old) =>
      old ? { items: old.items.map((u) => (u.id === updated.id ? updated : u)) } : old,
    );
  };

  const roles = useMutation({
    mutationFn: (next: Role[]) => api.setUserRoles(user.id, next),
    onSuccess: replaceUser,
    onError: (e) => setError(e),
  });
  const status = useMutation({
    mutationFn: (disabled: boolean) => api.setUserStatus(user.id, disabled),
    onSuccess: replaceUser,
    onError: (e) => setError(e),
  });
  const busy = roles.isPending || status.isPending;

  const toggleRole = (role: Role, on: boolean) => {
    const next = on ? ROLES.filter((r) => r === role || user.roles.includes(r)) : user.roles.filter((r) => r !== role);
    roles.mutate(next);
  };

  return (
    <tr className={user.disabled ? 'row--muted' : undefined}>
      <th scope="row">
        <div>{user.name}</div>
        <div className="muted small">{user.email}</div>
        {self ? <div className="badge badge--info">{ru.users.you}</div> : null}
      </th>
      <td>
        <fieldset className="role-checks" disabled={!editable || busy}>
          <legend className="sr-only">{ru.users.colRoles}</legend>
          {ROLES.map((role) => (
            <label key={role} className="checkbox">
              <input
                type="checkbox"
                checked={user.roles.includes(role)}
                onChange={(e) => toggleRole(role, e.target.checked)}
                aria-label={ru.users.roleFor(ru.labels.role[role], user.name)}
              />
              <span aria-hidden="true">{ru.labels.role[role]}</span>
            </label>
          ))}
        </fieldset>
        {self ? <p className="field__hint">{ru.users.selfHint}</p> : null}
        <ErrorMessage error={error} />
      </td>
      <td>{user.disabled ? ru.users.disabled : ru.users.active}</td>
      <td className="small">{user.lastLoginAt ? formatDateTime(user.lastLoginAt) : ru.users.never}</td>
      <td>
        {editable ? (
          <button
            type="button"
            className={user.disabled ? 'btn btn--small' : 'btn btn--small btn--danger-ghost'}
            onClick={() => status.mutate(!user.disabled)}
            disabled={busy}
          >
            {user.disabled ? ru.users.unblock : ru.users.block}
          </button>
        ) : null}
      </td>
    </tr>
  );
}
