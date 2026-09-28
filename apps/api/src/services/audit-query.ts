import type { Prisma } from '@idb-stories/db';
import type { AuditQuery } from '@idb-stories/schema';
import type { AppDeps } from '../context.js';
import { badRequest } from '../http/errors.js';
import { loadUserRefs } from './mappers.js';

export async function queryAuditLog(deps: AppDeps, q: AuditQuery) {
  const where: Prisma.AuditLogWhereInput = {
    ...(q.actorId ? { actorId: q.actorId } : {}),
    ...(q.action ? { action: q.action } : {}),
    ...(q.entityType ? { entityType: q.entityType } : {}),
    ...(q.entityId ? { entityId: q.entityId } : {}),
    ...(q.from || q.to
      ? {
          ts: {
            ...(q.from ? { gte: new Date(q.from) } : {}),
            ...(q.to ? { lt: new Date(q.to) } : {}),
          },
        }
      : {}),
  };
  if (q.cursor && !/^\d{1,19}$/.test(q.cursor)) throw badRequest('Некорректный курсор');
  const rows = await deps.prisma.auditLog.findMany({
    where: q.cursor ? { AND: [where, { id: { lt: BigInt(q.cursor) } }] } : where,
    orderBy: { id: 'desc' },
    take: q.limit + 1,
  });
  const page = rows.slice(0, q.limit);
  const refs = await loadUserRefs(
    deps.prisma,
    page.map((r) => r.actorId),
  );
  return {
    items: page.map((r) => ({
      id: r.id.toString(),
      ts: r.ts.toISOString(),
      actor: r.actorId ? (refs.get(r.actorId) ?? { id: r.actorId, name: '—' }) : null,
      action: r.action,
      entityType: r.entityType,
      entityId: r.entityId,
      diff: r.diff,
      ip: r.ip,
      userAgent: r.userAgent,
      requestId: r.requestId,
    })),
    nextCursor: rows.length > q.limit ? (page.at(-1)?.id.toString() ?? null) : null,
  };
}
