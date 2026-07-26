// СЕРВЕРНЫЙ МОДУЛЬ ('server-only' семантика): ходит в БД напрямую, импортируется
// только серверным компонентом страницы «Языки». Пакет `server-only` в проекте не
// используется как зависимость — маркер задан семантикой (как в lib/auth/cookies).

import { sql } from '@/lib/db/client';
import { computeCoverage } from '@/lib/i18n/coverage';
import {
  PRODUCT_TR_FIELDS,
  CATEGORY_TR_FIELDS,
  BRAND_TR_FIELDS,
  DESIGNER_TR_FIELDS,
  CMS_PAGE_TR_FIELDS,
} from '@/lib/i18n/fields';
import type { Locale, TranslationsMap } from '@/lib/i18n/types';

import type { CoverageEntry } from '../_components/languages-coverage';

/**
 * Источники данных для матрицы покрытия переводов (экран «Языки», T3).
 *
 * Читаем ТОЛЬКО колонку translations — оверлей переводов; базовый язык живёт в
 * обычных колонках и по определению заполнен на 100 %. Набор полей по сущности
 * берётся из единого whitelist lib/i18n/fields.ts, чтобы проценты считались по
 * тому же множеству полей, которое реально принимает write-path.
 *
 * Таблица может отсутствовать (модуль не накатан на этом инстансе) — тогда
 * сущность просто выпадает из матрицы, экран настроек не должен падать из-за
 * диагностической панели.
 */
interface TranslationRow {
  translations?: TranslationsMap | null;
}

interface CoverageSource {
  entity: string;
  /** Ключ подписи сущности в messages/* — страница резолвит его через t(...). */
  labelKey: string;
  fields: readonly string[];
  load: () => Promise<TranslationRow[]>;
}

const SOURCES: readonly CoverageSource[] = [
  {
    entity: 'products',
    labelKey: 'settings.languagesPage.entities.products',
    fields: PRODUCT_TR_FIELDS,
    // Архивные товары не показываются покупателю — их перевод не нужен и не
    // должен портить статистику.
    load: () =>
      sql<TranslationRow[]>`SELECT translations FROM products WHERE status <> 'archived'`,
  },
  {
    entity: 'categories',
    labelKey: 'settings.languagesPage.entities.categories',
    fields: CATEGORY_TR_FIELDS,
    load: () => sql<TranslationRow[]>`SELECT translations FROM categories`,
  },
  {
    entity: 'brands',
    labelKey: 'settings.languagesPage.entities.brands',
    fields: BRAND_TR_FIELDS,
    load: () => sql<TranslationRow[]>`SELECT translations FROM brands`,
  },
  {
    entity: 'designers',
    labelKey: 'settings.languagesPage.entities.designers',
    fields: DESIGNER_TR_FIELDS,
    load: () => sql<TranslationRow[]>`SELECT translations FROM designers`,
  },
  {
    entity: 'cms_pages',
    labelKey: 'settings.languagesPage.entities.cmsPages',
    fields: CMS_PAGE_TR_FIELDS,
    load: () => sql<TranslationRow[]>`SELECT translations FROM cms_pages`,
  },
];

/**
 * Считает покрытие переводов по всем доступным сущностям для указанных языков
 * (передавать НЕ-дефолтные языки: базовый хранится в колонках, а не в оверлее).
 * Сущности с недоступной таблицей молча пропускаются.
 */
export async function loadTranslationCoverage(
  locales: readonly Locale[],
): Promise<CoverageEntry[]> {
  if (locales.length === 0) {
    return [];
  }

  const entries: CoverageEntry[] = [];
  for (const source of SOURCES) {
    let rows: TranslationRow[];
    try {
      rows = await source.load();
    } catch {
      continue;
    }
    entries.push({
      entity: source.entity,
      labelKey: source.labelKey,
      coverage: computeCoverage(rows, locales, source.fields),
    });
  }
  return entries;
}
