import { defineConfig, devices } from '@playwright/test';

/**
 * Конфигурация Playwright для e2e/a11y каркаса админки (docs/04 §6, задача 1.4).
 *
 * ОТДЕЛЬНО от vitest: vitest гоняет только `tests/*.test.ts(x)` (см. vitest.config.ts),
 * а Playwright — только `tests/e2e/*.spec.ts`. Поэтому e2e НЕ ломает юнит-CI
 * (`pnpm test`). Прогон e2e — через отдельный скрипт `pnpm test:e2e`.
 *
 * Запуск требует инфраструктуры (браузеры Playwright + поднятое приложение + БД):
 *   pnpm exec playwright install --with-deps chromium
 *   PLAYWRIGHT_BASE_URL=http://localhost:3000 pnpm test:e2e
 *
 * webServer ниже автоматически поднимает `pnpm dev`, если базовый URL не задан
 * извне (для локального прогона). В CI обычно задают PLAYWRIGHT_BASE_URL на уже
 * поднятый инстанс и отключают webServer переменной PLAYWRIGHT_NO_WEBSERVER=1.
 */

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3000';
const useExternalServer = Boolean(process.env.PLAYWRIGHT_NO_WEBSERVER);

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  // Поднимаем dev-сервер автоматически только когда не указан внешний URL.
  webServer: useExternalServer
    ? undefined
    : {
        command: 'pnpm dev',
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
});
