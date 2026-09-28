# Нагрузочные сценарии

```bash
k6 run -e PUBLIC_URL=https://stories-api.stage ops/k6/feed.js     # 500 RPS, p95 < 150 мс (кеш) / < 400 мс (без кеша)
k6 run -e PUBLIC_URL=https://stories-api.stage -e GROUP_ID=<uuid> ops/k6/events.js
```

Параметры: `RPS`, `DURATION`. Реальные цифры нагрузки — открытый вопрос №9.

## Локальный замер (2026-09-28)

Production-сборка публичного API (`NODE_ENV=production`, один процесс Node 24, Apple M-серия, 8 ядер),
Postgres и Redis локально, 8 опубликованных групп, запросы по 4 placement и 3 платформам, `Accept-Encoding: br`:

| Нагрузка | Ошибки | Попадания в кеш | p50 | p95 | p99 |
|---|---|---|---|---|---|
| 500 RPS, 15 с | 0 | 99,9% | 0,8 мс | 2,7 мс | 53 мс |
| 2000 RPS, 10 с | 0 | 100% | 0,8 мс | 6,1 мс | 62 мс |
| 500 RPS, сброс кеша 10 раз/с | 0 | 76,6% | 0,7 мс | 2,8 мс | 10,5 мс |

Размер ответа с 2 группами × 3 слайда — 5,8 КБ JSON, 0,9 КБ в brotli.
