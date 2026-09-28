/**
 * Витрина ленты для локальной разработки (demo.html, в production-сборку не входит):
 * публичная лента через веб-плеер, как на сайте ИДБ, с выбором площадки.
 */
import { mountFeed, type Placement } from '@idb-stories/web-player';

const API = 'http://localhost:8080';
const MEDIA_ORIGIN = 'http://localhost:9000';
const VIEWED_PREFIX = 'idbs:viewed:';

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const feedEl = byId<HTMLElement>('feed');
const placementEl = byId<HTMLSelectElement>('placement');
const eventsEl = byId<HTMLOListElement>('events');
const emptyEl = byId<HTMLParagraphElement>('empty');

function log(line: string) {
  const li = document.createElement('li');
  li.textContent = `${new Date().toLocaleTimeString('ru-RU')} ${line}`;
  eventsEl.prepend(li);
}

let handle: { destroy(): void } | null = null;

function mount() {
  handle?.destroy();
  emptyEl.hidden = true;
  handle = mountFeed(feedEl, {
    apiBaseUrl: API,
    placement: placementEl.value as Placement,
    mediaOrigins: [MEDIA_ORIGIN],
    ctaAllowlist: { deeplinkSchemes: ['idb'], urlDomains: ['iledebeaute.ru'] },
    getProducts: (skus) =>
      Promise.resolve(
        skus.map((sku, i) => ({
          sku,
          name: `Товар ${sku}`,
          priceRub: 1990 + i * 500,
          inStock: !sku.endsWith('OOS'),
          imageUrl: null,
        })),
      ),
    // На витрине переходы не выполняются — только показываем, куда вёл бы CTA.
    onCta: (cta) => log(`CTA → ${cta.href ?? `${cta.type}: ${cta.value}`}`),
    onAddToCart: (sku) => log(`в корзину: ${sku}`),
    onEvent: (event) => log(event.event),
  });
  // Если сервис недоступен или лента пуста, плеер скрывает блок — покажем подсказку.
  setTimeout(() => {
    emptyEl.hidden = !feedEl.hidden;
  }, 1500);
}

placementEl.addEventListener('change', mount);
byId<HTMLButtonElement>('refresh').addEventListener('click', mount);
byId<HTMLButtonElement>('reset-viewed').addEventListener('click', () => {
  try {
    for (const key of Object.keys(localStorage))
      if (key.startsWith(VIEWED_PREFIX)) localStorage.removeItem(key);
  } catch {
    // localStorage недоступен — «просмотрено» хранится только в памяти
  }
  mount();
});
mount();
