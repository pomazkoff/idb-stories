import type { RouteObject } from 'react-router';
import { AppLayout, HomeRedirect, RequirePermission } from './components/Layout.js';
import { AuditLogPage } from './pages/audit/AuditLogPage.js';
import { GroupCreatePage } from './pages/groups/GroupCreatePage.js';
import { GroupEditorPage } from './pages/groups/GroupEditorPage.js';
import { GroupsListPage } from './pages/groups/GroupsListPage.js';
import { LoginPage } from './pages/LoginPage.js';
import { NotFoundPage, RouteErrorPage } from './pages/NotFoundPage.js';
import { ReviewPage } from './pages/review/ReviewPage.js';
import { ReviewQueuePage } from './pages/review/ReviewQueuePage.js';
import { SettingsPage } from './pages/settings/SettingsPage.js';
import { StatsPage } from './pages/stats/StatsPage.js';
import { UsersPage } from './pages/users/UsersPage.js';

/**
 * Маршруты админки. Каждый раздел закрыт правом из матрицы PERMISSIONS — это только скрытие,
 * права проверяет сервер на каждом эндпоинте.
 */
export function createRoutes(): RouteObject[] {
  return [
    { path: '/login', element: <LoginPage />, errorElement: <RouteErrorPage /> },
    {
      path: '/',
      element: <AppLayout />,
      errorElement: <RouteErrorPage />,
      children: [
        { index: true, element: <HomeRedirect /> },
        {
          path: 'groups',
          element: (
            <RequirePermission permission="groups:read">
              <GroupsListPage />
            </RequirePermission>
          ),
        },
        {
          path: 'groups/new',
          element: (
            <RequirePermission permission="groups:write">
              <GroupCreatePage />
            </RequirePermission>
          ),
        },
        {
          path: 'groups/:id',
          element: (
            <RequirePermission permission="groups:read">
              <GroupEditorPage />
            </RequirePermission>
          ),
        },
        {
          path: 'groups/:id/stats',
          element: (
            <RequirePermission permission="stats:read">
              <StatsPage />
            </RequirePermission>
          ),
        },
        {
          path: 'review',
          element: (
            <RequirePermission permission="groups:review">
              <ReviewQueuePage />
            </RequirePermission>
          ),
        },
        {
          path: 'review/:id',
          element: (
            <RequirePermission permission="groups:review">
              <ReviewPage />
            </RequirePermission>
          ),
        },
        {
          path: 'audit',
          element: (
            <RequirePermission permission="audit:read">
              <AuditLogPage />
            </RequirePermission>
          ),
        },
        {
          path: 'users',
          element: (
            <RequirePermission permission="users:read">
              <UsersPage />
            </RequirePermission>
          ),
        },
        {
          path: 'settings',
          element: (
            <RequirePermission permission="settings:read">
              <SettingsPage />
            </RequirePermission>
          ),
        },
        { path: '*', element: <NotFoundPage /> },
      ],
    },
  ];
}
