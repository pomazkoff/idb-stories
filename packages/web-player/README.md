# @idb-stories/web-player

Веб-плеер сторис ИДБ: лента кружков и полноэкранный просмотрщик. Эталонная реализация
контракта плееров (раздел 8 ТЗ, `docs/player-contract.md`).

- Чистый TypeScript и DOM, без фреймворков и runtime-зависимостей.
- Весь текст выводится только через `textContent`: HTML и Markdown не интерпретируются (T3).
- Совместим со строгим CSP: нет `innerHTML`, `eval`, `new Function`, inline-атрибутов `style`
  и инжекции `<style>`. Стили поставляются отдельным файлом `styles.css`.
- CTA перед переходом повторно проверяется по allowlist (T4), к ссылке добавляется
  `story_ref=<group_id>:<slide_id>`.
- Медиа загружаются только с разрешённых origin, остальные URL игнорируются.

## Подключение через `<script>` (IIFE)

Сборка кладёт в `dist/` три файла: `web-player.iife.js` (глобальный объект `IdbStories`),
`web-player.esm.js` и `styles.css`.

```html
<link rel="stylesheet" href="https://static.example/idb-stories/styles.css" />

<div id="idb-stories"></div>

<script src="https://static.example/idb-stories/web-player.iife.js"></script>
<!-- Инициализация — отдельным файлом, а не inline-скриптом: так не нужен 'unsafe-inline'. -->
<script src="/js/stories-init.js"></script>
```

```js
// /js/stories-init.js
const feed = IdbStories.mountFeed(document.getElementById('idb-stories'), {
  apiBaseUrl: 'https://api.stories.example',
  placement: 'home',
  mediaOrigins: ['https://cdn.stories.example'],
  ctaAllowlist: { deeplinkSchemes: ['idb'], urlDomains: ['iledebeaute.ru'] },
  getAuthToken: () => shop.auth.getToken(), // необязательно: без токена — анонимная лента
  getProducts: (skus) => shop.catalog.getBySkus(skus), // [{ sku, name, priceRub, inStock, imageUrl }]
  onAddToCart: (sku, storyRef) => shop.cart.add(sku, { storyRef }),
  onCta: ({ type, value, href, storyRef }) => {
    if (href) location.assign(href);
    else if (type === 'product') shop.router.openProduct(value, { storyRef });
    else if (type === 'category') shop.router.openCategory(value, { storyRef });
  },
});

// Например, при возврате на вкладку:
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) void feed.refresh();
});
```

## Подключение как ES-модуль

```ts
import { mountFeed, openViewer, mountPreview } from '@idb-stories/web-player';
import '@idb-stories/web-player/styles.css';

const handle = mountFeed(container, options);
// ...
handle.destroy();
```

Без бандлера — `<script type="module">` с `dist/web-player.esm.js`.

## API

```ts
mountFeed(container: HTMLElement, options: FeedOptions): { refresh(): Promise<void>; destroy(): void };

mountPreview(
  container: HTMLElement,
  feed: FeedResponse,
  options: PlayerOptions & { startGroup?: number; autoplay?: boolean },
): { update(feed: FeedResponse): void; destroy(): void };

openViewer(
  feed: FeedResponse,
  groupIndex: number,
  options: PlayerOptions & { container?: HTMLElement },
): { close(): void };

SUPPORTED_SCHEMA_VERSION = 1;
```

- **`mountFeed`** — загружает `GET {apiBaseUrl}/v1/feed?placement=…` (заголовок
  `X-Platform: web`, при наличии токена — `Authorization: Bearer …`, cookies не отправляются)
  и рисует ряд кружков; по тапу открывает полноэкранный плеер. `refresh()` никогда не
  отклоняется; в пределах `ttl_sec` берёт ответ из памяти.
- **`openViewer`** — открыть плеер для уже полученной ленты (`groupIndex` — индекс в
  `feed.groups`). Оверлей добавляется в `container` или в `document.body`.
- **`mountPreview`** — плеер внутри контейнера (рамка телефона в админке): без оверлея,
  без блокировки прокрутки, без перехвата фокуса и клавиш страницы (клавиши работают, когда
  фокус внутри предпросмотра). `update(feed)` перерисовывает, сохраняя текущую группу и слайд.
  «Просмотрено» не записывается. После закрытия — экран «Смотреть снова».

### Опции (`PlayerOptions`)

| Опция          | Тип                                          | Описание                                                                                                                                                                                                                                                                                     |
| -------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `placement`    | `'home' \| 'catalog' \| 'product' \| 'cart'` | Место показа, уходит в запрос и события.                                                                                                                                                                                                                                                     |
| `mediaOrigins` | `string[]`                                   | Разрешённые origin медиа (CDN сервиса). Слайд, у которого не осталось медиа с разрешённого origin, пропускается и даёт `story_media_error` с `error_code: forbidden_origin`. Обложка или постер с чужого origin не загружаются.                                                              |
| `ctaAllowlist` | `{ deeplinkSchemes, urlDomains }`            | Allowlist CTA (раздел 10.4). Непрошедший проверку CTA не делает ничего и не шлёт событие.                                                                                                                                                                                                    |
| `getProducts`  | `(skus) => Promise<CatalogProduct[]>`        | Товары для слайдов `product`. Не в наличии — скрываются; если не осталось ни одного или каталог упал — слайд пропускается. Без опции слайды с товарами не показываются.                                                                                                                      |
| `onCta`        | `(cta) => void`                              | Переход по CTA: `{ type, value, href, storyRef }`. Для `url`/`deeplink` `href` уже содержит `story_ref`, для `product`/`category` `href = null`. По умолчанию `url`/`deeplink` открываются через `location.assign(href)`. Клик по карточке товара тоже вызывает `onCta` с `type: 'product'`. |
| `onAddToCart`  | `(sku, storyRef) => void \| Promise`         | Кнопка «В корзину». Без опции кнопки нет. `story_add_to_cart` уходит после успешного выполнения.                                                                                                                                                                                             |
| `onEvent`      | `(event: StoryEvent) => void`                | Каждое аналитическое событие (раздел 9), например для прокидывания в аналитику сайта.                                                                                                                                                                                                        |
| `appVersion`   | `string`                                     | По умолчанию `web`.                                                                                                                                                                                                                                                                          |
| `sessionId`    | `string`                                     | По умолчанию — случайный UUID на загрузку страницы.                                                                                                                                                                                                                                          |
| `storage`      | `Storage \| null`                            | Где хранить «просмотрено». По умолчанию `localStorage`; `null` — только в памяти. Ошибки доступа игнорируются.                                                                                                                                                                               |
| `now`          | `() => number`                               | Источник времени (для тестов).                                                                                                                                                                                                                                                               |

Дополнительно у `mountFeed` (`FeedOptions`):

| Опция            | Тип                             | Описание                                                                                                              |
| ---------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `apiBaseUrl`     | `string`                        | Базовый URL публичного API, без `/v1`.                                                                                |
| `getAuthToken`   | `() => Promise<string \| null>` | Необязательный токен покупателя. Ошибка получения токена — запрашивается анонимная лента.                             |
| `eventsEndpoint` | `string \| null`                | Куда отправлять события. По умолчанию `${apiBaseUrl}/v1/events`, `null` — не отправлять (останется только `onEvent`). |

## Поведение

- **Лента скрывается молча** (контейнер пустой, атрибут `hidden`), если сеть недоступна, ответ
  не 200, не JSON, групп нет или `schema_version` выше поддерживаемой. Исключения наружу не
  выбрасываются.
- **Совместимость:** неизвестный `type` слайда и неизвестный `kind` элемента пропускаются молча;
  группа без отображаемых слайдов не показывается.
- **Просмотренные группы** приглушены и стоят в конце ряда. Ключ в хранилище —
  `idbs:viewed:<group_id>:<version>`; новая версия группы снова непросмотрена. Группа считается
  просмотренной, когда её открыли.
- **Плеер:** тап в правой части — следующий слайд, в левой трети — предыдущий; удержание
  дольше 200 мс — пауза; свайп вниз — закрыть; свайп влево/вправо — соседняя группа.
  Клавиатура: `←`/`→`, `Space` — пауза, `Esc` — закрыть. Автопереход по `duration_ms`, видео — по
  `ended`; пока медиа грузится или видео буферизуется, таймер стоит. После последнего слайда —
  следующая группа, после последней группы — закрытие. Следующий слайд и обложка следующей группы
  предзагружаются. Видео стартует без звука (кнопка звука в шапке).
- **`prefers-reduced-motion: reduce`:** слайды стартуют на паузе и не переключаются сами,
  видео не запускается автоматически.
- **Доступность:** `role="dialog"` с `aria-label` = заголовок группы, кнопка «Закрыть», фокус
  удерживается внутри диалога и возвращается на кружок после закрытия, текст слайда — обычный
  текст в DOM.

## События

Все события раздела 9 с общими полями (`event_id` — UUID v4, `ts` — ISO 8601, `session_id`,
`platform: web`, `app_version`, `placement`). Идентификатор пользователя не передаётся.
`stories_feed_shown` уходит, когда ряд попал во вьюпорт (IntersectionObserver, половина ряда
видна), с `groups_count` и `group_ids` видимых кружков.

`mountFeed` копит события и отправляет `POST {events: […]}` батчами до 50 штук раз в ~5 с
(`Content-Type: application/json`, без cookies). При `pagehide` или скрытии вкладки остаток
уходит через `navigator.sendBeacon` с телом-JSON и типом `text/plain;charset=UTF-8` — это
CORS-safelisted тип, поэтому beacon доходит до API на другом origin без preflight. Повторных
попыток нет.

## CSP сайта

Плееру достаточно строгой политики без `'unsafe-inline'` и `'unsafe-eval'`:

```
script-src  <хост бандла>;
style-src   <хост styles.css>;
img-src     https://cdn.stories.example <хост картинок каталога>;
media-src   https://cdn.stories.example;
connect-src https://api.stories.example;
```

Прогресс-бар анимируется через CSSOM (`element.style.transform`), это не inline-стиль с точки
зрения CSP и не требует `'unsafe-inline'`.

## Оформление

Классы с префиксом `idbs-`. Основные CSS-переменные: `--idbs-font`, `--idbs-accent`,
`--idbs-accent-contrast`, `--idbs-ring`, `--idbs-ring-viewed`, `--idbs-circle-size`,
`--idbs-feed-gap`, `--idbs-title-color`, `--idbs-overlay-z`, `--idbs-overlay-bg`.

## Разработка

```sh
pnpm --filter @idb-stories/web-player run typecheck
pnpm exec vitest run --project dom          # тесты в happy-dom
pnpm --filter @idb-stories/web-player... run build   # вместе с @idb-stories/schema
```

`build` = `tsc -p tsconfig.build.json` (типы и ESM-модули в `dist/`) + `scripts/bundle.mjs`
(esbuild: `dist/web-player.iife.js`, `dist/web-player.esm.js`, минификация, target ES2020,
копия `styles.css`). В бандл вшивается только `@idb-stories/schema/allowlist`; скрипт падает,
если туда попал zod или запрещённые конструкции (`innerHTML`, `eval` и т. п.).
