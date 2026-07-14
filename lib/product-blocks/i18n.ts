/**
 * i18n секций товара (product_blocks, §9) — write-path сборка оверлея и read-path
 * резолв структурных табов. Чистые функции (без БД/Next), тестируются напрямую.
 *
 * Плоские поля (title/blockquot/body) резолвятся стандартным localizeField
 * (lib/i18n) в DTO; табы — СТРУКТУРНО через localizeStructured (deep-merge по
 * индексу: непереведённый таб берётся из базы).
 */

import { localizeStructured } from '@/lib/i18n';
import type { Locale, TranslationsMap } from '@/lib/i18n';

import { blockTranslationsSchema } from './schemas';
import type { ProductBlockTab } from './types';

/** Есть ли в оверлее одного языка хоть какое-то непустое содержимое. */
function overlayHasContent(overlay: Record<string, unknown>): boolean {
  for (const [k, v] of Object.entries(overlay)) {
    if (k === 'tabs') {
      if (Array.isArray(v) && v.some((t) => {
        const o = t as { name?: string; text?: string };
        return (o.name && o.name.trim()) || (o.text && o.text.trim());
      })) {
        return true;
      }
      continue;
    }
    if (typeof v === 'string' && v.trim().length > 0) {
      return true;
    }
  }
  return false;
}

/**
 * Write-path: из сырого блока формы `{ [locale]: {...} }` строит итоговый оверлей
 * translations секции. Валидирует whitelist/языки через blockTranslationsSchema
 * (только НЕ-дефолтные overlayLocales), отбрасывает языки без содержимого. Полная
 * замена колонки: редактор шлёт цельный оверлей секции (в отличие от пополевого
 * LocaleTabs других сущностей).
 */
export function buildBlockTranslations(
  input: unknown,
  overlayLocales: readonly string[],
): TranslationsMap {
  if (input == null || typeof input !== 'object') {
    return {};
  }
  const parsed = blockTranslationsSchema(overlayLocales).safeParse(input);
  if (!parsed.success) {
    return {};
  }
  const out: TranslationsMap = {};
  for (const [locale, overlay] of Object.entries(parsed.data)) {
    if (!overlay) continue;
    if (!overlayHasContent(overlay as Record<string, unknown>)) continue;
    out[locale] = overlay as Record<string, unknown>;
  }
  return out;
}

/**
 * Read-path: локализует табы секции. Для defaultLocale (или без оверлея) — база.
 * Иначе deep-merge базового массива с translations[locale].tabs (localizeStructured):
 * непереведённые табы/поля сохраняются из базы.
 */
export function localizeBlockTabs(
  baseTabs: ProductBlockTab[],
  translations: TranslationsMap | null | undefined,
  locale: Locale,
  defaultLocale: Locale,
): ProductBlockTab[] {
  const overlayTabs = translations?.[locale]?.tabs;
  if (locale === defaultLocale || overlayTabs === undefined) {
    return baseTabs;
  }
  // Оборачиваем в locale-мапу, чтобы переиспользовать localizeStructured (deep-merge).
  // Значение оверлея — массив табов (не плоский объект), поэтому приводим к TranslationsMap.
  const trMap = { [locale]: overlayTabs } as unknown as TranslationsMap;
  const merged = localizeStructured(baseTabs, trMap, locale, defaultLocale);
  return Array.isArray(merged)
    ? (merged as unknown[]).map((t) => {
        const o = t as { name?: unknown; text?: unknown };
        return {
          name: typeof o.name === 'string' ? o.name : '',
          text: typeof o.text === 'string' ? o.text : '',
        };
      })
    : baseTabs;
}
