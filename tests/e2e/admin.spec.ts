import { test, expect } from '@playwright/test';

/**
 * E2E / a11y спецификация каркаса админки (docs/04 §6, задача 1.4).
 *
 * ВАЖНО (окружение разработки): в этом окружении НЕТ браузеров Playwright,
 * НЕТ PostgreSQL и НЕТ Redis, поэтому данный spec НЕ запускается в CI и НЕ
 * входит в `pnpm test` (vitest). Он зафиксирован как контракт поведения для
 * прогона в окружении с поднятым приложением и БД.
 *
 * Как запустить локально/в CI с инфраструктурой:
 *   1) pnpm exec playwright install --with-deps chromium
 *   2) поднять PostgreSQL + Redis, накатить миграции и seed (scripts/init-shop.sh),
 *      создать пользователей под тест-кейсы (owner / manager / без прав);
 *   3) задать PLAYWRIGHT_BASE_URL (или поднять `pnpm dev` — webServer в конфиге);
 *   4) pnpm test:e2e
 *
 * Чтобы тесты были детерминированы, ожидаются переменные окружения с тестовыми
 * учётками (иначе соответствующие кейсы пропускаются):
 *   E2E_OWNER_EMAIL / E2E_OWNER_PASSWORD       — владелец (видит все пункты ядра)
 *   E2E_MANAGER_EMAIL / E2E_MANAGER_PASSWORD   — менеджер (нет users/roles, есть audit)
 */

const OWNER_EMAIL = process.env.E2E_OWNER_EMAIL;
const OWNER_PASSWORD = process.env.E2E_OWNER_PASSWORD;
const MANAGER_EMAIL = process.env.E2E_MANAGER_EMAIL;
const MANAGER_PASSWORD = process.env.E2E_MANAGER_PASSWORD;

/** Хелпер логина через форму /admin/login. */
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

test.describe('Каркас админки /admin/* (docs/04 §6)', () => {
  test('неавторизованный пользователь редиректится на /admin/login', async ({
    page,
  }) => {
    // Гвард middleware (§5.3): нет cookie сессии → быстрый редирект на логин.
    await page.goto('/admin');
    await expect(page).toHaveURL(/\/admin\/login$/);

    // На странице логина видна форма, но НЕТ admin-навигации.
    await expect(page.getByRole('button', { name: 'Войти' })).toBeVisible();
    await expect(
      page.getByRole('navigation', { name: 'Основная навигация' }),
    ).toHaveCount(0);
  });

  test('защищённые разделы недоступны без сессии (редирект на логин)', async ({
    page,
  }) => {
    for (const path of ['/admin/audit', '/admin/users', '/admin/roles']) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/admin\/login$/);
    }
  });

  test('страница логина проходит базовую a11y-проверку', async ({ page }) => {
    await page.goto('/admin/login');

    // Семантика: ровно один h1, форма, label у инпутов email/пароль.
    await expect(page.locator('h1')).toHaveCount(1);
    await expect(page.getByLabel('Email')).toBeVisible();
    await expect(page.getByLabel('Пароль')).toBeVisible();

    // Инпуты связаны с label через for/id (getByLabel это проверяет неявно).
    await expect(page.getByLabel('Email')).toHaveAttribute('type', 'email');
    await expect(page.getByLabel('Пароль')).toHaveAttribute('type', 'password');
  });

  test('неверные креды → единое сообщение об ошибке', async ({ page }) => {
    await page.goto('/admin/login');
    await page.getByLabel('Email').fill('nobody@example.com');
    await page.getByLabel('Пароль').fill('wrong-password');
    await page.getByRole('button', { name: 'Войти' }).click();

    // §4.4: единое сообщение, не раскрывающее, что именно неверно.
    await expect(page.getByRole('alert')).toContainText(
      'Неверный email или пароль',
    );
    await expect(page).toHaveURL(/\/admin\/login$/);
  });

  test('owner после логина видит навигацию и пункты ядра', async ({ page }) => {
    test.skip(
      !OWNER_EMAIL || !OWNER_PASSWORD,
      'нет E2E_OWNER_EMAIL/E2E_OWNER_PASSWORD',
    );
    await login(page, OWNER_EMAIL!, OWNER_PASSWORD!);

    const nav = page.getByRole('navigation', { name: 'Основная навигация' });
    await expect(nav).toBeVisible();

    // owner видит все пункты ядра.
    await expect(nav.getByRole('link', { name: 'Дашборд' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Пользователи' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Роли' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Аудит' })).toBeVisible();
  });

  test('пункт скрыт без права: менеджер не видит «Пользователи»/«Роли»', async ({
    page,
  }) => {
    test.skip(
      !MANAGER_EMAIL || !MANAGER_PASSWORD,
      'нет E2E_MANAGER_EMAIL/E2E_MANAGER_PASSWORD',
    );
    await login(page, MANAGER_EMAIL!, MANAGER_PASSWORD!);

    const nav = page.getByRole('navigation', { name: 'Основная навигация' });
    // §6.3: нет права users.read/roles.manage → пункты скрыты (двойная защита).
    await expect(nav.getByRole('link', { name: 'Пользователи' })).toHaveCount(0);
    await expect(nav.getByRole('link', { name: 'Роли' })).toHaveCount(0);
    // Но audit.read у менеджера есть → «Аудит» виден.
    await expect(nav.getByRole('link', { name: 'Аудит' })).toBeVisible();
  });

  test('выключенный модуль не показывает раздел в меню', async ({ page }) => {
    test.skip(
      !OWNER_EMAIL || !OWNER_PASSWORD,
      'нет E2E_OWNER_EMAIL/E2E_OWNER_PASSWORD',
    );
    // Требует, чтобы приложение было поднято с ADMIK_MODULES без 'catalog'.
    test.skip(
      process.env.E2E_CATALOG_DISABLED !== '1',
      'каталог не выключен в окружении (E2E_CATALOG_DISABLED!=1)',
    );
    await login(page, OWNER_EMAIL!, OWNER_PASSWORD!);

    const nav = page.getByRole('navigation', { name: 'Основная навигация' });
    await expect(nav.getByRole('link', { name: 'Каталог' })).toHaveCount(0);
  });

  test('logout очищает сессию и возвращает на логин', async ({ page }) => {
    test.skip(
      !OWNER_EMAIL || !OWNER_PASSWORD,
      'нет E2E_OWNER_EMAIL/E2E_OWNER_PASSWORD',
    );
    await login(page, OWNER_EMAIL!, OWNER_PASSWORD!);
    await page.getByRole('button', { name: 'Выйти' }).click();
    await expect(page).toHaveURL(/\/admin\/login$/);

    // Сессия погашена: повторный заход в /admin снова редиректит на логин.
    await page.goto('/admin');
    await expect(page).toHaveURL(/\/admin\/login$/);
  });
});
