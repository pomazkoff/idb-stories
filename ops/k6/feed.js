// Нагрузочный тест ленты (раздел 11): 500 RPS на один инстанс за CDN;
// p95 < 150 мс при попадании в кеш, < 400 мс без кеша; ответ < 100 КБ.
//   k6 run -e PUBLIC_URL=http://localhost:8080 ops/k6/feed.js
import http from 'k6/http';
import { check } from 'k6';
import { Trend } from 'k6/metrics';

const BASE = __ENV.PUBLIC_URL || 'http://localhost:8080';
const placements = ['home', 'catalog', 'product', 'cart'];
const clients = [
  { 'X-Platform': 'web' },
  { 'X-Platform': 'ios', 'X-App-Version': '5.12.0' },
  { 'X-Platform': 'android', 'X-App-Version': '6.1.3' },
];

const hit = new Trend('feed_duration_cache_hit', true);
const miss = new Trend('feed_duration_cache_miss', true);

export const options = {
  scenarios: {
    feed: {
      executor: 'constant-arrival-rate',
      rate: Number(__ENV.RPS || 500),
      timeUnit: '1s',
      duration: __ENV.DURATION || '2m',
      preAllocatedVUs: 100,
      maxVUs: 400,
    },
  },
  thresholds: {
    feed_duration_cache_hit: ['p(95)<150'],
    feed_duration_cache_miss: ['p(95)<400'],
    http_req_failed: ['rate<0.001'],
    checks: ['rate>0.999'],
  },
};

export default function () {
  const headers = clients[Math.floor(Math.random() * clients.length)];
  const placement = placements[Math.floor(Math.random() * placements.length)];
  const res = http.get(`${BASE}/v1/feed?placement=${placement}`, {
    headers: { ...headers, 'Accept-Encoding': 'br, gzip' },
    tags: { name: 'feed' },
  });
  (res.headers['X-Feed-Cache'] === 'hit' ? hit : miss).add(res.timings.duration);
  check(res, {
    'status 200': (r) => r.status === 200,
    'ответ < 100 КБ': (r) => r.body.length < 100 * 1024,
  });
}
