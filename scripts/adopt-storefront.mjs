// =============================================================================
// scripts/adopt-storefront.mjs
// -----------------------------------------------------------------------------
// «Приём макета витрины»: распознаёт ЧУЖОЙ репозиторий магазина и печатает отчёт
// о том, с чем предстоит работать, — до того как начнётся онбординг.
//
// ЗАЧЕМ. Типичный вход платформы: владелец присылает ссылку на репозиторий (или
// zip) с готовым макетом сайта и говорит «сделай админку». До сих пор инструкция
// начиналась ШАГОМ ПОЗЖЕ — с предположения, что макет уже лежит в ./storefront и
// написан на Next.js. На практике не совпадало ни то, ни другое: приходили
// статический HTML+ванильный JS и выгрузка с чужой CMS. Каждый онбординг тратил
// первые часы на ручную разведку одного и того же.
//
// ЧТО ДЕЛАЕТ. Только ЧИТАЕТ и печатает — ничего не меняет и не устанавливает.
// Определяет тип макета, точку входа, наличие Dockerfile и совместимость с
// контрактом docker-compose (порт 3000), находит страницы, статические данные
// каталога, следы чужого бэкенда, секреты в открытом виде и файлы, которые нельзя
// публиковать. Вывод — готовый черновик «профиля макета» для Этапа 1 docs/20.
//
// ЗАПУСК:
//   node scripts/adopt-storefront.mjs [путь]     # по умолчанию ./storefront
//   node scripts/adopt-storefront.mjs --json     # машиночитаемо
// =============================================================================

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, extname, basename, relative } from 'node:path';

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const root = args.find((a) => !a.startsWith('--')) ?? 'storefront';

/** Каталоги, которые не несут информации о макете и только замедляют обход. */
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.next', 'dist', 'build', 'out', '.cache',
  'coverage', '.turbo', 'vendor', '.venv', '__pycache__',
]);

/** Расширения, которые считаем «страницами» статического макета. */
const PAGE_EXT = new Set(['.html', '.htm']);

/**
 * Файлы, которые НЕЛЬЗЯ отдавать в публичную раздачу. Урок с боевого запуска:
 * `COPY . .` в Dockerfile витрины выложил в открытый доступ внутреннюю
 * документацию с ТЗ заказчика — она отдавалась по прямой ссылке всем желающим.
 */
const MUST_NOT_PUBLISH = [
  /^claude\.md$/i, /^gpt\.md$/i, /^agents?\.md$/i, /^readme\.md$/i,
  /^todo\.md$/i, /^тз\b/i, /\.env($|\.)/i, /^docker-compose/i, /\.sql$/i,
];

/** Признаки секрета в открытом виде — грубая эвристика, только для сигнала. */
const SECRET_HINTS = [
  /sk_live_[A-Za-z0-9]/, /AKIA[0-9A-Z]{16}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /(api[_-]?key|secret|password|token)\s*[:=]\s*['"][^'"]{16,}['"]/i,
];

function walk(dir, acc = [], depth = 0) {
  if (depth > 8) return acc;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.env' && e.name !== '.env.example') {
      if (e.isDirectory()) continue;
    }
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(full, acc, depth + 1);
    } else {
      acc.push(full);
    }
  }
  return acc;
}

function readSafe(p) {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}

function readJson(p) {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Определяет тип макета. Порядок проверок важен: Next.js опознаётся по
 * зависимости, а не по наличию каталога `app/` — он бывает и у других сборок.
 */
function detectKind(dir, files, pkg) {
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  if (deps.next) return { kind: 'nextjs', label: 'Next.js', confident: true };
  if (deps.nuxt) return { kind: 'nuxt', label: 'Nuxt (Vue)', confident: true };
  if (deps.astro) return { kind: 'astro', label: 'Astro', confident: true };
  if (deps['@sveltejs/kit']) return { kind: 'sveltekit', label: 'SvelteKit', confident: true };
  if (deps.vite && (deps.react || deps.vue)) {
    return { kind: 'vite-spa', label: 'SPA на Vite', confident: true };
  }
  if (deps.gatsby) return { kind: 'gatsby', label: 'Gatsby', confident: true };

  const html = files.filter((f) => PAGE_EXT.has(extname(f).toLowerCase()));
  if (html.length > 0) {
    return {
      kind: 'static',
      label: 'Статический сайт (HTML + CSS + JS)',
      confident: true,
    };
  }
  if (files.some((f) => extname(f) === '.php')) {
    return { kind: 'php', label: 'PHP-сайт (вероятно, чужая CMS)', confident: true };
  }
  if (pkg) return { kind: 'node-unknown', label: 'Node-проект (фреймворк не опознан)', confident: false };
  return { kind: 'unknown', label: 'Не опознан', confident: false };
}

/** Фреймворки, где маршруты задаются файлами роутера, а не .html-страницами. */
function isRouterBased(kind) {
  return ['nextjs', 'nuxt', 'astro', 'sveltekit', 'gatsby', 'vite-spa'].includes(kind);
}

/**
 * Маршруты фреймворкового макета: файлы вида app/**\/page.tsx (App Router),
 * pages/**\/*.tsx (Pages Router), src/routes/** (SvelteKit), src/pages/** (Astro).
 * Возвращает URL-подобные пути, а не имена файлов, — так карта сайта читается
 * сразу, без мысленного перевода из структуры каталогов.
 */
function findRouteFiles(dir, files) {
  const routes = new Set();
  for (const f of files) {
    const rel = relative(dir, f).replace(/\\/g, '/');
    const ext = extname(rel).toLowerCase();
    if (!['.tsx', '.jsx', '.ts', '.js', '.vue', '.svelte', '.astro'].includes(ext)) continue;

    // Next.js App Router: app/<путь>/page.tsx
    let m = rel.match(/(?:^|\/)(?:src\/)?app\/(.*)\/page\.[jt]sx?$/);
    if (m) {
      routes.add('/' + m[1].replace(/\(.*?\)\//g, '').replace(/\/+$/, ''));
      continue;
    }
    if (/(?:^|\/)(?:src\/)?app\/page\.[jt]sx?$/.test(rel)) {
      routes.add('/');
      continue;
    }
    // Next.js Pages Router / Nuxt / Astro / SvelteKit
    m = rel.match(/(?:^|\/)(?:src\/)?(?:pages|routes)\/(.+)\.(?:[jt]sx?|vue|svelte|astro)$/);
    if (m) {
      if (/^_/.test(basename(m[1]))) continue; // _app, _document — не маршруты
      const p = m[1].replace(/\/?index$/, '') || '/';
      routes.add(p.startsWith('/') ? p : '/' + p);
    }
  }
  return [...routes].sort();
}

/** Ищет статические данные каталога — их предстоит заменить вызовами API. */
function findStaticData(dir, files) {
  const hits = [];
  for (const f of files) {
    const name = basename(f).toLowerCase();
    const ext = extname(f).toLowerCase();
    if (!['.json', '.js', '.ts', '.mjs'].includes(ext)) continue;
    if (!/(data|products?|catalog|goods|items|mock|fixtures?|seed)/.test(name)) continue;
    const size = (() => {
      try {
        return statSync(f).size;
      } catch {
        return 0;
      }
    })();
    // Мелкие файлы с таким именем обычно не данные каталога, а утилиты.
    if (size < 512) continue;
    hits.push({ file: relative(dir, f), sizeKb: Math.round(size / 1024) });
  }
  return hits.sort((a, b) => b.sizeKb - a.sizeKb).slice(0, 12);
}

/** Следы «своего бэкенда» — их заменит Storefront API. */
function findBackendTraces(dir, files) {
  const traces = new Set();
  for (const f of files) {
    const ext = extname(f).toLowerCase();
    if (!['.js', '.ts', '.tsx', '.jsx', '.mjs', '.vue', '.svelte', '.php'].includes(ext)) continue;
    const text = readSafe(f);
    if (!text) continue;
    if (/localStorage\.(get|set)Item\(\s*['"][^'"]*cart/i.test(text)) traces.add('корзина в localStorage');
    if (/\bfetch\(\s*['"`]https?:\/\//.test(text)) traces.add('запросы к внешнему API');
    if (/mysqli?_connect|new\s+PDO\(|pg_connect/i.test(text)) traces.add('прямое подключение к БД');
    if (/sendmail|nodemailer|mail\(/i.test(text)) traces.add('отправка писем из витрины');
    if (/(yookassa|robokassa|stripe|tinkoff|cloudpayments)/i.test(text)) traces.add('платёжный провайдер в коде витрины');
  }
  return [...traces];
}

function main() {
  if (!existsSync(root)) {
    console.error(`Каталог «${root}» не найден.`);
    console.error('Положите макет витрины рядом (рекомендуемый путь ./storefront)');
    console.error('или укажите путь: node scripts/adopt-storefront.mjs <путь>');
    process.exit(1);
  }

  const files = walk(root);
  const pkg = readJson(join(root, 'package.json'));
  const detected = detectKind(root, files, pkg);

  // Страницы считаем по-разному в зависимости от типа макета: у статики это
  // .html-файлы, у фреймворков — файлы маршрутов. Иначе Next.js-проект
  // «показывал бы» одну страницу — демку шрифта в public/, что вводит в
  // заблуждение ровно там, где нужна карта сайта.
  const pages = isRouterBased(detected.kind)
    ? findRouteFiles(root, files)
    : files
        .filter((f) => PAGE_EXT.has(extname(f).toLowerCase()))
        .map((f) => relative(root, f))
        .sort();

  const hasDockerfile = existsSync(join(root, 'Dockerfile'));
  const dockerfile = hasDockerfile ? readSafe(join(root, 'Dockerfile')) : '';
  const exposes3000 = /(?:EXPOSE\s+3000|PORT[= ]3000|-l\s+3000|:3000)/.test(dockerfile);
  const copiesEverything = /^\s*COPY\s+\.\s+\.\s*$/m.test(dockerfile);

  // Файлы, которые нельзя публиковать (лежат в корне раздаваемого каталога).
  const unpublishable = files
    .map((f) => relative(root, f))
    .filter((rel) => !rel.includes('/') && MUST_NOT_PUBLISH.some((re) => re.test(rel)));

  // Секреты в открытом виде.
  const secrets = [];
  for (const f of files) {
    const ext = extname(f).toLowerCase();
    if (!['.js', '.ts', '.tsx', '.jsx', '.mjs', '.json', '.env', '.php', ''].includes(ext)) continue;
    const text = readSafe(f);
    if (!text) continue;
    if (SECRET_HINTS.some((re) => re.test(text))) secrets.push(relative(root, f));
  }

  const report = {
    root,
    kind: detected.kind,
    kindLabel: detected.label,
    confident: detected.confident,
    filesScanned: files.length,
    pages,
    staticData: findStaticData(root, files),
    backendTraces: findBackendTraces(root, files),
    docker: { hasDockerfile, exposes3000, copiesEverything },
    risks: { unpublishable, secrets: secrets.slice(0, 10) },
  };

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const line = (s = '') => console.log(s);
  line('');
  line('══ Приём макета витрины ═══════════════════════════════════════════');
  line(`Каталог:      ${root}`);
  line(`Тип макета:   ${report.kindLabel}${detected.confident ? '' : ' (уверенность низкая — проверь вручную)'}`);
  line(`Файлов:       ${report.filesScanned}`);
  line('');

  const routerBased = isRouterBased(report.kind);
  line('── Страницы ───────────────────────────────────────────────────────');
  if (pages.length > 0) {
    line(`${routerBased ? 'Маршрутов' : 'HTML-страниц'}: ${pages.length}`);
    line(`  ${pages.slice(0, 20).join(', ')}${pages.length > 20 ? ` … и ещё ${pages.length - 20}` : ''}`);
    line('  → Каждая страница — либо CMS-страница, либо раздел каталога, либо');
    line('    шаг оформления. Разнеси их по этим трём типам в профиле магазина.');
  } else {
    line(`  ${routerBased ? 'Маршруты не распознаны' : 'HTML-страниц не найдено'} — определи структуру сайта вручную.`);
  }
  line('');

  line('── Данные каталога в макете (их заменит Storefront API) ───────────');
  if (report.staticData.length > 0) {
    for (const d of report.staticData) line(`  • ${d.file} (${d.sizeKb} КБ)`);
    line('  → Это исходник ассортимента: из него собирается сид каталога (Этап 4).');
  } else {
    line('  Явных файлов с данными не найдено — уточни у владельца, откуда берётся');
    line('  ассортимент (выгрузка из учётной системы? прайс поставщика? вручную?).');
  }
  line('');

  line('── Следы собственного бэкенда (заменяются на Storefront API) ──────');
  if (report.backendTraces.length > 0) {
    for (const t of report.backendTraces) line(`  • ${t}`);
  } else {
    line('  Не обнаружено — макет, похоже, чисто презентационный.');
  }
  line('');

  line('── Совместимость с docker-compose платформы ───────────────────────');
  if (!hasDockerfile) {
    line('  ✕ Dockerfile отсутствует. Контракт сервиса storefront: собраться из');
    line('    ./storefront и слушать порт 3000. Для статики есть готовый образец —');
    line('    docs/20 §5.4 (node:20-alpine + serve).');
  } else {
    line(`  ${exposes3000 ? '✓' : '✕'} порт 3000 ${exposes3000 ? 'найден' : 'НЕ найден — compose ждёт именно его'}`);
    if (copiesEverything) {
      line('  ! Dockerfile содержит «COPY . .» — в публичную раздачу попадёт ВСЁ,');
      line('    включая внутренние заметки. На боевом магазине так утекло ТЗ заказчика.');
    }
  }
  line('');

  if (unpublishable.length > 0 || secrets.length > 0) {
    line('── Риски ──────────────────────────────────────────────────────────');
    if (unpublishable.length > 0) {
      line(`  ! Не должно попасть в публичную раздачу: ${unpublishable.join(', ')}`);
    }
    if (secrets.length > 0) {
      line(`  ! Похоже на секреты в открытом виде: ${secrets.join(', ')}`);
      line('    Секреты переносятся в .env, а не в код витрины.');
    }
    line('');
  }

  line('── Что дальше ─────────────────────────────────────────────────────');
  line('  1. docs/20 Этап 1 — дособрать «профиль магазина» по этому отчёту.');
  line('  2. docs/32 §4 — отдать владельцу список данных и ключей В ПЕРВЫЙ ДЕНЬ.');
  line('  3. docs/21 — контракт Storefront API для сращивания (Этап 5).');
  line('');
}

main();
