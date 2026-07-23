/**
 * Чистая логика видимости панели переводов (LocaleTabs).
 *
 * WHY: раньше панель схлопывалась молча (`if (!enabled || others.length === 0)
 * return children`) — владелец на экране создания товара не видел ни EN, ни FR и
 * делал вывод, что перевода в системе нет. Теперь «нет вкладок» всегда имеет
 * видимую причину, а решение вынесено в чистую функцию под юнит-тесты.
 *
 * Режим создания: большинство create-действий (товар/бренд/категория/дизайнер/
 * CMS-страница/новость) блок translations НЕ принимают — их Zod-схемы содержат
 * translationsBlockSchema только в *UpdateSchema. Показать там вкладки значило бы
 * молча выбросить введённый перевод при сохранении. Поэтому на создании — честное
 * объяснение «переводы после создания». Где create-действие переводы принимает
 * (сертификаты: IssueGiftCertificateSchema.translations), форма передаёт
 * supportsCreateTranslations и вкладки показываются сразу.
 */

/** Режим формы: создание новой записи или правка существующей. */
export type LocaleTabsMode = 'create' | 'edit';

/** Почему вкладок нет (для видимого пояснения пользователю). */
export type LocaleTabsNoticeReason = 'single-locale' | 'create-first';

/** Что рисовать вместо/вместе с базовой формой. */
export type LocaleTabsState =
  | { kind: 'tabs'; tabs: string[] }
  | { kind: 'notice'; reason: LocaleTabsNoticeReason; text: string };

export interface LocaleTabsStateInput {
  /** Включённые языки магазина (shop_settings.i18n.locales). */
  locales: readonly string[];
  /** Базовый язык: живёт в обычных колонках таблицы. */
  defaultLocale: string;
  mode: LocaleTabsMode;
  /** Принимает ли create-действие сущности блок translations. */
  supportsCreateTranslations?: boolean;
}

function upper(locales: readonly string[]): string {
  return locales.map((l) => l.toUpperCase()).join(', ');
}

/**
 * Решает, показывать ли вкладки языков, и какой текст показать, если нет.
 * Тексты строятся из конфигурации (никакого хардкода ru/en/fr) — платформа
 * мультитенантна.
 */
export function resolveLocaleTabsState(input: LocaleTabsStateInput): LocaleTabsState {
  const { locales, defaultLocale, mode, supportsCreateTranslations = false } = input;

  const others: string[] = [];
  for (const l of locales) {
    if (l !== defaultLocale && !others.includes(l)) others.push(l);
  }
  const base = defaultLocale.toUpperCase();

  if (others.length === 0) {
    return {
      kind: 'notice',
      reason: 'single-locale',
      text:
        `В магазине включён один язык — ${base}. Переводить нечего: ` +
        'дополнительные языки подключаются в настройках магазина.',
    };
  }

  if (mode === 'create' && !supportsCreateTranslations) {
    return {
      kind: 'notice',
      reason: 'create-first',
      text:
        `Переводы (${upper(others)}) заполняются после создания: сохраните запись ` +
        `на основном языке (${base}) — и на её карточке появятся вкладки языков.`,
    };
  }

  return { kind: 'tabs', tabs: [defaultLocale, ...others] };
}
