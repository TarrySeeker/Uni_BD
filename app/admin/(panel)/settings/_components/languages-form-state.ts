/**
 * Чистая логика формы «Языки» (T3) — вынесена из LanguagesForm.tsx, чтобы
 * тестироваться без DOM/Next (vitest env=node, как остальной слой настроек).
 *
 * Мультитенантность: LANGUAGE_LIBRARY — справочник ПЛАТФОРМЫ (частые языки
 * интерфейса), а не набор конкретного магазина. Набор магазина приходит из
 * shop_settings.i18n; язык, которого нет в справочнике (редкая локаль клиента),
 * всё равно отображается — просто без человекочитаемого названия.
 */

// Импорт ИМЕННО из leaf-модуля: '@/lib/i18n/config' тянет БД в браузерный бандл.
import { normalizeLocale } from '@/lib/i18n/locale-token';
import type { Locale, LocaleConfig, MessageRef } from '@/lib/i18n/types';

/** Язык справочника: тег + название на его собственном языке. */
export interface LanguageOption {
  code: Locale;
  label: string;
}

/**
 * Справочник языков платформы. Не является ограничением: любой BCP-47-подобный
 * тег можно добавить вручную (addCustomLocale) — справочник лишь избавляет от
 * ручного ввода самых частых случаев.
 */
export const LANGUAGE_LIBRARY: readonly LanguageOption[] = [
  { code: 'ru', label: 'Русский' },
  { code: 'en', label: 'English' },
  { code: 'fr', label: 'Français' },
  { code: 'de', label: 'Deutsch' },
  { code: 'es', label: 'Español' },
  { code: 'it', label: 'Italiano' },
  { code: 'pt', label: 'Português' },
  { code: 'nl', label: 'Nederlands' },
  { code: 'pl', label: 'Polski' },
  { code: 'cs', label: 'Čeština' },
  { code: 'tr', label: 'Türkçe' },
  { code: 'uk', label: 'Українська' },
  { code: 'kk', label: 'Қазақша' },
  { code: 'be', label: 'Беларуская' },
  { code: 'hy', label: 'Հայերեն' },
  { code: 'ka', label: 'ქართული' },
  { code: 'ar', label: 'العربية' },
  { code: 'he', label: 'עברית' },
  { code: 'zh', label: '中文' },
  { code: 'ja', label: '日本語' },
  { code: 'ko', label: '한국어' },
  { code: 'hi', label: 'हिन्दी' },
] as const;

/** Формат тега языка (тот же, что у схемы настроек i18n). */
const LOCALE_TAG_RE = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/;

/** Валиден ли тег языка после нормализации ('PT-BR' → 'pt-br' → true). */
export function isValidLocaleTag(raw: string): boolean {
  return LOCALE_TAG_RE.test(normalizeLocale(raw));
}

/** Название языка из справочника; для неизвестного тега — сам тег. */
export function localeLabel(
  code: Locale,
  library: readonly LanguageOption[] = LANGUAGE_LIBRARY,
): string {
  return library.find((l) => l.code === code)?.label ?? code;
}

/** Строка списка языков в форме. */
export interface LanguageRow extends LanguageOption {
  /** Включён ли язык в магазине. */
  enabled: boolean;
  /** Язык по умолчанию (канон базовых колонок) — выключить нельзя. */
  isDefault: boolean;
}

/**
 * Список языков для формы: язык по умолчанию первым, затем прочие включённые
 * (в порядке настройки), затем остальной справочник платформы. Языки магазина,
 * отсутствующие в справочнике, не теряются.
 */
export function buildLanguageOptions(
  config: LocaleConfig,
  library: readonly LanguageOption[] = LANGUAGE_LIBRARY,
): LanguageRow[] {
  const defaultLocale = normalizeLocale(config.defaultLocale);
  const enabled = config.locales.map(normalizeLocale);
  const enabledSet = new Set(enabled);

  const ordered: Locale[] = [];
  const push = (code: Locale) => {
    if (code && !ordered.includes(code)) ordered.push(code);
  };

  push(defaultLocale);
  enabled.forEach(push);
  library.forEach((l) => push(l.code));

  return ordered.map((code) => ({
    code,
    label: localeLabel(code, library),
    enabled: enabledSet.has(code) || code === defaultLocale,
    isDefault: code === defaultLocale,
  }));
}

/**
 * Включает/выключает язык в наборе. Язык по умолчанию выключить невозможно —
 * набор без канона оставил бы контент без базового языка.
 */
export function toggleLocale(
  enabled: readonly Locale[],
  code: Locale,
  on: boolean,
  defaultLocale: Locale,
): Locale[] {
  const target = normalizeLocale(code);
  if (!on && target === normalizeLocale(defaultLocale)) {
    return [...enabled];
  }
  if (on) {
    return enabled.includes(target) ? [...enabled] : [...enabled, target];
  }
  return enabled.filter((l) => l !== target);
}

/**
 * Результат добавления языка вручную. Отказ несёт ССЫЛКУ на сообщение каталога
 * (ключ + ICU-параметры), а не готовую строку: модуль чистый и локали оператора не
 * знает — текст собирает компонент через `t(error.key, error.params)`. Склеенная
 * здесь строка была бы русской при любой локали админки.
 */
export interface AddLocaleResult {
  ok: boolean;
  enabled: Locale[];
  error?: MessageRef;
}

/** Добавляет произвольный тег языка (для локалей вне справочника платформы). */
export function addCustomLocale(enabled: readonly Locale[], raw: string): AddLocaleResult {
  const code = normalizeLocale(raw);
  if (!isValidLocaleTag(code)) {
    return {
      ok: false,
      enabled: [...enabled],
      error: { key: 'settings.languagesForm.errors.invalidTag' },
    };
  }
  if (enabled.includes(code)) {
    return {
      ok: false,
      enabled: [...enabled],
      error: { key: 'settings.languagesForm.errors.alreadyAdded', params: { code } },
    };
  }
  return { ok: true, enabled: [...enabled, code] };
}

/**
 * Собирает значение ключа i18n из состояния формы: нормализует теги, убирает
 * дубли и гарантирует, что язык по умолчанию присутствует и стоит первым
 * (инвариант схемы i18nSchema: defaultLocale ∈ locales).
 */
export function buildI18nPayload(state: {
  defaultLocale: Locale;
  enabled: readonly Locale[];
}): { defaultLocale: Locale; locales: Locale[] } {
  const defaultLocale = normalizeLocale(state.defaultLocale);
  const locales: Locale[] = [defaultLocale];
  for (const raw of state.enabled) {
    const code = normalizeLocale(raw);
    if (code && !locales.includes(code)) locales.push(code);
  }
  return { defaultLocale, locales };
}
