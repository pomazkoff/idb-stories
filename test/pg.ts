declare module 'vitest' {
  export interface ProvidedContext {
    pg: PgConnection;
    redisUrl: string;
  }
}

export interface PgConnection {
  host: string;
  port: number;
  adminUser: string;
  adminPassword: string;
  template: string;
}

/** Роли как в проде: владелец схемы мигрирует, приложение работает с урезанными правами. */
export const PG_ROLES = {
  owner: { user: 'stories_owner', password: 'owner_test_pw' },
  app: { user: 'stories_app', password: 'app_test_pw' },
} as const;

export function databaseUrl(
  pg: PgConnection,
  db: string,
  role: { user: string; password: string },
) {
  return `postgresql://${role.user}:${role.password}@${pg.host}:${pg.port}/${db}?connection_limit=5`;
}

export function adminUrl(pg: PgConnection, db: string) {
  return databaseUrl(pg, db, { user: pg.adminUser, password: pg.adminPassword });
}
