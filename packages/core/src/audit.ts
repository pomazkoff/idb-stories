import type { Prisma } from '@idb-stories/db';

/** Кто и откуда выполняет действие. actorId = null — система (планировщик). */
export interface AuditContext {
  actorId: string | null;
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}

export const SYSTEM_CONTEXT: AuditContext = { actorId: null };

type Db = Pick<Prisma.TransactionClient, 'auditLog'>;

export interface AuditEntry {
  action: string;
  entityType: string;
  entityId: string | null;
  diff?: unknown;
}

/**
 * Запись в append-only журнал. Вызывается в той же транзакции, что и само изменение:
 * изменение без записи в аудит невозможно.
 */
export async function writeAudit(db: Db, ctx: AuditContext, entry: AuditEntry): Promise<void> {
  await db.auditLog.create({
    data: {
      actorId: ctx.actorId,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      diff: entry.diff === undefined ? undefined : (toJson(entry.diff) as Prisma.InputJsonValue),
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent?.slice(0, 512) ?? null,
      requestId: ctx.requestId ?? null,
    },
  });
}

function toJson(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_k, v: unknown) => (v instanceof Date ? v.toISOString() : v)),
  );
}

/** Diff «до/после» только по изменившимся полям. */
export function diffFields(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): { before: Record<string, unknown> | null; after: Record<string, unknown> | null } {
  if (!before || !after) return { before, after };
  const b: Record<string, unknown> = {};
  const a: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (JSON.stringify(toJson(before[key])) !== JSON.stringify(toJson(after[key]))) {
      b[key] = before[key];
      a[key] = after[key];
    }
  }
  return { before: b, after: a };
}
