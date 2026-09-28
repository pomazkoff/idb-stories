import type { Permission, Role } from '@idb-stories/schema';
import { useMutation } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { NavLink, Navigate, Outlet } from 'react-router';
import { isApiError } from '../api/client.js';
import { api } from '../api/endpoints.js';
import type { Me } from '../api/types.js';
import { MeProvider, hasPerm, useMe, useMeQuery } from '../auth/session.js';
import { ru } from '../i18n/ru.js';
import { Loading, QueryError } from './Status.js';

export interface NavItem {
  to: string;
  label: string;
  permission: Permission;
}

/** Разделы админки. Показываются только разрешённые (права проверяет сервер, здесь — скрытие). */
export const NAV_ITEMS: readonly NavItem[] = [
  { to: '/groups', label: ru.nav.groups, permission: 'groups:read' },
  { to: '/review', label: ru.nav.review, permission: 'groups:review' },
  { to: '/audit', label: ru.nav.audit, permission: 'audit:read' },
  { to: '/users', label: ru.nav.users, permission: 'users:read' },
  { to: '/settings', label: ru.nav.settings, permission: 'settings:read' },
];

export function visibleNav(me: Me): NavItem[] {
  return NAV_ITEMS.filter((item) => hasPerm(me, item.permission));
}

function goToLogin() {
  window.location.assign('/login');
}

function LogoutButton() {
  const logout = useMutation({
    mutationFn: () => api.logout(),
    // Выход завершаем в любом случае: полный переход сбрасывает состояние SPA и кеш запросов.
    onSettled: goToLogin,
  });
  return (
    <button type="button" className="btn btn--ghost" onClick={() => logout.mutate()} disabled={logout.isPending}>
      {logout.isPending ? ru.nav.loggingOut : ru.nav.logout}
    </button>
  );
}

function UserBox({ me }: { me: Me }) {
  const roles = me.user.roles.map((r: Role) => ru.labels.role[r]).join(', ') || ru.nav.noRoles;
  return (
    <div className="userbox">
      <div className="userbox__info">
        <span className="userbox__name">{me.user.name}</span>
        <span className="userbox__roles">{ru.nav.userRoles(roles)}</span>
      </div>
      <LogoutButton />
    </div>
  );
}

export function NoAccessScreen({ me }: { me: Me }) {
  return (
    <div className="center-screen">
      <title>{ru.app.pageTitle(ru.auth.noAccessTitle)}</title>
      <div className="card card--narrow stack">
        <h1 className="page-title">{ru.auth.noAccessTitle}</h1>
        <p>{ru.auth.noAccessText}</p>
        <UserBox me={me} />
      </div>
    </div>
  );
}

/** Корневой макет: загружает /auth/me, показывает навигацию по правам. */
export function AppLayout() {
  const meQuery = useMeQuery();

  if (meQuery.isPending) {
    return (
      <div className="center-screen">
        <Loading />
      </div>
    );
  }
  if (meQuery.isError) {
    const unauthorized = isApiError(meQuery.error) && meQuery.error.status === 401;
    return (
      <div className="center-screen">
        {unauthorized ? (
          <Loading label={ru.auth.redirecting} />
        ) : (
          <div className="card card--narrow stack">
            <p>{ru.auth.meFailed}</p>
            <QueryError error={meQuery.error} onRetry={() => void meQuery.refetch()} />
          </div>
        )}
      </div>
    );
  }

  const me = meQuery.data;
  if (me.permissions.length === 0) return <NoAccessScreen me={me} />;

  return (
    <MeProvider me={me}>
      <a className="skip-link" href="#main">
        {ru.app.skipToContent}
      </a>
      <header className="topbar">
        <div className="topbar__inner">
          <span className="brand">{ru.app.name}</span>
          <nav aria-label={ru.nav.label} className="nav">
            <ul className="nav__list">
              {visibleNav(me).map((item) => (
                <li key={item.to}>
                  <NavLink to={item.to} className={({ isActive }) => (isActive ? 'nav__link nav__link--active' : 'nav__link')}>
                    {item.label}
                  </NavLink>
                </li>
              ))}
            </ul>
          </nav>
          <UserBox me={me} />
        </div>
      </header>
      <main id="main" className="main" tabIndex={-1}>
        <Outlet />
      </main>
    </MeProvider>
  );
}

/** Главная: первый доступный раздел. */
export function HomeRedirect() {
  const me = useMe();
  const first = visibleNav(me)[0];
  return <Navigate to={first ? first.to : '/settings'} replace />;
}

/** Раздел только для пользователей с правом `permission`. */
export function RequirePermission({ permission, children }: { permission: Permission; children: ReactNode }) {
  const me = useMe();
  if (!hasPerm(me, permission)) {
    return (
      <div className="card stack">
        <title>{ru.app.pageTitle(ru.auth.noAccessTitle)}</title>
        <h1 className="page-title">{ru.auth.noAccessTitle}</h1>
        <p>{ru.auth.sectionNoAccess}</p>
      </div>
    );
  }
  return <>{children}</>;
}
