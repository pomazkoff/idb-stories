# Деплой

Инфраструктура ИДБ — открытый вопрос №1 (Kubernetes или VM, S3, CDN). Ниже — требования, которые сервис
предъявляет к любому варианту, и пример для Kubernetes. Всё помеченное [ИНТЕГРАЦИЯ] настраивает ИДБ.

## Образы

Один `Dockerfile`, цели: `api`, `jobs`, `media`, `admin`, `tools`. Базовые образы закреплены по digest,
процессы запускаются не от root. CI собирает и сканирует trivy все цели.

```bash
docker build --target api   -t registry.idb/stories-api:<sha> .
docker build --target jobs  -t registry.idb/stories-jobs:<sha> .
docker build --target media -t registry.idb/stories-media:<sha> .
docker build --target admin -t registry.idb/stories-admin:<sha> .
docker build --target tools -t registry.idb/stories-tools:<sha> .
```

## Процессы

| Процесс | Образ | Команда / env | Сеть | Масштабирование |
|---|---|---|---|---|
| Миграции (Job перед выкладкой) | tools | `pnpm db:migrate` (владелец схемы, `DB_APP_ROLE`) | БД | 1 |
| Публичный API | api | `API_SURFACES=public`, порт 8080 | за CDN, публично | горизонтально, stateless |
| Admin API | api | `API_SURFACES=admin`, порт 8081 | только внутренняя сеть/VPN, IP allowlist на ingress | ≥ 2 |
| Фоновые задачи | jobs | — | БД, Redis, S3 | ≥ 2 (периодические задачи выполняются один раз через BullMQ) |
| Медиа-воркер | media | `MEDIA_CONCURRENCY=1` | **только Redis и S3** | по очереди `media-process` |
| Админка | admin | `ADMIN_API_UPSTREAM`, `CDN_ORIGIN`, `S3_PUBLIC_ORIGIN` | внутренняя сеть | ≥ 2 |

Порядок выкладки: миграции → admin API и публичный API → jobs → media → admin.
Health: liveness `GET /v1/health/live`, readiness `GET /v1/health` (без версий зависимостей).
Метрики `/metrics`: API :9464, jobs и media :9465 — только для Prometheus, наружу не публикуются.

## Обязательные переменные в production

Проверяются при старте (`apps/api/src/config.ts`, `apps/worker/src/config.ts`); небезопасные значения —
ошибка запуска, а не предупреждение.

| Переменная | Значение |
|---|---|
| `NODE_ENV` | `production` |
| `DATABASE_URL` | роль `stories_app` (не владелец схемы) |
| `REDIS_URL`, `REDIS_PREFIX` | отдельный пользователь Redis на процесс; у медиа-воркера — ACL на `bull:media-*` (TODO(spec)) |
| `S3_*` | отдельные ключи на процесс с правами из `ops/s3/*.json` |
| `CDN_BASE_URL` | https-домен CDN сервиса |
| `ADMIN_ORIGIN` | https-origin админки |
| `ADMIN_COOKIE_SECURE` | `true` (иначе старт невозможен) |
| `PUBLIC_CORS_ORIGINS` | https-домены сайта ИДБ |
| `SEGMENTS_CACHE_SALT` | случайная строка ≥ 16 символов, своя на окружение |
| `SSO_PROVIDER` | реальный провайдер ИДБ (mock в production запрещён) [ИНТЕГРАЦИЯ] |
| `CUSTOMER_AUTH_PROVIDER` | `disabled` до интеграции с IdP покупателей (mock запрещён) [ИНТЕГРАЦИЯ] |
| `TRUST_PROXY` | адреса ingress/CDN, от которых принимается `X-Forwarded-For` |

Секреты — только из secret manager, отдельные на окружение, короткоживущие где возможно (T11).

## База данных

PostgreSQL 16. Две роли: владелец схемы (миграции) и `stories_app` (приложение). Миграционный Job применяет
`prisma migrate deploy` и выдаёт права (`packages/db/src/grants.ts`): у приложения нет UPDATE/DELETE на
`audit_log` и DELETE на `published_snapshot`. Бэкапы ежедневно, хранение 14 дней, проверка восстановления —
`pnpm smoke` против стенда, поднятого из бэкапа.

## Хранилище S3 [ИНТЕГРАЦИЯ]

- `stories-quarantine` — закрыт; CORS: `PUT` только с `ADMIN_ORIGIN`, заголовок `content-type`;
  lifecycle: удаление через 7 дней.
- `stories-media` — закрыт; чтение только по подписанным URL (15 минут).
- `stories-public` — origin CDN; чтение только для CDN (или анонимное, если CDN так устроен).

Образец настройки — `apps/api/src/scripts/storage-init.ts` (стандартный S3 API), права — `ops/s3/`.

## CDN [ИНТЕГРАЦИЯ]

- Медиа: `CDN_BASE_URL/<key>` → `stories-public/<key>`, кеш надолго (`immutable`, ключи неизменяемые).
- Лента `/v1/feed`: соблюдать `Cache-Control` ответа (`public, max-age ≤ 60` или `private, no-store`);
  запросы с `Authorization` не кешировать; ключ кеша — `placement` + `X-Platform` + `X-App-Version`
  (сервис выставляет `Vary: Authorization, X-Platform, X-App-Version`). Сворачивать версию до мажор.минор
  в ключе CDN можно, только если редакторы задают `min_app_version` без патч-версии.
- Purge пути `/v1/feed` по API CDN — реализовать адаптер `CdnPurgeAdapter`. Даже без purge изменения
  применяются не дольше чем через `ttl_sec` ≤ 60 секунд.

## Kubernetes: изоляция медиа-воркера (пример)

```yaml
securityContext:
  runAsNonRoot: true
  runAsUser: 1000
  readOnlyRootFilesystem: true
  allowPrivilegeEscalation: false
  capabilities: { drop: [ALL] }
  seccompProfile: { type: RuntimeDefault }
resources:
  limits: { cpu: '2', memory: 2Gi, ephemeral-storage: 2Gi }
volumes:
  - name: tmp
    emptyDir: { medium: Memory, sizeLimit: 1500Mi }
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: stories-media-egress }
spec:
  podSelector: { matchLabels: { app: stories-media } }
  policyTypes: [Ingress, Egress]
  ingress:
    - from: [{ namespaceSelector: { matchLabels: { name: monitoring } } }]
      ports: [{ port: 9465 }]
  egress:
    - to: [{ podSelector: { matchLabels: { app: redis } } }]
      ports: [{ port: 6379 }]
    - to: [{ ipBlock: { cidr: <S3_ENDPOINT_CIDR> } }]
      ports: [{ port: 443 }]
```

## Перед запуском

- [ ] SSO сотрудников и маппинг ролей (вопрос №3), IP allowlist admin API.
- [ ] Схема диплинков и домены в allowlist (вопрос №6), список placements (вопрос №7).
- [ ] Адаптеры аналитики, CDN purge, SIEM (вопросы №4, №10).
- [ ] Таргетинг (фаза 6) — только после согласования сегментов с юристом и ИБ (вопрос №8, раздел 10.7).
- [ ] Пентест по требованиям ИБ (вопрос №12), нагрузочный тест `ops/k6` на реальных цифрах (вопрос №9).
- [ ] Алерты `ops/prometheus/alerts.yml` подключены, runbook `docs/security.md` известен дежурным.
