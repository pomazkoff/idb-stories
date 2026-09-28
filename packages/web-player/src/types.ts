import type { CtaAllowlist } from '@idb-stories/schema/allowlist';
import type { FeedResponse, StoryEvent } from '@idb-stories/schema';

export type Placement = 'home' | 'catalog' | 'product' | 'cart';

/** Товар из каталога ИДБ. Цены и наличие в ленте не передаются — их даёт хост (раздел 5.1). */
export interface CatalogProduct {
  sku: string;
  name: string;
  priceRub: number;
  inStock: boolean;
  imageUrl: string | null;
}

export interface CtaAction {
  type: string;
  /** Нормализованное значение после проверки по allowlist. */
  value: string;
  /** Для url и deeplink — ссылка с параметром story_ref, для product и category — null. */
  href: string | null;
  /** `<group_id>:<slide_id>` для атрибуции. */
  storyRef: string;
}

export interface PlayerOptions {
  placement: Placement;
  /** Разрешённые origin медиа (CDN сервиса). URL с других origin игнорируются, слайд пропускается. */
  mediaOrigins: string[];
  /** Allowlist CTA: повторная проверка на клиенте перед переходом (раздел 10.4). */
  ctaAllowlist: CtaAllowlist;
  /** Товары для слайдов type=product. Товары не в наличии скрываются; если не осталось ни одного — слайд пропускается. */
  getProducts?: (skus: string[]) => Promise<CatalogProduct[]>;
  /** Переход по CTA. По умолчанию url и deeplink открываются через location.assign(href). */
  onCta?: (cta: CtaAction) => void;
  onAddToCart?: (sku: string, storyRef: string) => void | Promise<void>;
  onEvent?: (event: StoryEvent) => void;
  /** По умолчанию `web`. */
  appVersion?: string;
  /** По умолчанию — случайный идентификатор на загрузку страницы. */
  sessionId?: string;
  /** Где хранить «просмотрено». По умолчанию localStorage, null — только в памяти. */
  storage?: Storage | null;
  /** Источник времени (для тестов). */
  now?: () => number;
}

export interface FeedOptions extends PlayerOptions {
  /** Базовый URL публичного API без `/v1`. */
  apiBaseUrl: string;
  /** Необязательный Bearer-токен покупателя. Без него отдаётся анонимная лента. */
  getAuthToken?: () => Promise<string | null>;
  /** Куда отправлять события. По умолчанию `${apiBaseUrl}/v1/events`, null — не отправлять. */
  eventsEndpoint?: string | null;
}

export interface PreviewOptions extends PlayerOptions {
  /** Индекс группы в `feed.groups`, с которой начинать. */
  startGroup?: number;
  /** false — каждый слайд стартует на паузе и не переключается сам. По умолчанию true. */
  autoplay?: boolean;
}

export interface ViewerOptions extends PlayerOptions {
  /** Куда добавить оверлей. По умолчанию document.body. */
  container?: HTMLElement;
}

export interface FeedHandle {
  refresh(): Promise<void>;
  destroy(): void;
}

export interface PreviewHandle {
  update(feed: FeedResponse): void;
  destroy(): void;
}

export interface ViewerHandle {
  close(): void;
}
