/**
 * Генерирует docs/openapi/{public,admin}.openapi.json из контрактов.
 * `--check` — CI-режим: падает, если закоммиченные файлы отличаются от сгенерированных.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildOpenApi } from '../src/openapi.js';
import { adminContracts, publicContracts } from '../src/contracts/index.js';
import type { RouteContract } from '../src/contracts/types.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const outDir = path.join(root, 'docs/openapi');
const check = process.argv.includes('--check');

const documents: Record<string, object> = {
  'public.openapi.json': buildOpenApi(publicContracts, {
    title: 'IDB Stories — Public API',
    description:
      'Публичная лента сторис и приём событий. Контракт плееров: docs/player-contract.md, события: docs/analytics-events.md.',
    version: '1.0.0',
    servers: [
      { url: 'https://stories-api.example', description: 'TODO(spec): домен публичного API' },
    ],
    securitySchemes: {
      customerToken: {
        type: 'http',
        scheme: 'bearer',
        description: 'Необязательный токен покупателя ИДБ (без токена — анонимная лента)',
      },
    },
    securityFor: (c: RouteContract) =>
      c.id === 'getFeed' ? [{}, { customerToken: [] }] : undefined,
  }),
  'admin.openapi.json': buildOpenApi(adminContracts, {
    title: 'IDB Stories — Admin API',
    description:
      'API админки. Доступ только из внутренней сети ИДБ через SSO. Изменяющие запросы требуют заголовок X-CSRF-Token.',
    version: '1.0.0',
    servers: [
      { url: 'https://stories-admin.example', description: 'TODO(spec): внутренний домен админки' },
    ],
    securitySchemes: {
      session: { type: 'apiKey', in: 'cookie', name: '__Host-stories_sid' },
      csrf: { type: 'apiKey', in: 'header', name: 'X-CSRF-Token' },
    },
    securityFor: (c: RouteContract) => {
      if (c.auth !== 'session') return [];
      return c.method === 'GET' ? [{ session: [] }] : [{ session: [], csrf: [] }];
    },
  }),
};

await mkdir(outDir, { recursive: true });
let stale = false;
for (const [file, doc] of Object.entries(documents)) {
  const target = path.join(outDir, file);
  const content = `${JSON.stringify(doc, null, 2)}\n`;
  if (check) {
    const current = await readFile(target, 'utf8').catch(() => '');
    if (current !== content) {
      console.error(
        `OpenAPI устарел: ${path.relative(root, target)}. Запустите pnpm openapi:generate`,
      );
      stale = true;
    }
  } else {
    await writeFile(target, content);
    console.log(`Записан ${path.relative(root, target)}`);
  }
}
if (stale) process.exit(1);
