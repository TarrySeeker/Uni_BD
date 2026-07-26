// =============================================================================
// scripts/verify-admin-i18n.mjs
// -----------------------------------------------------------------------------
// Живая браузерная проверка локализации админки: логин → обход разделов в каждой
// локали → детект двух классов дефектов.
//
// ЗАЧЕМ ИМЕННО ТАК: код-гейт (typecheck/lint/vitest/build) НЕ видит, что оператор
// переключил язык, а раздел остался русским — переводы резолвятся в рантайме.
// CLAUDE.md платформы требует «две проверки: код + браузер»; это вторая.
//
// ДЕТЕКТИРУЕТ:
//   • ru-leak  — при локали en/fr отрендерилось ТОЧНОЕ значение ключа из
//                messages/ru.json. Именно точное значение, а не «в тексте есть
//                кириллица»: данные магазина (названия товаров, категорий) по-русски
//                — это НОРМА, ложные срабатывания на них бесполезны.
//   • no-l10n  — раздел не отдал ожидаемую строку вовсе (пустая страница, 500,
//                редирект на логин).
//
// ЗАПУСК:
//   ADMIN_URL=https://admin.erfgv.website ADMIN_EMAIL=... ADMIN_PASSWORD=... \
//     node scripts/verify-admin-i18n.mjs [--locales=ru,en,fr] [--out=/tmp/i18n-report.json]
//
// ТРЕБОВАНИЯ: @playwright/test (уже в devDependencies) + системные библиотеки
// браузера. Если launch падает с «Target page, context or browser has been closed» —
// это НЕ несовместимость ревизий chromium, а отсутствие системных библиотек:
//   sudo npx playwright install-deps chromium
// (диагностика: <кэш>/chromium-*/chrome-linux64/chrome --version покажет
// «error while loading shared libraries: libglib-2.0.so.0»).
//
// КОД ВОЗВРАТА: 0 — дефектов нет; 1 — найдены дефекты; 2 — ошибка запуска.
// =============================================================================

import { readFileSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const arg = (name, def) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
};

const BASE = (process.env.ADMIN_URL ?? '').replace(/\/+$/, '');
const EMAIL = process.env.ADMIN_EMAIL ?? '';
const PASSWORD = process.env.ADMIN_PASSWORD ?? '';
const LOCALES = arg('locales', 'ru,en,fr').split(',').filter(Boolean);
const OUT = arg('out', '');

if (!BASE || !EMAIL || !PASSWORD) {
  console.error('Нужны ADMIN_URL, ADMIN_EMAIL, ADMIN_PASSWORD в окружении.');
  process.exit(2);
}

/**
 * Модули, под которыми живут разделы. Раздел выключенного модуля закрыт серверным
 * гвардом (`guardNews`/`guardReviews`/…: `module_disabled`) — это НЕ дефект локализации,
 * а конфигурация магазина. Такие разделы помечаем «пропущен», иначе инструмент шумит
 * на каждом прогоне (на стенде ADMIK_MODULES=catalog,orders,cdek,cms,payments —
 * news/reviews/account выключены).
 */
const SECTION_MODULE = {
  '/admin/catalog': 'catalog',
  '/admin/catalog/categories': 'catalog',
  '/admin/catalog/designers': 'catalog',
  '/admin/orders': 'orders',
  '/admin/promo': 'orders',
  '/admin/gift-certificates': 'orders',
  '/admin/cdek': 'cdek',
  '/admin/cms': 'cms',
  '/admin/news': 'news',
  '/admin/reviews': 'reviews',
  '/admin/customers': 'account',
};

/**
 * Разделы админки: путь → ключ ru.json, по которому опознаём успешный рендер.
 * Ключ должен быть строкой БОКОВОГО МЕНЮ (nav.*) — она присутствует на каждой
 * странице панели, в отличие от заголовков разделов, которые живут в своих
 * namespace и различаются по формулировке.
 * ⚠️ Списка товаров по пути /admin/catalog/products НЕТ: под products лежат только
 * `new` и `[id]`, а список товаров — на /admin/catalog (проверено, иначе получишь 404).
 */
const SECTIONS = [
  ['/admin', 'nav.dashboard'],
  ['/admin/catalog', 'nav.catalog'],
  ['/admin/catalog/categories', 'nav.catalog'],
  ['/admin/catalog/designers', 'nav.catalog'],
  ['/admin/orders', 'nav.orders'],
  ['/admin/promo', 'nav.promo'],
  ['/admin/gift-certificates', 'nav.giftCertificates'],
  ['/admin/leads', 'nav.leads'],
  ['/admin/subscribers', 'nav.subscribers'],
  ['/admin/cdek', 'nav.cdek'],
  ['/admin/cms', 'nav.cms'],
  ['/admin/news', 'nav.news'],
  ['/admin/reviews', 'nav.reviews'],
  ['/admin/customers', 'nav.customers'],
  ['/admin/users', 'nav.users'],
  ['/admin/roles', 'nav.roles'],
  ['/admin/audit', 'nav.audit'],
  ['/admin/settings', 'nav.settings'],
  ['/admin/settings/languages', 'nav.settings'],
];

const ru = JSON.parse(readFileSync(new URL('../messages/ru.json', import.meta.url), 'utf8'));

/** Значение по точечному пути; undefined, если ключа нет. */
const at = (obj, dotted) => dotted.split('.').reduce((acc, k) => (acc == null ? acc : acc[k]), obj);

/**
 * Строки, которые ОСОЗНАННО остаются на своём языке во всех локалях, — не дефект:
 * переключатель языка намеренно показывает «Русский / English / Français»
 * независимо от текущей локали (app/admin/(panel)/_components/LocaleSwitcher.tsx:16),
 * иначе оператор, случайно переключившийся на незнакомый язык, не найдёт дорогу назад.
 */
const ALLOWED_NATIVE = new Set(['Русский', 'English', 'Français']);

/**
 * Русские строки ИНТЕРФЕЙСА, утечку которых ищем. Берём только ветки
 * интерфейса (не контент магазина), длиной ≥6 и без ICU-плейсхолдеров:
 * короткие слова дают ложные срабатывания внутри данных.
 */
function interfaceStrings() {
  const out = new Set();
  const walk = (node) => {
    if (typeof node === 'string') {
      const s = node.trim();
      if (s.length >= 6 && !/[{}]/.test(s) && /[А-Яа-яЁё]/.test(s) && !ALLOWED_NATIVE.has(s)) out.add(s);
      return;
    }
    if (node && typeof node === 'object') Object.values(node).forEach(walk);
  };
  for (const branch of ['nav', 'common', 'layout', 'fields', 'login', 'dashboard', 'audit', 'permissions']) {
    if (ru[branch]) walk(ru[branch]);
  }
  return [...out];
}

const RU_UI = interfaceStrings();

async function login(page) {
  await page.goto(`${BASE}/admin/login`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.fill('[data-testid="login-email"], input[type="email"], input[name="email"]', EMAIL);
  await page.fill('[data-testid="login-password"], input[type="password"], input[name="password"]', PASSWORD);
  await page.click('[data-testid="login-submit"], button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.endsWith('/login'), { timeout: 60000 });
}

async function main() {
  const browser = await chromium.launch();
  const findings = [];
  const skipped = [];
  let checked = 0;

  try {
    for (const locale of LOCALES) {
      // Локаль оператора живёт в cookie NEXT_LOCALE (пишется из users.ui_locale).
      const context = await browser.newContext({
        locale,
        extraHTTPHeaders: { 'Accept-Language': locale },
      });
      const page = await context.newPage();
      await context.addCookies([
        { name: 'NEXT_LOCALE', value: locale, url: BASE },
      ]);
      await login(page);
      // Логин мог сбросить cookie — ставим повторно и перечитываем страницу.
      await context.addCookies([{ name: 'NEXT_LOCALE', value: locale, url: BASE }]);

      for (const [path, expectKey] of SECTIONS) {
        checked += 1;
        const url = `${BASE}${path}`;
        let body = '';
        let status = 0;
        try {
          const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
          status = res?.status() ?? 0;
          body = await page.evaluate(() => document.body?.innerText ?? '');
        } catch (err) {
          findings.push({ locale, path, kind: 'no-l10n', detail: `навигация упала: ${err.message.split('\n')[0]}` });
          continue;
        }

        if (status >= 400) {
          findings.push({ locale, path, kind: 'no-l10n', detail: `HTTP ${status}` });
          continue;
        }
        if (page.url().includes('/login')) {
          findings.push({ locale, path, kind: 'no-l10n', detail: 'выброшен на логин (нет доступа/сессия)' });
          continue;
        }

        const expected = at(ru, expectKey);
        if (locale === 'ru' && typeof expected === 'string' && expected && !body.includes(expected)) {
          // Раздел выключенного модуля закрыт гвардом — пропускаем, а не считаем дефектом.
          const mod = SECTION_MODULE[path];
          if (mod) {
            skipped.push({ locale, path, module: mod });
          } else {
            findings.push({ locale, path, kind: 'no-l10n', detail: `не найдена ожидаемая строка «${expected}»` });
          }
        }

        if (locale !== 'ru') {
          // Отсекаем ложные срабатывания на ДАННЫХ магазина: в списках админка
          // показывает базовое (русское) имя сущности — это канон для оператора,
          // а не непереведённый интерфейс. Поэтому на страницах-списках сущностей
          // строки, совпадающие с nav.*, не считаем утечкой: одноимённая категория
          // («Каталог») или CMS-страница («Доставка») есть в БД магазина.
          const dataHeavy = /\/(catalog|cms|news|reviews|customers|orders)(\/|$)/.test(path);
          const navValues = new Set(Object.values(ru.nav ?? {}));
          const leaked = RU_UI
            .filter((s) => body.includes(s))
            .filter((s) => !(dataHeavy && navValues.has(s)));
          if (leaked.length > 0) {
            findings.push({
              locale,
              path,
              kind: 'ru-leak',
              detail: `русский интерфейс при локали ${locale}: ${leaked.slice(0, 8).map((s) => `«${s}»`).join(', ')}${leaked.length > 8 ? ` и ещё ${leaked.length - 8}` : ''}`,
            });
          }
        }
      }
      await context.close();
    }
  } finally {
    await browser.close();
  }

  console.log(`Проверено ${checked} страниц (${SECTIONS.length} разделов × ${LOCALES.length} локали).`);
  if (skipped.length > 0) {
    const mods = [...new Set(skipped.map((s) => s.module))].join(', ');
    console.log(`Пропущено ${skipped.length} (разделы выключенных модулей: ${mods}).`);
  }
  console.log(`Эталонных строк интерфейса в ru.json: ${RU_UI.length}.`);
  if (findings.length === 0) {
    console.log('✅ Дефектов локализации не найдено.');
  } else {
    console.log(`🔴 Найдено ${findings.length} дефектов:`);
    for (const f of findings) console.log(`  [${f.kind}] ${f.locale} ${f.path} — ${f.detail}`);
  }
  if (OUT) {
    writeFileSync(OUT, JSON.stringify({ checked, findings, skipped }, null, 1));
    console.log(`Отчёт: ${OUT}`);
  }
  process.exit(findings.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Фатальная ошибка:', err);
  process.exit(2);
});
