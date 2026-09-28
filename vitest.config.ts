import path from 'node:path';
import { defaultClientConditions } from 'vite';
import { defineConfig } from 'vitest/config';

const root = import.meta.dirname;
// Внутренние пакеты в тестах берутся из исходников (см. exports["@idb-stories/source"]).
const source = '@idb-stories/source';

export default defineConfig({
  resolve: {
    conditions: [source, ...defaultClientConditions],
    alias: { '@testkit': path.join(root, 'test') },
  },
  // Без условия `module`: иначе пакеты вроде @aws-sdk резолвятся в dist-es для бандлеров,
  // который Node не может загрузить напрямую.
  ssr: { resolve: { conditions: [source, 'node', 'development|production'] } },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          environment: 'node',
          include: ['{packages,apps}/*/{src,test}/**/*.test.ts'],
          exclude: ['**/*.int.test.ts', 'packages/web-player/**', 'apps/admin/**', '**/node_modules/**'],
        },
      },
      {
        extends: true,
        test: {
          name: 'dom',
          environment: 'happy-dom',
          include: ['packages/web-player/test/**/*.test.ts', 'apps/admin/src/**/*.test.{ts,tsx}'],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          environment: 'node',
          include: ['{packages,apps}/*/test/**/*.int.test.ts'],
          globalSetup: ['test/global-setup.ts'],
          env: { PRISMA_LOG: 'none' },
          testTimeout: 30_000,
          hookTimeout: 120_000,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'text', 'json-summary', 'html'],
      // Критичные модули (раздел 12): auth, RBAC, allowlist, фильтрация ленты, медиа-валидация — порог 90%.
      include: [
        'packages/schema/src/allowlist.ts',
        'packages/schema/src/permissions.ts',
        'packages/core/src/feed/**',
        'packages/core/src/publishing.ts',
        'apps/api/src/auth/**',
        'apps/api/src/http/routes.ts',
        'apps/api/src/services/workflow.ts',
        'apps/api/src/services/customer-segments.ts',
        'apps/worker/src/media/signature.ts',
        'apps/worker/src/media/image-header.ts',
        'apps/worker/src/media/polyglot.ts',
        'apps/worker/src/media/process.ts',
      ],
      thresholds: { lines: 90, functions: 90, statements: 90, branches: 85 },
    },
  },
});
