import type { Role } from './common.js';

/**
 * Матрица прав (раздел 2, 10.3) — единая таблица для сервера и админки.
 * Сервер проверяет права на каждом эндпоинте по этой таблице; админка использует её
 * только чтобы скрывать недоступные действия. Покрыта тестами на все пары роль × действие.
 *
 * Правило «четырёх глаз» (кто может согласовать конкретную группу) — отдельная проверка
 * поверх матрицы: см. apps/api/src/services/workflow.ts.
 */
export const PERMISSIONS = {
  'groups:read': ['editor', 'publisher', 'analyst', 'admin'],
  'groups:write': ['editor'],
  'groups:submit': ['editor'],
  'groups:review': ['publisher'],
  'groups:publish': ['publisher'],
  // Администратор может снять группу при инциденте (kill switch отдельной группы, 10.8).
  'groups:unpublish': ['publisher', 'admin'],
  'media:read': ['editor', 'publisher', 'analyst'],
  'media:write': ['editor'],
  'segments:read': ['editor', 'publisher', 'analyst'],
  'catalog:read': ['editor', 'publisher', 'analyst'],
  'stats:read': ['editor', 'publisher', 'analyst'],
  'audit:read': ['admin'],
  'users:read': ['admin'],
  'users:write': ['admin'],
  'settings:read': ['editor', 'publisher', 'analyst', 'admin'],
  'settings:write': ['admin'],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

export const PERMISSION_NAMES = Object.keys(PERMISSIONS) as Permission[];

export function hasPermission(roles: readonly Role[], permission: Permission): boolean {
  const allowed: readonly Role[] = PERMISSIONS[permission];
  return roles.some((r) => allowed.includes(r));
}

export function permissionsOf(roles: readonly Role[]): Permission[] {
  return PERMISSION_NAMES.filter((p) => hasPermission(roles, p));
}
