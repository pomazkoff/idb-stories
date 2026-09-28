# Сервис сторис ИДБ

Лента сторис для мобильного приложения и сайта ИДБ: маркетинг создаёт и публикует сторис без релизов
приложений, публикация — только после согласования другим человеком, продукт видит воронку и CTR.
ТЗ — [`SPEC.md`](SPEC.md), решения и допущения — [`DECISIONS.md`](DECISIONS.md), для разработчиков — [`CLAUDE.md`](CLAUDE.md).

## Состав

| Часть | Где | Что делает |
|---|---|---|
| Публичный API | `apps/api` (порт 8080) | `GET /v1/feed`, `POST /v1/events`, `GET /v1/health` |
| Admin API | `apps/api` (порт 8081) | SSO, сессии, RBAC, группы и слайды, согласование, медиа, статистика, аудит, настройки |
| Фоновые задачи | `apps/worker` (`jobs`) | публикация по `start_at`, архивирование по `end_at`, события → агрегаты → аналитика ИДБ, ретеншн |
| Медиа-воркер | `apps/worker` (`media`) | проверка и обязательное перекодирование (libvips, ffmpeg); изолирован, без БД и внешней сети |
| Админка | `apps/admin` (порт 8082) | React SPA: список, редактор с живым превью, очередь согласования, статистика, аудит, настройки |
| Веб-плеер | `packages/web-player` | плеер на чистом TS для сайта и превью; эталон для мобильных команд |
| Контракты | `packages/schema` | zod-схемы → валидация API и OpenAPI 3.1 (`docs/openapi/`) |

Документы: [контракт плееров](docs/player-contract.md) · [события аналитики](docs/analytics-events.md) ·
[безопасность и runbook](docs/security.md) · алерты `ops/prometheus/alerts.yml` · нагрузка `ops/k6/`.

## Запуск

```bash
docker compose up --build
```

- Админка: http://localhost:8082 — вход через mock SSO (только dev), пользователи на все роли.
- Лента: `curl -H 'X-Platform: web' 'http://localhost:8080/v1/feed?placement=home'`
- S3 (и «CDN» публичных медиа): http://localhost:9000

Без Docker (встроенные Postgres и Redis из npm, S3-эмулятор, ffmpeg из npm):

```bash
corepack enable && pnpm install
pnpm dev:local      # админка http://localhost:5173, API :8080/:8081
                    # витрина ленты глазами покупателя: http://localhost:5173/demo.html
pnpm smoke          # сквозная проверка живого стенда: загрузка → согласование → лента → снятие
```

## Проверки

```bash
pnpm lint && pnpm typecheck && pnpm test   # unit, DOM и интеграционные (реальные Postgres 16 и Redis)
pnpm test:coverage                         # порог 90% для критичных модулей
pnpm openapi:check                         # OpenAPI сгенерирован и закоммичен
pnpm e2e                                   # Playwright против стенда
```

CI (`.github/workflows/ci.yml`): линт, typecheck, тесты, `pnpm audit`, semgrep, gitleaks, trivy, сборка
образов, `docker compose up` и E2E.

## Роли

| Роль | Может |
|---|---|
| Редактор | черновики, медиа, отправка на согласование |
| Публикатор | согласование или отклонение (не своих правок), публикация, снятие |
| Аналитик | чтение сторис и статистики |
| Администратор | пользователи и роли, allowlist ссылок, kill switch, снятие группы при инциденте |

## Интеграции ИДБ

Всё, что помечено в ТЗ как `[ИНТЕГРАЦИЯ]`, подключено через адаптеры `packages/adapters` с mock-реализацией:
SSO сотрудников, токены и сегменты покупателей, каталог, аналитика, purge CDN, SIEM, S3 в РФ-контуре.
Открытые вопросы раздела 15 и принятые до ответа допущения — в `DECISIONS.md`.
