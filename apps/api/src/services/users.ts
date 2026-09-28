import { writeAudit, type AuditContext } from '@idb-stories/core';
import type { Role } from '@idb-stories/schema';
import type { SessionStore } from '../auth/session.js';
import type { AppDeps } from '../context.js';
import { conflict, notFound } from '../http/errors.js';
import type { Actor } from '../http/routes.js';
import { toUserDto } from './mappers.js';

/**
 * Пользователи и роли (раздел 2). Защиты от эскалации: нельзя менять собственные роли
 * и статус, нельзя оставить систему без активного администратора.
 */
export class UsersService {
  constructor(
    private readonly deps: AppDeps,
    private readonly sessions: SessionStore,
  ) {}

  async list() {
    const users = await this.deps.prisma.adminUser.findMany({
      include: { roles: true },
      orderBy: { name: 'asc' },
    });
    return { items: users.map(toUserDto) };
  }

  async setRoles(id: string, roles: Role[], actor: Actor, audit: AuditContext) {
    if (id === actor.id) throw conflict('Нельзя менять собственные роли', 'self_modification');
    const user = await this.deps.prisma.$transaction(async (tx) => {
      const existing = await tx.adminUser.findUnique({ where: { id }, include: { roles: true } });
      if (!existing) throw notFound('Пользователь не найден');
      const before = existing.roles.map((r) => r.role).sort();
      const after = [...roles].sort();
      if (before.includes('admin') && !after.includes('admin')) await this.assertOtherAdmin(tx, id);
      await tx.userRole.deleteMany({ where: { userId: id, role: { notIn: roles } } });
      for (const role of roles) {
        await tx.userRole.upsert({
          where: { userId_role: { userId: id, role } },
          create: { userId: id, role, grantedById: actor.id },
          update: {},
        });
      }
      await writeAudit(tx, audit, {
        action: 'user.roles_changed',
        entityType: 'user',
        entityId: id,
        diff: { before, after },
      });
      return tx.adminUser.findUniqueOrThrow({ where: { id }, include: { roles: true } });
    });
    this.deps.security.emit('roles.changed', {
      actorId: actor.id,
      ip: audit.ip ?? null,
      requestId: audit.requestId ?? null,
      details: { userId: id, roles },
    });
    return toUserDto(user);
  }

  async setStatus(id: string, disabled: boolean, actor: Actor, audit: AuditContext) {
    if (id === actor.id) throw conflict('Нельзя заблокировать самого себя', 'self_modification');
    const user = await this.deps.prisma.$transaction(async (tx) => {
      const existing = await tx.adminUser.findUnique({ where: { id }, include: { roles: true } });
      if (!existing) throw notFound('Пользователь не найден');
      if (disabled && existing.roles.some((r) => r.role === 'admin'))
        await this.assertOtherAdmin(tx, id);
      const updated = await tx.adminUser.update({
        where: { id },
        data: { disabled },
        include: { roles: true },
      });
      await writeAudit(tx, audit, {
        action: 'user.status_changed',
        entityType: 'user',
        entityId: id,
        diff: { before: { disabled: existing.disabled }, after: { disabled } },
      });
      return updated;
    });
    if (disabled) await this.sessions.destroyAllForUser(id);
    this.deps.security.emit('user.status_changed', {
      actorId: actor.id,
      ip: audit.ip ?? null,
      requestId: audit.requestId ?? null,
      details: { userId: id, disabled },
    });
    return toUserDto(user);
  }

  private async assertOtherAdmin(
    tx: Parameters<Parameters<AppDeps['prisma']['$transaction']>[0]>[0],
    exceptId: string,
  ) {
    const others = await tx.userRole.count({
      where: { role: 'admin', userId: { not: exceptId }, user: { disabled: false } },
    });
    if (others === 0) throw conflict('Нельзя оставить систему без администратора', 'last_admin');
  }
}
