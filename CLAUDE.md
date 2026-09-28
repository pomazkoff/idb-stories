# CLAUDE.md — сервис сторис ИДБ

ТЗ: `SPEC.md` (копия исходного документа владельца). Решения и допущения по ТЗ — `DECISIONS.md`.
Работаем по фазам раздела 13; открытые вопросы — раздел 15 (до ответа ИДБ — mock + запись в DECISIONS.md).

## Команды

```bash
corepack enable            # pnpm 10 из packageManager
pnpm install
pnpm db:generate           # Prisma Client (packages/db/generated)

pnpm test                  # все проекты vitest: unit, dom, integration
pnpm test:unit             # unit + dom без БД
pnpm test:int              # интеграционные: реальные Postgres 16 и Redis
pnpm test:coverage         # + порог 90% для критичных модулей
pnpm lint                  # ESLint (type-aware), 0 предупреждений
pnpm typecheck             # tsc --noEmit по всем пакетам
pnpm openapi:generate      # docs/openapi/*.json из контрактов; openapi:check — в CI
node scripts/check-unicode.mjs  # нет скрытых/bidi-символов (Trojan Source)
pnpm build                 # tsc + vite для всех пакетов

docker compose up --build  # весь стенд: admin :8082, public API :8080, S3 :9000
pnpm dev:local             # то же без Docker: embedded Postgres, Redis, S3-эмулятор; админка :5173
pnpm seed:demo             # демо-группы на запущенном стенде
pnpm smoke                 # сквозная проверка живого стенда через HTTP и S3
pnpm e2e                   # Playwright против стенда (E2E_BASE_URL, E2E_PUBLIC_API)
```

Интеграционные тесты без Docker сами поднимают `embedded-postgres` и `redis-memory-server` (test/global-setup.ts).
В CI адреса передаются через `TEST_PG_ADMIN_URL` и `TEST_REDIS_URL`. S3 в тестах — `MemoryObjectStorage`.

Миграции: правим `packages/db/prisma/schema.prisma`, затем
`pnpm --filter @idb-stories/db exec prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --script`
→ новый каталог в `prisma/migrations/`. Защиты уровня БД (триггеры, частичные индексы) дописываются SQL вручную.

## Структура

```
apps/api        Fastify: публичный API (/v1, порт 8080) и admin API (/admin/v1, порт 8081) — разные инстансы
apps/worker     src/media — изолированный медиа-воркер (без БД), src/jobs — планировщик, события, ретеншн
apps/admin      React SPA админки (Vite)
packages/schema zod-схемы, контракты эндпоинтов, матрица прав, allowlist CTA, генератор OpenAPI — источник правды
packages/core   общая доменная логика API и jobs: лента и кеш, публикация, аудит, настройки, логгер, очереди
packages/db     Prisma-схема, миграции, права ролей БД, seed
packages/adapters  интерфейсы интеграций ИДБ + mock (auth, segments, catalog, analytics, cdn-purge, siem, SSO, S3)
packages/web-player  плеер на чистом TS (эталон docs/player-contract.md)
docs/           player-contract.md, analytics-events.md, security.md (+ runbook), openapi/
ops/            nginx, postgres init, prometheus alerts, k6
test/           глобальная подготовка интеграционных тестов (@testkit/*)
```

## Соглашения

- TypeScript strict, ESM, относительные импорты с расширением `.js`. Внутренние пакеты в dev/тестах
  берутся из исходников через export-условие `@idb-stories/source` (tsx `--conditions`, vitest, vite).
- **Новый эндпоинт** = контракт в `packages/schema/src/contracts/*` (zod-схемы, право из `PERMISSIONS`) →
  `route(contract, handler)` в `apps/api` → `pnpm openapi:generate` → строка в `CASES` теста
  `apps/api/test/rbac.int.test.ts` (тест падает, если эндпоинт не покрыт матрицей роль × эндпоинт).
- Права проверяются только на сервере по `PERMISSIONS`; админка лишь скрывает недоступное.
- Любое изменение в админке пишет `writeAudit` **в той же транзакции**. Правка группы идёт через
  `GroupsService.mutate` (revision+1, статус → draft, editorsSinceApproval, отмена ожидающего снимка).
- Лента читается только из `published_snapshot`. Содержимое снимка неизменяемо (триггер БД).
- Безопасность (раздел 10) важнее удобства. Никаких `innerHTML`/`dangerouslySetInnerHTML` (ESLint + semgrep),
  текст — только plain text. CTA — только через `checkCta` из `@idb-stories/schema/allowlist`.
- Секреты не логируются: логгер из `@idb-stories/core` маскирует токены, cookie, подписи URL.
- Интеграции ИДБ — только через адаптеры в `packages/adapters` (mock по умолчанию, mock-IdP и mock-токены
  запрещены в production проверкой конфигурации).
- Admin API — camelCase, публичный API — snake_case (контракт мобильных плееров).
- Тексты интерфейса админки — русский, в одном файле `apps/admin/src/i18n/ru.ts`.
- Неоднозначность ТЗ → минимальное безопасное решение, `TODO(spec):` в коде и запись в `DECISIONS.md`.
- Невидимые и bidi-символы в исходниках запрещены (`scripts/check-unicode.mjs`): пишите `\u00A0` и т.п.
  Инструменты записи файлов иногда превращают такие escape-последовательности в реальные символы — проверяйте.
