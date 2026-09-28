import type { PrismaClient } from '../generated/client/index.js';

const IDENT_RE = /^[a-z_][a-z0-9_]{0,62}$/;

export function assertSqlIdentifier(name: string): string {
  if (!IDENT_RE.test(name)) throw new Error(`Недопустимое имя роли БД: ${name}`);
  return name;
}

/**
 * Права роли приложения (раздел 10.9): аудит только SELECT/INSERT, снимки нельзя удалять,
 * таблица миграций недоступна. Выполняется владельцем схемы после `prisma migrate deploy`.
 * Если роль не существует (например, локальная БД с одним пользователем) — пропускаем с предупреждением.
 */
export async function applyGrants(prisma: PrismaClient, appRole: string): Promise<boolean> {
  const role = assertSqlIdentifier(appRole);
  const exists = await prisma.$queryRawUnsafe<{ n: number }[]>(
    'SELECT count(*)::int AS n FROM pg_roles WHERE rolname = $1',
    role,
  );
  if (!exists[0] || exists[0].n === 0) return false;
  const statements = [
    `GRANT USAGE ON SCHEMA public TO ${role}`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`,
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role}`,
    `REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM ${role}`,
    `REVOKE DELETE, TRUNCATE ON published_snapshot FROM ${role}`,
    `REVOKE ALL ON _prisma_migrations FROM ${role}`,
  ];
  await prisma.$transaction(statements.map((sql) => prisma.$executeRawUnsafe(sql)));
  return true;
}
