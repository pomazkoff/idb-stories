/** Dev-инструмент: выпустить mock-токен покупателя для проверки персональной ленты. */
import { MockCustomerAuthAdapter } from '@idb-stories/adapters';

if (process.env.NODE_ENV === 'production') throw new Error('Недоступно в production');
const userId = process.argv[2] ?? 'user-gold-1';
const adapter = new MockCustomerAuthAdapter({
  secret: process.env.CUSTOMER_AUTH_MOCK_SECRET ?? '',
  issuer: process.env.CUSTOMER_AUTH_ISSUER ?? 'https://id.iledebeaute.example',
  audience: process.env.CUSTOMER_AUTH_AUDIENCE ?? 'stories',
});
console.log(await adapter.issue(userId));
