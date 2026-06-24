/**
 * GET /sitemap.xml (docs/11 §5.3.4, пакет 5.S-1).
 *
 * core-always-on route handler. Наполнение фильтруется по ЭФФЕКТИВНЫМ модулям
 * (env ⊕ module_overrides) и noindex/черновикам через чистый билдер
 * buildSitemapEntries. Домен берётся из shop_settings.seo.site_url (env только
 * bootstrap-fallback) — никаких process.env-доменов в проде.
 *
 * revalidate=3600 (ISR). Fallback при недоступности БД — только корень (паттерн
 * 2x2): карта не должна падать, если БД временно недоступна.
 */

import type { MetadataRoute } from 'next';

import { getEffectiveSettings, getEffectiveModules } from '@/lib/config/settings';
import { buildSitemapEntries } from '@/lib/seo/sitemap';
import { getSitemapRows } from '@/lib/seo/repository';

/** Перегенерация раз в час (ISR). */
export const revalidate = 3600;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  try {
    const settings = await getEffectiveSettings();
    const siteUrl = settings.seo.site_url ?? null;

    // noindex_site (staging-флаг) закрывает сайт целиком — зеркалим robots:
    // карта не должна раскрывать полный список URL заблокированного сайта.
    // Отдаём только корень (или пусто, если домен не задан).
    if (settings.seo.noindex_site) {
      return siteUrl ? [{ url: siteUrl.replace(/\/+$/, '') }] : [];
    }

    // Эффективные модули: env-набор ⊕ module_overrides из ТОГО ЖЕ мемо-снимка, что и
    // seo (строка 26) — C9-1: прежде здесь шёл ОТДЕЛЬНЫЙ свежий getSetting('module_overrides'),
    // что давало два независимых чтения module_overrides в одном запросе (рассинхрон при
    // инвалидации кэша между ними). Используем settings.modules.overrides (паттерн d1bc04b).
    const modules = getEffectiveModules(process.env, settings.modules.overrides);

    const rows = await getSitemapRows();
    const entries = buildSitemapEntries(modules, rows, { siteUrl });

    return entries.map((e) => ({
      url: e.url,
      ...(e.lastModified ? { lastModified: e.lastModified } : {}),
    }));
  } catch (error) {
    // БД недоступна → отдаём только корень, чтобы карта не падала (паттерн 2x2).
    console.error('[sitemap] не удалось собрать карту, fallback на корень:', error);
    try {
      const settings = await getEffectiveSettings();
      const siteUrl = settings.seo.site_url;
      if (siteUrl) return [{ url: siteUrl.replace(/\/+$/, '') }];
    } catch {
      /* нет настроек — пустая карта */
    }
    return [];
  }
}
