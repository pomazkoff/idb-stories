# @idb-stories/adapters — интеграции с системами ИДБ

Всё, что в ТЗ помечено `[ИНТЕГРАЦИЯ]`, сервис вызывает только через эти интерфейсы. По умолчанию подключены
mock-реализации; реальные добавляются новым `provider` в `createAdapters()` (`src/index.ts`) и в конфиги
`apps/api/src/config.ts`, `apps/worker/src/config.ts`.

| Интерфейс | Файл | Где используется | Открытый вопрос | Требования к реальной реализации |
|---|---|---|---|---|
| `SsoAdapter` | `sso.ts` | вход в админку | №3 (OIDC/SAML, группы → роли) | state, nonce, PKCE; проверка подписи/issuer/audience ID-токена; MFA на стороне IdP |
| `CustomerAuthAdapter` | `customer-auth.ts` | `/v1/feed` с `Authorization` | №2 (JWT+JWKS или introspection) | фиксированный алгоритм, проверка подписи, `exp`, `iss`, `aud`; `null` для невалидного токена, `AdapterUnavailableError` при недоступности; токен не логировать |
| `SegmentsAdapter` | `segments.ts` | персональная лента, синхронизация справочника | №5 | `getUserSegments` быстрее 800 мс (иначе лента без таргетинга); `listSegments` для ежечасной синхронизации |
| `CatalogAdapter` | `catalog.ts` | превью товарных слайдов в админке | — | неизвестные SKU не возвращать |
| `AnalyticsAdapter` | `analytics.ts` | очередь `analytics-forward` | №4 | идемпотентность по `event_id` (очередь ретраит) |
| `CdnPurgeAdapter` | `cdn-purge.ts` | публикация, снятие, kill switch | №1 | purge пути `/v1/feed`; ошибки не блокируют публикацию (TTL ≤ 60 с) |
| `SiemAdapter` | `siem.ts` | события безопасности | №10 | не блокировать запрос; дублируются в логах `category=security` |
| `ObjectStorage` | `storage.ts` | медиа | №1 (хранилище в РФ-контуре) | S3-совместимый API: presigned PUT с подписью `content-type`/`content-length`, presigned GET, copy |

Правила:

- Любой вызов внешней системы оборачивается в `withTimeout()` — сбой превращается в `AdapterUnavailableError`,
  вызывающий код деградирует (лента без таргетинга, превью без каталога), а не падает.
- Mock SSO и mock токенов покупателей запрещены в production проверкой конфигурации при старте.
- Персональные данные покупателей адаптеры наружу не отдают: только `user_id` (транзиентно) и ID сегментов.
