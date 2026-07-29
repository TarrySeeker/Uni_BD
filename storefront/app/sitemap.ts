/**
 * `GET /sitemap.xml` — соглашение Next App Router (MetadataRoute.Sitemap).
 *
 * 🔴 ДЕФЕКТ A-2. Как и robots.txt, путь `/sitemap.xml` перехватывался catch-all
 * сегментом `[lang]` и отдавал HTML главной вместо XML — карты сайта у магазина не
 * было вовсе. Статический файл в `app/` приоритетнее динамического сегмента, чем
 * маршрут и возвращается.
 *
 * Логика сборки — в lib/sitemap.ts (чистая, покрыта юнитами); здесь только сбор
 * данных из Storefront API. Все четыре запроса параллельны: карта строится на
 * запросе, и последовательные обращения к админке растянули бы ответ.
 */

import type { MetadataRoute } from 'next';
import {
  getSettings,
  getCategories,
  getPages,
  getDesigners,
  getAllProductSlugs,
} from '@/lib/api';
import { buildSitemap, sitemapBaseUrl, SITEMAP_PRODUCT_CAP } from '@/lib/sitemap';
import { enabledLocalesFrom } from '@/lib/i18n';

// Каталог и состав страниц меняются в админке без пересборки витрины, поэтому
// карта считается по запросу. Впечь её в сборку нельзя ещё и технически: при
// `next build` в docker админка (app:3000) не поднята — карта вышла бы пустой.
export const dynamic = 'force-dynamic';

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const [settings, categories, pages, designers, products] = await Promise.all([
    getSettings(),
    getCategories(),
    getPages(),
    getDesigners(),
    getAllProductSlugs(SITEMAP_PRODUCT_CAP),
  ]);

  return buildSitemap({
    base: sitemapBaseUrl(settings),
    // Только языки, включённые владельцем в админке: выключенный язык не должен
    // предлагаться роботу — его страницы витрина не отдаёт.
    locales: enabledLocalesFrom(settings?.i18n?.locales),
    categories,
    products,
    designers,
    pages,
  });
}
