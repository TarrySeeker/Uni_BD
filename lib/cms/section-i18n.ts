/**
 * Перевод ТЕЛА CMS-страницы: контент секций (cms_page_sections.translations, T5).
 *
 * Read-path уже существовал: lib/storefront/cms-dto прогоняет content секции через
 * localizeStructured — deep-merge оверлея translations[locale] поверх базового
 * content. Здесь — СИММЕТРИЧНЫЙ write-path: форма отдаёт плоские строки (как и для
 * базового языка), а модуль собирает из них ровно тот СТРУКТУРНЫЙ патч, который
 * умеет читать витрина.
 *
 * ПОЧЕМУ форма шлёт строки, а патч собирается на сервере: клиенту нельзя доверять
 * форму JSONB, иначе он мог бы записать в оверлей произвольную структуру (включая
 * непереводимые ключи — imageKey/ctaHref/mode), которую deep-merge подставил бы
 * на витрине поверх базы. Патч строит сервер по whitelist CMS_SECTION_TR_FIELDS
 * и санитизирует rich-text (анти-XSS, как sanitizeSectionContent для базы).
 *
 * Модуль чистый (без БД/Next/React) — переиспользуется формой секции и Server
 * Action'ом, тестируется юнитами.
 */

import { CMS_SECTION_TR_FIELDS } from '@/lib/i18n/fields';
import { translationsInputSchema } from '@/lib/i18n/schemas';
import type { LocaleConfig, TranslationsMap } from '@/lib/i18n/types';

import { CmsError } from './errors';
import { sanitizeHtml } from './sanitize';
import type { SectionFieldSpec } from './section-form';
import { CMS_SECTION_TYPES, type CmsSectionType } from './types';

// -----------------------------------------------------------------------------
// Лимиты.
// -----------------------------------------------------------------------------

/**
 * Максимальная длина одного переводимого поля — та же, что у базового rich-text
 * (richTextSchema в schemas.ts): перевод не должен быть «короче оригинала».
 */
export const SECTION_TR_FIELD_MAX_LENGTH = 50000;

/**
 * Потолок размера патча ОДНОГО языка. Зеркалит CHECK базы
 * (cms_page_sections_content_size_chk: pg_column_size(content) < 65536): на колонку
 * translations такого CHECK нет, поэтому ограничение держим в коде — иначе оверлей
 * тихо раздувал бы строку сверх того, что допущено для самого контента.
 */
export const SECTION_TRANSLATION_MAX_BYTES = 65536;

// -----------------------------------------------------------------------------
// Поля перевода по типу секции (UI + write-path).
// -----------------------------------------------------------------------------

/** Поля с rich-text (HTML) — санитизируются на записи. */
const RICH_FIELDS = new Set(['html']);

/** Поля со структурным (построчным) вводом: faq.items и gallery.images. */
const PAIRS_FIELDS = new Set(['items', 'images']);

/**
 * Описание полей перевода для формы секции. Состав ОБЯЗАН совпадать с
 * CMS_SECTION_TR_FIELDS (whitelist write-path) — сторожит тест: форма не может
 * показать поле, которое сервер не примет, и наоборот.
 *
 * Подписи/подсказки — i18n-КЛЮЧИ (`cms.sectionFields.*`), как в SECTION_FIELD_SPECS:
 * оба набора рисует один и тот же FieldControl, значит схема у них обязана быть одна.
 */
export const SECTION_TR_FIELD_SPECS: Record<CmsSectionType, readonly SectionFieldSpec[]> = {
  hero: [
    { name: 'title', labelKey: 'cms.sectionFields.title.label', kind: 'text' },
    { name: 'subtitle', labelKey: 'cms.sectionFields.subtitle.label', kind: 'text' },
    { name: 'html', labelKey: 'cms.sectionFields.html.label', kind: 'richtext' },
    { name: 'ctaLabel', labelKey: 'cms.sectionFields.buttonLabel.label', kind: 'text' },
  ],
  text: [{ name: 'html', labelKey: 'cms.sectionFields.html.label', kind: 'richtext' }],
  banner: [{ name: 'alt', labelKey: 'cms.sectionFields.alt.label', kind: 'text' }],
  products_grid: [
    { name: 'title', labelKey: 'cms.sectionFields.blockTitle.label', kind: 'text' },
  ],
  faq: [
    {
      name: 'items',
      labelKey: 'cms.sectionFields.faqItems.label',
      kind: 'pairs',
      hintKey: 'cms.sectionFields.faqItems.translationHint',
    },
  ],
  cta: [
    { name: 'title', labelKey: 'cms.sectionFields.title.label', kind: 'text' },
    { name: 'html', labelKey: 'cms.sectionFields.html.label', kind: 'richtext' },
    { name: 'buttonLabel', labelKey: 'cms.sectionFields.buttonLabel.label', kind: 'text' },
  ],
  gallery: [
    {
      name: 'images',
      labelKey: 'cms.sectionFields.galleryAlts.label',
      kind: 'pairs',
      hintKey: 'cms.sectionFields.galleryAlts.hint',
    },
  ],
};

/** Whitelist переводимых полей секции данного типа (пусто для неизвестного типа). */
export function sectionTrFieldNames(type: string): readonly string[] {
  return CMS_SECTION_TR_FIELDS[type] ?? [];
}

// -----------------------------------------------------------------------------
// Плоское состояние формы ⇄ структурный патч content.
// -----------------------------------------------------------------------------

/**
 * Разбивает multiline на строки БЕЗ выбрасывания пустых: позиция строки = индекс
 * элемента базового массива (deep-merge мержит массивы по индексу). Хвостовые
 * пустые строки отбрасываются — они ничего не переводят.
 */
function splitLines(raw: string): string[] {
  const lines = raw.split('\n').map((l) => l.trim());
  while (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}

/** Разбивает строку «слева|справа» (правая часть может содержать '|'). */
function splitPair(line: string): { left: string; right: string } {
  const idx = line.indexOf('|');
  if (idx === -1) return { left: line.trim(), right: '' };
  return { left: line.slice(0, idx).trim(), right: line.slice(idx + 1).trim() };
}

/** Непустое значение поля перевода (rich-text — после санитизации). */
function cleanValue(name: string, raw: string): string | undefined {
  const value = RICH_FIELDS.has(name) ? sanitizeHtml(raw) : raw.trim();
  return value.trim().length > 0 ? value : undefined;
}

/**
 * Плоское состояние формы одного языка → СТРУКТУРНЫЙ патч content секции.
 *
 * Пустые поля в патч не попадают: deep-merge на витрине оставит базовое значение
 * (гарантия «никогда не пусто, где база есть»). Элемент массива без переводов —
 * пустой объект `{}`: он держит позицию, чтобы следующий перевод не съехал.
 */
export function buildSectionTranslationPatch(
  type: string,
  state: Record<string, string>,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};

  for (const name of sectionTrFieldNames(type)) {
    const raw = state[name];
    if (typeof raw !== 'string') continue;

    if (name === 'items') {
      const items = splitLines(raw).map((line) => {
        const { left, right } = splitPair(line);
        const item: Record<string, string> = {};
        const q = cleanValue('q', left);
        const a = cleanValue('html', right); // ответ FAQ — rich-text
        if (q !== undefined) item.q = q;
        if (a !== undefined) item.a = a;
        return item;
      });
      if (items.some((i) => Object.keys(i).length > 0)) patch.items = items;
      continue;
    }

    if (name === 'images') {
      const images = splitLines(raw).map((line) => {
        const alt = cleanValue('alt', line);
        return alt === undefined ? {} : { alt };
      });
      if (images.some((i) => Object.keys(i).length > 0)) patch.images = images;
      continue;
    }

    const value = cleanValue(name, raw);
    if (value !== undefined) patch[name] = value;
  }

  return patch;
}

/** Сериализует структурный патч обратно в плоское состояние формы (round-trip). */
function serializeField(name: string, raw: unknown): string | undefined {
  if (PAIRS_FIELDS.has(name)) {
    if (!Array.isArray(raw)) return undefined;
    return raw
      .map((el) => {
        const item = (el ?? {}) as { q?: unknown; a?: unknown; alt?: unknown };
        if (name === 'items') {
          return `${typeof item.q === 'string' ? item.q : ''}|${
            typeof item.a === 'string' ? item.a : ''
          }`;
        }
        return typeof item.alt === 'string' ? item.alt : '';
      })
      .join('\n');
  }
  return typeof raw === 'string' ? raw : undefined;
}

/**
 * Сырой оверлей секции → состояние формы перевода (locale → поле → строка).
 * Ключи вне whitelist игнорируются: форма не показывает того, что не примет сервер.
 */
export function sectionTranslationsFormState(
  type: string,
  translations: TranslationsMap | null | undefined,
): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  if (!translations) return out;

  for (const [locale, patch] of Object.entries(translations)) {
    if (!patch || typeof patch !== 'object') continue;
    const fields: Record<string, string> = {};
    for (const name of sectionTrFieldNames(type)) {
      const serialized = serializeField(name, (patch as Record<string, unknown>)[name]);
      if (serialized !== undefined) fields[name] = serialized;
    }
    out[locale] = fields;
  }
  return out;
}

// -----------------------------------------------------------------------------
// Write-path (Server Action).
// -----------------------------------------------------------------------------

/** Результат резолва переводов секции — как у resolveTranslationsUpdate (lib/i18n). */
export interface SectionTranslationsUpdate {
  /** Был ли во входе хотя бы один валидный (whitelist × включённый язык) блок. */
  provided: boolean;
  /** Итоговое значение колонки translations. */
  value: TranslationsMap;
}

/**
 * Оверлей, от которого отталкиваемся при upsert. Если у секции СМЕНИЛСЯ тип,
 * старый патч описывает поля другого контракта (напр. `alt` баннера в галерее) и
 * deep-merge подмешал бы на витрине мусор — начинаем с чистого листа.
 */
export function existingSectionTranslations(
  previousType: string | undefined | null,
  nextType: string,
  existing: TranslationsMap | null | undefined,
): TranslationsMap {
  if (!previousType || previousType !== nextType) return {};
  return existing ? { ...existing } : {};
}

/**
 * Вход формы `{ [locale]: { [field]: string } }` → значение колонки translations.
 *
 * - отсекает не-whitelist поля и языки вне набора магазина (translationsInputSchema);
 * - defaultLocale в оверлей не пишется (база живёт в обычных колонках/JSONB content);
 * - патч ЗАМЕНЯЕТ оверлей своего языка целиком (иначе очистить перевод было бы
 *   невозможно), соседние языки не трогает;
 * - пустой патч удаляет язык из оверлея — витрина откатится на базовый.
 *
 * Бросает CmsError('validation') на нестроковом/слишком длинном вводе: молчаливое
 * проглатывание означало бы «сохранил», хотя перевод не сохранён.
 */
export function resolveSectionTranslationsUpdate(
  type: string,
  input: unknown,
  existing: TranslationsMap | null | undefined,
  config: LocaleConfig,
): SectionTranslationsUpdate {
  const value: TranslationsMap = existing ? { ...existing } : {};
  if (input == null || typeof input !== 'object') {
    return { provided: false, value };
  }

  const overlayLocales = config.locales.filter((l) => l !== config.defaultLocale);
  const parsed = translationsInputSchema(sectionTrFieldNames(type), overlayLocales, {
    maxLength: SECTION_TR_FIELD_MAX_LENGTH,
  }).safeParse(input);
  if (!parsed.success) {
    throw new CmsError(
      'validation',
      'Перевод секции не сохранён: значение не является текстом или превышает допустимую длину.',
    );
  }

  let provided = false;
  for (const [locale, fields] of Object.entries(parsed.data)) {
    if (!fields || Object.keys(fields).length === 0) continue;
    provided = true;

    const patch = buildSectionTranslationPatch(type, fields);
    if (JSON.stringify(patch).length > SECTION_TRANSLATION_MAX_BYTES) {
      throw new CmsError(
        'validation',
        `Перевод секции слишком большой (лимит ${SECTION_TRANSLATION_MAX_BYTES} байт на язык).`,
      );
    }

    if (Object.keys(patch).length === 0) {
      delete value[locale];
    } else {
      value[locale] = patch;
    }
  }

  return { provided, value };
}

// -----------------------------------------------------------------------------
// UI-хелпер.
// -----------------------------------------------------------------------------

/**
 * Вкладки языков секции: дефолтный первым, затем остальные включённые (без дублей).
 * Набор — из конфигурации магазина, без хардкода языков (мультитенантность).
 */
export function sectionLocaleTabs(
  locales: readonly string[],
  defaultLocale: string,
): string[] {
  const seen = new Set<string>([defaultLocale]);
  const tabs = [defaultLocale];
  for (const loc of locales) {
    if (seen.has(loc)) continue;
    seen.add(loc);
    tabs.push(loc);
  }
  return tabs;
}

/** Тип секции известен платформе? (защита от мусора в БД/входе). */
export function isCmsSectionType(v: unknown): v is CmsSectionType {
  return typeof v === 'string' && (CMS_SECTION_TYPES as readonly string[]).includes(v);
}
