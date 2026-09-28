// Нагрузочный тест приёма событий: батчи по 20 событий.
//   k6 run -e PUBLIC_URL=http://localhost:8080 ops/k6/events.js
import http from 'k6/http';
import { check } from 'k6';
import { uuidv4 } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';

const BASE = __ENV.PUBLIC_URL || 'http://localhost:8080';

export const options = {
  scenarios: {
    events: {
      executor: 'constant-arrival-rate',
      rate: Number(__ENV.RPS || 200),
      timeUnit: '1s',
      duration: __ENV.DURATION || '2m',
      preAllocatedVUs: 50,
      maxVUs: 200,
    },
  },
  thresholds: { http_req_duration: ['p(95)<200'], http_req_failed: ['rate<0.001'] },
};

export default function () {
  const group = __ENV.GROUP_ID || '00000000-0000-4000-8000-000000000001';
  const events = Array.from({ length: 20 }, (_, i) => ({
    event_id: uuidv4(),
    event: i === 0 ? 'story_group_open' : 'story_slide_view',
    ts: new Date().toISOString(),
    session_id: `k6-${__VU}`,
    platform: 'web',
    app_version: 'web',
    placement: 'home',
    group_id: group,
    group_version: 1,
    ...(i === 0 ? { source: 'tap' } : { slide_id: group, slide_index: 0, slide_type: 'image' }),
  }));
  const res = http.post(`${BASE}/v1/events`, JSON.stringify({ events }), {
    headers: { 'Content-Type': 'application/json' },
  });
  check(res, { 'status 202': (r) => r.status === 202 });
}
