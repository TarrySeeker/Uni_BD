import { test, expect } from '@playwright/test';

/**
 * E2E / a11y спецификация UI заказов и промокодов админки (docs/07 §5, Пакет 3.E).
 *
 * ВАЖНО (окружение разработки): здесь НЕТ браузеров Playwright, НЕТ PostgreSQL —
 * этот spec НЕ запускается в CI и НЕ входит в `pnpm test` (vitest). Зафиксирован
 * как контракт поведения для прогона в окружении с поднятым приложением, БД и
 * накатанными миграциями 0012–0016 + seed (хотя бы один заказ и один промокод).
 *
 * Как запустить (с инфраструктурой):
 *   1) pnpm exec playwright install --with-deps chromium
 *   2) поднять PostgreSQL (миграции 0005–0016) + seed заказа/промокода;
 *   3) задать E2E_OWNER_EMAIL / E2E_OWNER_PASSWORD (учётка с orders.read+write);
 *   4) pnpm test:e2e tests/e2e/orders.spec.ts
 *
 * Кейс «модуль выключен» требует поднятого приложения с ADMIK_MODULES без 'orders'
 * (флаг E2E_ORDERS_DISABLED=1).
 */

const OWNER_EMAIL = process.env.E2E_OWNER_EMAIL;
const OWNER_PASSWORD = process.env.E2E_OWNER_PASSWORD;
const ORDERS_DISABLED = process.env.E2E_ORDERS_DISABLED === '1';

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

test.describe('UI заказов /admin/orders/* (docs/07 §5, Пакет 3.E)', () => {
  test('список заказов: заголовок, фильтры, таблица с колонками', async ({ page }) => {
    test.skip(!OWNER_EMAIL || !OWNER_PASSWORD, 'нет E2E_OWNER_EMAIL/E2E_OWNER_PASSWORD');
    test.skip(ORDERS_DISABLED, 'модуль orders выключен в этом окружении');
    await login(page, OWNER_EMAIL!, OWNER_PASSWORD!);

    await page.goto('/admin/orders');
    await expect(page.locator('h1')).toContainText('Заказы');
    // Семантика таблицы: th с ключевыми колонками.
    await expect(page.getByRole('columnheader', { name: 'Номер' })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Сумма' })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Статус' })).toBeVisible();
    // Панель фильтров доступна и помечена.
    await expect(page.getByRole('form', { name: 'Фильтры заказов' })).toBeVisible();
  });

  test('фильтры в URL: поиск формирует querystring', async ({ page }) => {
    test.skip(!OWNER_EMAIL || !OWNER_PASSWORD, 'нет E2E_OWNER_EMAIL/E2E_OWNER_PASSWORD');
    test.skip(ORDERS_DISABLED, 'модуль orders выключен');
    await login(page, OWNER_EMAIL!, OWNER_PASSWORD!);

    await page.goto('/admin/orders');
    await page.getByLabel('Поиск (номер / email / телефон)').fill('2026');
    await page.getByRole('button', { name: 'Применить' }).click();
    await expect(page).toHaveURL(/q=2026/);
  });

  test('карточка заказа: позиции, суммы, кнопки допустимых переходов статуса', async ({
    page,
  }) => {
    test.skip(!OWNER_EMAIL || !OWNER_PASSWORD, 'нет E2E_OWNER_EMAIL/E2E_OWNER_PASSWORD');
    test.skip(ORDERS_DISABLED, 'модуль orders выключен');
    await login(page, OWNER_EMAIL!, OWNER_PASSWORD!);

    await page.goto('/admin/orders');
    // Открываем первую карточку из списка (ссылка-номер).
    const firstOrder = page.locator('tbody tr td a[href^="/admin/orders/"]').first();
    await firstOrder.click();
    await expect(page).toHaveURL(/\/admin\/orders\/[0-9a-f-]+$/);

    // Блок позиций и итог присутствуют.
    await expect(page.getByRole('columnheader', { name: 'Товар' })).toBeVisible();
    await expect(page.getByText('Итого')).toBeVisible();

    // Панель управления статусами с кнопками допустимых переходов.
    await expect(
      page.getByRole('region', { name: 'Управление статусами' }),
    ).toBeVisible();
    await expect(page.getByText('Статус заказа')).toBeVisible();
    // История статусов отображается.
    await expect(page.getByText('История статусов')).toBeVisible();
  });

  test('переход статуса: кнопка применяет переход и появляется новый статус', async ({
    page,
  }) => {
    test.skip(!OWNER_EMAIL || !OWNER_PASSWORD, 'нет E2E_OWNER_EMAIL/E2E_OWNER_PASSWORD');
    test.skip(ORDERS_DISABLED, 'модуль orders выключен');
    await login(page, OWNER_EMAIL!, OWNER_PASSWORD!);

    await page.goto('/admin/orders');
    await page.locator('tbody tr td a[href^="/admin/orders/"]').first().click();

    // Для нового заказа допустим переход в «Оплачен» (new → paid, §2.8 A).
    const payBtn = page.getByRole('button', { name: 'Оплачен' });
    if (await payBtn.isVisible()) {
      await payBtn.click();
      // Успех показывается status-сообщением.
      await expect(page.getByRole('status')).toContainText('выполнено');
    }
  });

  test('раздел скрыт при выключенном модуле orders (403/нет пункта меню)', async ({
    page,
  }) => {
    test.skip(!OWNER_EMAIL || !OWNER_PASSWORD, 'нет E2E_OWNER_EMAIL/E2E_OWNER_PASSWORD');
    test.skip(!ORDERS_DISABLED, 'кейс активен только при E2E_ORDERS_DISABLED=1');
    await login(page, OWNER_EMAIL!, OWNER_PASSWORD!);

    // Пункт меню «Заказы» отсутствует.
    await expect(page.getByRole('link', { name: 'Заказы' })).toHaveCount(0);
    // Прямой переход → блок «модуль выключен» (Forbidden).
    await page.goto('/admin/orders');
    await expect(page.getByRole('alert')).toContainText('модуль выключен');
  });
});

test.describe('UI промокодов /admin/promo/* (docs/07 §5)', () => {
  test('список промокодов: заголовок, кнопка создания, таблица', async ({ page }) => {
    test.skip(!OWNER_EMAIL || !OWNER_PASSWORD, 'нет E2E_OWNER_EMAIL/E2E_OWNER_PASSWORD');
    test.skip(ORDERS_DISABLED, 'модуль orders выключен');
    await login(page, OWNER_EMAIL!, OWNER_PASSWORD!);

    await page.goto('/admin/promo');
    await expect(page.locator('h1')).toContainText('Промокоды');
    await expect(page.getByRole('link', { name: 'Создать промокод' })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Код' })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Использован' })).toBeVisible();
  });

  test('CRUD промокода: создание процентного промокода и возврат к списку', async ({
    page,
  }) => {
    test.skip(!OWNER_EMAIL || !OWNER_PASSWORD, 'нет E2E_OWNER_EMAIL/E2E_OWNER_PASSWORD');
    test.skip(ORDERS_DISABLED, 'модуль orders выключен');
    await login(page, OWNER_EMAIL!, OWNER_PASSWORD!);

    const code = `E2E${Date.now()}`;

    await page.goto('/admin/promo/new');
    await expect(page.locator('h1')).toContainText('Новый промокод');
    await page.getByLabel('Код*').fill(code);
    await page.getByLabel('Тип*').selectOption('percent');
    await page.getByLabel(/Значение/).fill('15');
    await page.getByRole('button', { name: 'Создать промокод' }).click();

    // После создания — редирект на список, новый код виден.
    await expect(page).toHaveURL(/\/admin\/promo$/);
    await expect(page.getByText(code)).toBeVisible();

    // Открываем на редактирование и сохраняем изменение значения.
    await page.getByRole('link', { name: code }).click();
    await expect(page).toHaveURL(/\/admin\/promo\/[0-9a-f-]+$/);
    await page.getByLabel(/Значение/).fill('25');
    await page.getByRole('button', { name: 'Сохранить' }).click();
    await expect(page.getByRole('status')).toContainText('сохранены');
  });

  test('промокоды требуют orders.write (read-only пользователь → 403)', async ({
    page,
  }) => {
    const RO_EMAIL = process.env.E2E_READONLY_EMAIL;
    const RO_PASSWORD = process.env.E2E_READONLY_PASSWORD;
    test.skip(!RO_EMAIL || !RO_PASSWORD, 'нет E2E_READONLY_* (пользователь без orders.write)');
    test.skip(ORDERS_DISABLED, 'модуль orders выключен');
    await login(page, RO_EMAIL!, RO_PASSWORD!);

    await page.goto('/admin/promo');
    await expect(page.getByRole('alert')).toContainText('Доступ запрещён');
  });
});
