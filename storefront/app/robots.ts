/**
 * `GET /robots.txt` — соглашение Next App Router (MetadataRoute.Robots).
 *
 * 🔴 ДЕФЕКТ A-2. Пока этого файла не было, путь `/robots.txt` перехватывал catch-all
 * сегмент `[lang]` (роутер видел в нём локаль), и витрина отдавала 200 + HTML
 * главной с `content-type: text/html`. Робот получал «robots.txt», который не
 * парсится: директивы игнорировались, карта сайта не публиковалась. Сам факт
 * существования файла в `app/` уже перебивает `[lang]`, потому что статический
 * сегмент приоритетнее динамического.
 *
 * Логика вынесена в lib/sitemap.ts — здесь только получение настроек магазина,
 * чтобы модуль оставался юнит-тестируемым без сети (см. tests/seo/storefront-sitemap).
 */

import type { MetadataRoute } from 'next';
import { getSettings } from '@/lib/api';
import { buildRobots, sitemapBaseUrl } from '@/lib/sitemap';

// Настройки магазина (домен) живут в БД админки и меняются владельцем без
// пересборки витрины, поэтому ответ считается на запросе, а не впекается в сборку.
export const dynamic = 'force-dynamic';

export default async function robots(): Promise<MetadataRoute.Robots> {
  // Сбой Storefront API → getSettings вернёт null, база уедет на env-фолбэк, и
  // robots.txt всё равно отдастся валидным (пусть и без директивы Sitemap).
  const settings = await getSettings();
  return buildRobots(sitemapBaseUrl(settings));
}
