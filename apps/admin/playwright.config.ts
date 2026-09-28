/// <reference types="node" />
import { defineConfig, devices } from '@playwright/test';

/**
 * E2E против поднятого стенда (`docker compose up --build`):
 *   E2E_BASE_URL   — админка (по умолчанию http://localhost:8082)
 *   E2E_PUBLIC_API — публичный API ленты (по умолчанию http://localhost:8080)
 */
export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // Сценарий включает обработку медиа воркером и ожидание ленты — даём запас.
  timeout: 5 * 60_000,
  expect: { timeout: 15_000 },
  // github — аннотации к упавшим тестам видны в Actions без чтения логов.
  reporter: process.env.CI ? [['github'], ['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:8082',
    locale: 'ru-RU',
    timezoneId: 'Europe/Moscow',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
