/**
 * Чистая логика `robots.txt` и `sitemap.xml` витрины.
 *
 * 🔴 ДЕФЕКТ A-2. В `storefront/app/` не было ни `robots.ts`, ни `sitemap.ts`, и оба
 * пути перехватывал catch-all сегмент `[lang]`: `/robots.txt` выглядел для роутера
 * как локаль `robots.txt`, поэтому middleware переписывал его в `/ru/robots.txt`, а
 * витрина отдавала 200 + 112 КБ HTML главной с `content-type: text/html`. Робот
 * получал «robots.txt», который не парсится, и карту сайта не находил вовсе.
 *
 * ПОЧЕМУ ЛОГИКА ЗДЕСЬ, А НЕ В `app/robots.ts` / `app/sitemap.ts`. Файлы-соглашения
 * Next исполняются только рантаймом сборки и ходят в сеть за данными магазина —
 * юнит-тестировать их нельзя без поднятого Admik. Поэтому там остаются тонкие
 * обёртки (получить данные → вызвать функцию отсюда), а всё, что можно проверить
 * без сети, живёт чистыми функциями в этом модуле.
 *
 * МУЛЬТИТЕНАНТНОСТЬ. Домен НИГДЕ не хардкодится: он приезжает из настроек самого
 * магазина (`seo.siteUrl`, админка → Настройки → SEO) — тот же источник, что у
 * hreflang в `lib/i18n.ts` и у return-url платежей. Платформа обслуживает разные
 * магазины на разных доменах, поэтому «зашить erfgv.website» здесь было бы дефектом.
 *
 * МУЛЬТИЯЗЫЧНОСТЬ. URL и hreflang строятся ТЕМИ ЖЕ `localizedHref`/`alternatesFor`,
 * что и разметка страниц (ru — корень без префикса, en/fr — с префиксом). Своей
 * копии правил здесь нет намеренно: вторая реализация схемы URL неизбежно
 * разъедется с первой, и карта начнёт публиковать адреса, которых на сайте нет.
 */

import type { MetadataRoute } from 'next';
import {
  LOCALES,
  alternatesFor,
  localizedHref,
  type Locale,
} from './i18n';
import { categoryHref } from './tree';
import type { CategoryDto, PageListItemDto, PublicSettingsDto } from './types';

/**
 * Служебные пути, закрытые от индексации. Это разделы без полезного для поиска
 * контента и с приватным состоянием покупателя: корзина и оформление (`/cart`,
 * `/order`), личное избранное (`/favorite`), бесконечное пространство поисковых
 * запросов (`/search` — классический источник краулерных ловушек и дублей) и
 * технические ручки (`/api`).
 *
 * Единый источник и для robots, и для фильтра карты: путь, закрытый в robots, не
 * должен одновременно предлагаться в sitemap — это прямое противоречие для робота.
 */
export const PRIVATE_PATHS = ['/cart', '/order', '/favorite', '/search', '/api'] as const;

/**
 * Потолок числа товаров в карте.
 *
 * Каталог магазина сейчас ~846 активных позиций, но платформа мультитенантная и
 * следующий магазин может привезти десятки тысяч. Ограничения, из которых взято
 * число: протокол sitemap разрешает 50 000 URL и 50 МБ на файл, а КАЖДЫЙ товар
 * даёт по записи на локаль (3 локали → 3 URL) плюс hreflang-связку из 3 ссылок
 * внутри каждой. 15 000 товаров × 3 локали = 45 000 URL — под лимитом с запасом на
 * категории, дизайнеров и CMS.
 *
 * ПОЧЕМУ ПОТОЛОК, А НЕ `generateSitemaps` (шардирование на sitemap/0.xml, /1.xml).
 * Шардирование заставило бы КАЖДЫЙ шард отдельно ходить в Storefront API за своим
 * окном товаров, то есть умножило бы сетевые запросы к админке и усложнило
 * деградацию при её недоступности, ради ёмкости, которой ни один магазин платформы
 * пока не достигает (846 из 15 000). Когда реальный магазин подойдёт к потолку,
 * правильный шаг — включить здесь `generateSitemaps` и раздать окна по шардам;
 * пока же лишняя сложность не окупается. Потолок не молчит: он лишь обрезает
 * хвост, а не ломает карту.
 */
export const SITEMAP_PRODUCT_CAP = 15000;

/**
 * База абсолютных URL для robots/sitemap: публичный адрес магазина из его же
 * настроек, иначе — значение из окружения (`NEXT_PUBLIC_SITE_URL`, задаётся при
 * развёртывании инстанса), иначе null.
 *
 * Фолбэк на env обязателен: `sitemap.ts` и `robots.ts` могут исполниться в момент,
 * когда Storefront API недоступен (сборка, перезапуск админки), и без него магазин
 * молча остался бы вообще без карты сайта.
 *
 * Валидация та же, что у `absoluteUrlBase` в lib/i18n.ts: не строка / не http(s) /
 * пусто → значения нет. Схема проверяется потому, что значение уезжает в директиву
 * `Sitemap:` и в `<loc>`, то есть в потенциально исполняемый контекст у потребителя.
 * Хвостовые слэши срезаются, иначе склейка даст `https://shop//catalog`.
 */
export function sitemapBaseUrl(
  settings: PublicSettingsDto | null | undefined,
  envUrl: string | undefined = process.env.NEXT_PUBLIC_SITE_URL,
): string | null {
  return normalizeBase(settings?.seo?.siteUrl) ?? normalizeBase(envUrl);
}

function normalizeBase(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!/^https?:\/\/[^/]/i.test(trimmed)) return null;
  const base = trimmed.replace(/\/+$/, '');
  return base === '' ? null : base;
}

/**
 * Директивы `robots.txt`. Индексация открыта, служебные пути закрыты — включая их
 * локалевые варианты: `Disallow: /cart` НЕ закрывает `/en/cart`, потому что правило
 * robots — это префикс пути, а не «путь в любой локали». Без явного перечисления
 * корзина и оформление заказа остались бы открытыми на двух языках из трёх.
 *
 * `sitemap` указывается только при известной базе: относительный адрес в этой
 * директиве невалиден по протоколу, и пустой/битый URL хуже отсутствующего.
 */
export function buildRobots(base: string | null): MetadataRoute.Robots {
  const disallow: string[] = [];
  for (const path of PRIVATE_PATHS) {
    disallow.push(path);
    // Тот же путь под префиксом каждой не-дефолтной локали (ru живёт на корне,
    // его вариант уже добавлен строкой выше).
    for (const locale of LOCALES) {
      const localized = localizedHref(path, locale);
      if (localized !== path) disallow.push(localized);
    }
  }

  return {
    rules: [{ userAgent: '*', allow: '/', disallow }],
    ...(base ? { sitemap: `${base}/sitemap.xml` } : {}),
  };
}

/** Сущность карты, у которой нам нужен только slug (товар, дизайнер). */
export interface SitemapSlug {
  slug: string;
}

export interface SitemapInput {
  /** База абсолютных URL (sitemapBaseUrl). null → карта пустая. */
  base: string | null;
  /** Включённые владельцем локали (пересечение с whitelist уже сделано вызывающим). */
  locales: readonly Locale[];
  /** Дерево категорий Storefront API (с техническим корнем `catalog`). */
  categories: CategoryDto[];
  /** Активные товары. Архивные сюда попадать не должны — они отдают 404. */
  products: readonly SitemapSlug[];
  /** Активные дизайнеры. */
  designers: readonly SitemapSlug[];
  /** Опубликованные CMS-страницы (noindex отфильтруются здесь). */
  pages: readonly PageListItemDto[];
}

/**
 * Сборка карты сайта: по записи на каждую пару (страница × включённая локаль), у
 * каждой — hreflang-связка со всеми локалями через `alternatesFor`.
 *
 * Карта строится из «голых» путей без локали (`/catalog`, `/product/x`) — префиксы
 * навешивает `localizedHref`, ровно как на страницах.
 */
export function buildSitemap(input: SitemapInput): MetadataRoute.Sitemap {
  const { base, locales } = input;
  // Без абсолютной базы карта бессмысленна: `<loc>` обязан быть абсолютным URL.
  // Пустая карта честнее набора относительных путей, который робот отвергнет.
  if (!base || locales.length === 0) return [];

  const paths: SitemapPath[] = [];
  const seen = new Set<string>();

  /** Добавить путь один раз (дубли в карте — сигнал робота о плохом качестве). */
  const add = (path: string, priority: number, changeFrequency: ChangeFreq): void => {
    if (!isPublicPath(path) || seen.has(path)) return;
    seen.add(path);
    paths.push({ path, priority, changeFrequency });
  };

  // Главная и индекс каталога — всегда, даже если API не отдал данных: это живые
  // страницы витрины, и без них карта была бы пустой при сбое админки.
  add('/', 1, 'daily');
  add('/catalog', 0.9, 'daily');

  // Категории — КАНОНИЧЕСКИМ вложенным путём из цепочки предков (categoryHref).
  // Плоский `/catalog/{slug}` для потомка отдал бы редирект на канонический путь,
  // то есть карта publish-ила бы адреса, которых у категории нет.
  for (const slug of collectCategorySlugs(input.categories)) {
    add(categoryHref(input.categories, slug), 0.8, 'weekly');
  }

  // Товары — под потолком (см. SITEMAP_PRODUCT_CAP).
  let productCount = 0;
  for (const product of input.products) {
    if (productCount >= SITEMAP_PRODUCT_CAP) break;
    const slug = cleanSlug(product?.slug);
    if (!slug) continue;
    const before = seen.size;
    add(`/product/${slug}`, 0.7, 'weekly');
    if (seen.size > before) productCount += 1;
  }

  for (const designer of input.designers) {
    const slug = cleanSlug(designer?.slug);
    if (slug) add(`/designers/${slug}`, 0.6, 'monthly');
  }

  // CMS-страницы: noindex-страницы владелец скрыл от поиска намеренно — предлагать
  // их роботу нельзя, это противоречило бы мета-тегу самой страницы.
  for (const page of input.pages) {
    const slug = cleanSlug(page?.slug);
    if (slug && page?.meta?.noindex !== true) add(`/${slug}`, 0.5, 'monthly');
  }

  const lastModified = new Date();
  return paths.flatMap(({ path, priority, changeFrequency }) =>
    locales.map((locale) => {
      const { canonical, languages } = alternatesFor(path, locale, locales, base);
      return {
        url: canonical,
        lastModified,
        changeFrequency,
        priority,
        alternates: { languages },
      };
    }),
  );
}

type ChangeFreq = NonNullable<MetadataRoute.Sitemap[number]['changeFrequency']>;

interface SitemapPath {
  path: string;
  priority: number;
  changeFrequency: ChangeFreq;
}

/**
 * Slug пригоден для URL. Пустые/пробельные/не-строки приходят из БД при неполных
 * данных; без проверки они дали бы в карте `/product/` — 404 для робота.
 */
function cleanSlug(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Путь публичен, если не начинается ни с одного служебного префикса. Симметрично
 * `PRIVATE_PATHS` в robots: карта не должна предлагать то, что robots запрещает.
 */
function isPublicPath(path: string): boolean {
  return !PRIVATE_PATHS.some((p) => path === p || path.startsWith(`${p}/`));
}

/**
 * Все slug дерева категорий, кроме технического корня `catalog`: он сам разделом не
 * является, его URL — это индекс каталога, уже добавленный отдельно.
 */
function collectCategorySlugs(tree: CategoryDto[]): string[] {
  const out: string[] = [];
  const walk = (nodes: CategoryDto[]): void => {
    for (const node of nodes) {
      const slug = cleanSlug(node?.slug);
      if (slug && slug !== 'catalog') out.push(slug);
      if (Array.isArray(node?.children)) walk(node.children);
    }
  };
  walk(tree);
  return out;
}
