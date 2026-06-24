import { test, expect } from '@playwright/test';

/**
 * E2E / a11y спецификация UI CMS-страниц админки (docs/11 §5.1.5, Пакет 5.C-3).
 *
 * ВАЖНО (окружение разработки): здесь НЕТ браузеров Playwright, НЕТ PostgreSQL —
 * этот spec НЕ запускается в CI и НЕ входит в `pnpm test` (vitest). Зафиксирован
 * как контракт поведения для прогона в окружении с поднятым приложением, БД и
 * накатанными миграциями 0022–0023 (cms_pages/cms_page_sections).
 *
 * Как запустить (с инфраструктурой):
 *   1) pnpm exec playwright install --with-deps chromium
 *   2) поднять PostgreSQL (миграции 0005–0023) + seed (учётка с cms.read+write);
 *   3) задать E2E_OWNER_EMAIL / E2E_OWNER_PASSWORD;
 *   4) pnpm test:e2e tests/e2e/cms.spec.ts
 *
 * Кейс «модуль выключен» требует поднятого приложения с ADMIK_MODULES без 'cms'
 * (флаг E2E_CMS_DISABLED=1).
 */

const OWNER_EMAIL = process.env.E2E_OWNER_EMAIL;
const OWNER_PASSWORD = process.env.E2E_OWNER_PASSWORD;
const CMS_DISABLED = process.env.E2E_CMS_DISABLED === '1';

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

test.describe('UI CMS /admin/cms/* (docs/11 §5.1.5, Пакет 5.C-3)', () => {
  test('список страниц: заголовок, кнопка создания, колонки таблицы', async ({ page }) => {
    test.skip(!OWNER_EMAIL || !OWNER_PASSWORD, 'нет E2E_OWNER_EMAIL/E2E_OWNER_PASSWORD');
    test.skip(CMS_DISABLED, 'модуль cms выключен в этом окружении');
    await login(page, OWNER_EMAIL!, OWNER_PASSWORD!);

    await page.goto('/admin/cms');
    await expect(page.locator('h1')).toContainText('Контент');
    await expect(page.getByRole('link', { name: 'Создать страницу' })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Название' })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Slug' })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Статус' })).toBeVisible();
  });

  test('фильтр в URL: поиск формирует querystring', async ({ page }) => {
    test.skip(!OWNER_EMAIL || !OWNER_PASSWORD, 'нет E2E_OWNER_EMAIL/E2E_OWNER_PASSWORD');
    test.skip(CMS_DISABLED, 'модуль cms выключен');
    await login(page, OWNER_EMAIL!, OWNER_PASSWORD!);

    await page.goto('/admin/cms');
    await page.getByLabel('Поиск').fill('главная');
    await page.getByRole('button', { name: 'Применить' }).click();
    await expect(page).toHaveURL(/search=/);
  });

  test('создание и публикация: новая страница → редактор → опубликовать', async ({
    page,
  }) => {
    test.skip(!OWNER_EMAIL || !OWNER_PASSWORD, 'нет E2E_OWNER_EMAIL/E2E_OWNER_PASSWORD');
    test.skip(CMS_DISABLED, 'модуль cms выключен');
    await login(page, OWNER_EMAIL!, OWNER_PASSWORD!);

    const title = `E2E страница ${Date.now()}`;

    await page.goto('/admin/cms/new');
    await expect(page.locator('h1')).toContainText('Новая страница');
    await page.getByLabel('Заголовок*').fill(title);
    await page.getByRole('button', { name: 'Создать страницу' }).click();

    // После создания — редирект на карточку страницы (режим редактирования).
    await expect(page).toHaveURL(/\/admin\/cms\/[0-9a-f-]+$/);
    await expect(page.locator('h1')).toContainText(title);

    // Черновик ещё не опубликован → доступна кнопка «Опубликовать».
    await page.getByRole('button', { name: 'Опубликовать' }).click();
    await expect(page.getByRole('status')).toContainText('опубликована');
    // После публикации появляется обратное действие.
    await expect(page.getByRole('button', { name: 'Снять с публикации' })).toBeVisible();
  });

  test('секции: добавление текстовой секции в редакторе страницы', async ({ page }) => {
    test.skip(!OWNER_EMAIL || !OWNER_PASSWORD, 'нет E2E_OWNER_EMAIL/E2E_OWNER_PASSWORD');
    test.skip(CMS_DISABLED, 'модуль cms выключен');
    await login(page, OWNER_EMAIL!, OWNER_PASSWORD!);

    // Открываем первую страницу из списка.
    await page.goto('/admin/cms');
    await page.locator('tbody tr td a[href^="/admin/cms/"]').first().click();
    await expect(page).toHaveURL(/\/admin\/cms\/[0-9a-f-]+$/);

    // Блок секций присутствует, выбираем тип и добавляем.
    await expect(page.getByRole('heading', { name: 'Секции страницы' })).toBeVisible();
    await page.getByLabel('Тип секции').selectOption('text');
    await page.getByRole('button', { name: 'Добавить секцию' }).click();

    // Появляется форма новой секции (черновик до сохранения).
    await expect(page.getByText('Новая секция: Текстовый блок')).toBeVisible();
  });

  test('раздел скрыт при выключенном модуле cms (нет пункта меню / Forbidden)', async ({
    page,
  }) => {
    test.skip(!OWNER_EMAIL || !OWNER_PASSWORD, 'нет E2E_OWNER_EMAIL/E2E_OWNER_PASSWORD');
    test.skip(!CMS_DISABLED, 'кейс активен только при E2E_CMS_DISABLED=1');
    await login(page, OWNER_EMAIL!, OWNER_PASSWORD!);

    // Пункт меню «Контент» отсутствует.
    await expect(page.getByRole('link', { name: 'Контент' })).toHaveCount(0);
    // Прямой переход → блок «модуль выключен» (Forbidden).
    await page.goto('/admin/cms');
    await expect(page.getByRole('alert')).toContainText('модуль выключен');
  });
});
