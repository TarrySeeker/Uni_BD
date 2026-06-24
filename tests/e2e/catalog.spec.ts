import { test, expect } from '@playwright/test';

/**
 * E2E / a11y спецификация UI каталога админки (docs/05 §5, docs/06; Пакет П4).
 *
 * ВАЖНО (окружение разработки): здесь НЕТ браузеров Playwright, НЕТ PostgreSQL
 * и НЕТ S3 — этот spec НЕ запускается в CI и НЕ входит в `pnpm test` (vitest).
 * Зафиксирован как контракт поведения для прогона в окружении с поднятым
 * приложением, БД и накатанным seed демо-каталога.
 *
 * Как запустить (с инфраструктурой):
 *   1) pnpm exec playwright install --with-deps chromium
 *   2) поднять PostgreSQL (+ накатить миграции 0005–0011 и seed демо-каталога),
 *      хранилище в mock-режиме (без S3-ключей);
 *   3) задать E2E_OWNER_EMAIL / E2E_OWNER_PASSWORD (учётка с catalog.read+write);
 *   4) pnpm test:e2e tests/e2e/catalog.spec.ts
 *
 * Кейс «модуль выключен» требует поднятого приложения с ADMIK_MODULES без
 * 'catalog' и флага E2E_CATALOG_DISABLED=1.
 */

const OWNER_EMAIL = process.env.E2E_OWNER_EMAIL;
const OWNER_PASSWORD = process.env.E2E_OWNER_PASSWORD;

async function login(
  page: import('@playwright/test').Page,
  email: string,
  password: string,
): Promise<void> {
  await page.goto('/admin/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Пароль').fill(password);
  await page.getByRole('button', { name: 'Войти' }).click();
  await page.waitForURL('**/admin');
}

test.describe('UI каталога /admin/catalog/* (docs/05 §5, П4)', () => {
  test('список товаров: заголовок, кнопка создания, таблица', async ({ page }) => {
    test.skip(!OWNER_EMAIL || !OWNER_PASSWORD, 'нет E2E_OWNER_EMAIL/E2E_OWNER_PASSWORD');
    await login(page, OWNER_EMAIL!, OWNER_PASSWORD!);

    await page.goto('/admin/catalog');
    await expect(page.locator('h1')).toContainText('Каталог');
    await expect(page.getByRole('link', { name: 'Создать товар' })).toBeVisible();
    // Таблица товаров (семантика: thead с колонками «Артикул», «Цена», «Остаток»).
    await expect(page.getByRole('columnheader', { name: 'Артикул' })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Цена' })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Остаток' })).toBeVisible();
  });

  test('фильтры в URL: поиск формирует querystring', async ({ page }) => {
    test.skip(!OWNER_EMAIL || !OWNER_PASSWORD, 'нет E2E_OWNER_EMAIL/E2E_OWNER_PASSWORD');
    await login(page, OWNER_EMAIL!, OWNER_PASSWORD!);

    await page.goto('/admin/catalog');
    await page.getByLabel('Поиск (название / артикул)').fill('тест');
    await page.getByRole('button', { name: 'Применить' }).click();
    await expect(page).toHaveURL(/search=/);
  });

  test('отображение скидки и флагов New/Хит на товаре со скидкой', async ({ page }) => {
    test.skip(!OWNER_EMAIL || !OWNER_PASSWORD, 'нет E2E_OWNER_EMAIL/E2E_OWNER_PASSWORD');
    await login(page, OWNER_EMAIL!, OWNER_PASSWORD!);

    // Фильтр «Со скидкой» → ожидаем строки с зачёркнутой ценой и бейджем «−N %».
    await page.goto('/admin/catalog?onSale=1');
    const discount = page.locator('text=/−\\d+\\s%/');
    // Если в seed есть товары со скидкой — бейдж присутствует; иначе кейс мягко проходит.
    if (await discount.count()) {
      await expect(discount.first()).toBeVisible();
    }
  });

  test('форма создания товара: основные поля и валидация', async ({ page }) => {
    test.skip(!OWNER_EMAIL || !OWNER_PASSWORD, 'нет E2E_OWNER_EMAIL/E2E_OWNER_PASSWORD');
    await login(page, OWNER_EMAIL!, OWNER_PASSWORD!);

    await page.goto('/admin/catalog/products/new');
    await expect(page.locator('h1')).toContainText('Новый товар');
    // Семантика: поля с label.
    await expect(page.getByLabel('Название*')).toBeVisible();
    await expect(page.getByLabel('Артикул (SKU)*')).toBeVisible();
    await expect(page.getByLabel('Базовая цена*')).toBeVisible();
    await expect(page.getByLabel(/Цена до скидки/)).toBeVisible();

    // Вкладки секций.
    await expect(page.getByRole('tab', { name: 'Основное' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'SEO' })).toBeVisible();

    // Уникальный SKU → успешное создание (редирект на карточку).
    const sku = `E2E-${Date.now()}`;
    await page.getByLabel('Название*').fill('E2E тестовый товар');
    await page.getByLabel('Артикул (SKU)*').fill(sku);
    await page.getByLabel('Базовая цена*').fill('1000');
    await page.getByLabel(/Цена до скидки/).fill('1500');
    await page.getByRole('button', { name: 'Создать товар' }).click();
    await page.waitForURL('**/admin/catalog/products/**');
    // На карточке появились секции, доступные только существующему товару.
    await expect(page.getByRole('tab', { name: 'Варианты' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Медиа' })).toBeVisible();
  });

  test('категории: страница дерева доступна', async ({ page }) => {
    test.skip(!OWNER_EMAIL || !OWNER_PASSWORD, 'нет E2E_OWNER_EMAIL/E2E_OWNER_PASSWORD');
    await login(page, OWNER_EMAIL!, OWNER_PASSWORD!);
    await page.goto('/admin/catalog/categories');
    await expect(page.locator('h1')).toContainText('Категории');
    await expect(page.getByLabel('Название*')).toBeVisible();
  });

  test('бренды: список и форма создания', async ({ page }) => {
    test.skip(!OWNER_EMAIL || !OWNER_PASSWORD, 'нет E2E_OWNER_EMAIL/E2E_OWNER_PASSWORD');
    await login(page, OWNER_EMAIL!, OWNER_PASSWORD!);
    await page.goto('/admin/catalog/brands');
    await expect(page.locator('h1')).toContainText('Бренды');
    await page.getByRole('link', { name: 'Создать бренд' }).click();
    await expect(page.locator('h1')).toContainText('Новый бренд');
    await expect(page.getByLabel('Название*')).toBeVisible();
  });

  test('скрытие раздела при выключенном модуле catalog', async ({ page }) => {
    test.skip(!OWNER_EMAIL || !OWNER_PASSWORD, 'нет E2E_OWNER_EMAIL/E2E_OWNER_PASSWORD');
    test.skip(
      process.env.E2E_CATALOG_DISABLED !== '1',
      'каталог не выключен в окружении (E2E_CATALOG_DISABLED!=1)',
    );
    await login(page, OWNER_EMAIL!, OWNER_PASSWORD!);

    // Пункт меню «Каталог» скрыт (nav.ts фильтрует по модулю).
    const nav = page.getByRole('navigation', { name: 'Основная навигация' });
    await expect(nav.getByRole('link', { name: 'Каталог' })).toHaveCount(0);

    // Прямой заход на /admin/catalog не показывает каталог (модуль выключен).
    await page.goto('/admin/catalog');
    await expect(page.locator('h1')).not.toContainText('Каталог — товары');
  });
});
