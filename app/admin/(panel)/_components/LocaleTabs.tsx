'use client';

import { useState, type ReactNode } from 'react';

/**
 * Переключатель языков + пополевой ввод переводов на форме сущности
 * (ADR-i18n, docs/24 §1, инкремент 2b).
 *
 * Вкладка defaultLocale (ru) = обычное редактирование БАЗОВЫХ колонок (children —
 * существующая форма как есть). Вкладки не-дефолтных языков (en/fr из
 * shop_settings.i18n) = пополевой ввод переводов whitelist-полей сущности.
 * Переводы хранятся в состоянии формы как { [locale]: { [field]: string } } и
 * уходят в Server Action блоком translations (mergeTranslations пишет ТОЛЬКО
 * переданный язык; база ru остаётся в обычных колонках).
 *
 * Универсально/мультитенантно: набор языков и поля приходят пропсами; при одном
 * языке (или в режиме создания) панель переводов не показывается — форма выглядит
 * ровно как раньше.
 */

/** Описание одного переводимого поля (ключ + подпись + вид ввода). */
export interface TranslatableFieldDef {
  /** Ключ поля (совпадает с whitelist и ключом оверлея, camelCase). */
  key: string;
  /** Человекочитаемая подпись. */
  label: string;
  /** Вид ввода: однострочный (по умолчанию) или многострочный. */
  kind?: 'text' | 'textarea';
}

/** Состояние переводов формы: locale → { field → value }. */
export type TranslationsState = Record<string, Record<string, string>>;

const inputCls =
  'mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm disabled:bg-gray-100';
const labelCls = 'block text-sm font-medium text-gray-700';

export function LocaleTabs({
  locales,
  defaultLocale,
  fields,
  value,
  onChange,
  enabled = true,
  pending = false,
  onSave,
  disabled = false,
  children,
}: {
  /** Все включённые языки магазина (shop_settings.i18n.locales). */
  locales: readonly string[];
  /** Язык по умолчанию (база = обычные колонки). */
  defaultLocale: string;
  /** Переводимые поля сущности (whitelist read/write-path). */
  fields: readonly TranslatableFieldDef[];
  /** Текущее состояние переводов (не-дефолтные языки). */
  value: TranslationsState;
  /** Изменение состояния переводов. */
  onChange: (next: TranslationsState) => void;
  /** Показывать ли панель переводов (обычно isEdit). */
  enabled?: boolean;
  /** Идёт ли сохранение. */
  pending?: boolean;
  /** Сохранить перевод (обычно тот же обработчик, что и базовое сохранение). */
  onSave?: () => void;
  /** Только чтение (нет права записи). */
  disabled?: boolean;
  /** Базовая форма (редактирование ru-колонок). */
  children: ReactNode;
}) {
  const [active, setActive] = useState<string>(defaultLocale);
  const others = locales.filter((l) => l !== defaultLocale);

  // Один язык или панель выключена → форма без изменений (обратная совместимость).
  if (!enabled || others.length === 0) {
    return <>{children}</>;
  }

  function setField(locale: string, key: string, v: string) {
    onChange({
      ...value,
      [locale]: { ...(value[locale] ?? {}), [key]: v },
    });
  }

  const tabs = [defaultLocale, ...others];

  return (
    <div>
      <div
        role="tablist"
        aria-label="Язык контента"
        className="mb-4 flex flex-wrap gap-1 border-b border-gray-200"
      >
        {tabs.map((loc) => (
          <button
            key={loc}
            role="tab"
            type="button"
            aria-selected={active === loc}
            onClick={() => setActive(loc)}
            className={`px-4 py-2 text-sm font-medium ${
              active === loc
                ? 'border-b-2 border-gray-900 text-gray-900'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            {loc === defaultLocale ? `${loc.toUpperCase()} · основной` : loc.toUpperCase()}
          </button>
        ))}
      </div>

      {active === defaultLocale ? (
        children
      ) : (
        <div>
          <p className="mb-4 rounded border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800">
            Перевод для языка <strong>{active.toUpperCase()}</strong>. Пустое поле —
            на витрине показывается основной ({defaultLocale.toUpperCase()}) текст.
            Основные значения редактируются на вкладке «{defaultLocale.toUpperCase()} · основной».
          </p>

          <div className="grid grid-cols-1 gap-4">
            {fields.map((f) => {
              const id = `tr-${active}-${f.key}`;
              const v = value[active]?.[f.key] ?? '';
              return (
                <div key={f.key}>
                  <label htmlFor={id} className={labelCls}>
                    {f.label}
                  </label>
                  {f.kind === 'textarea' ? (
                    <textarea
                      id={id}
                      value={v}
                      rows={4}
                      disabled={disabled}
                      onChange={(e) => setField(active, f.key, e.target.value)}
                      className={inputCls}
                    />
                  ) : (
                    <input
                      id={id}
                      value={v}
                      disabled={disabled}
                      onChange={(e) => setField(active, f.key, e.target.value)}
                      className={inputCls}
                    />
                  )}
                </div>
              );
            })}
          </div>

          {onSave && !disabled ? (
            <div className="mt-6 flex items-center gap-3 border-t border-gray-200 pt-4">
              <button
                type="button"
                onClick={onSave}
                disabled={pending}
                className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50"
              >
                {pending ? 'Сохранение…' : 'Сохранить перевод'}
              </button>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

/**
 * Сырой оверлей translations сущности → состояние формы (только строковые значения).
 * Нестроковые значения (структурный CMS-контент и т.п.) игнорируются — панель
 * переводов работает с плоскими текстовыми полями.
 */
export function toTranslationsState(
  raw: Record<string, Record<string, unknown>> | null | undefined,
): TranslationsState {
  const out: TranslationsState = {};
  if (!raw) return out;
  for (const [loc, fields] of Object.entries(raw)) {
    if (!fields || typeof fields !== 'object') continue;
    const inner: Record<string, string> = {};
    for (const [k, v] of Object.entries(fields)) {
      if (typeof v === 'string') inner[k] = v;
    }
    out[loc] = inner;
  }
  return out;
}

/**
 * Состояние формы → блок translations для Server Action. Значения тримятся; язык
 * включается, если несёт хотя бы одно поле. Пустая строка допускается (позволяет
 * очистить перевод — на витрине откатится на базовый язык). Тонкую фильтрацию
 * whitelist/языков делает сервер (resolveTranslationsUpdate).
 */
export function translationsPayload(
  state: TranslationsState,
): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const [loc, fields] of Object.entries(state)) {
    const inner: Record<string, string> = {};
    for (const [k, v] of Object.entries(fields)) inner[k] = v.trim();
    if (Object.keys(inner).length) out[loc] = inner;
  }
  return out;
}

/** Whitelist-поля товара/бренда/категории для панели переводов (совпадает с *_TR_FIELDS). */
export const CATALOG_ENTITY_TR_FIELD_DEFS: readonly TranslatableFieldDef[] = [
  { key: 'name', label: 'Название', kind: 'text' },
  { key: 'description', label: 'Описание', kind: 'textarea' },
  { key: 'seoTitle', label: 'SEO Title', kind: 'text' },
  { key: 'seoDescription', label: 'SEO Description', kind: 'textarea' },
  { key: 'ogTitle', label: 'OG Title', kind: 'text' },
  { key: 'ogDescription', label: 'OG Description', kind: 'textarea' },
];

/** Whitelist-поля дизайнера для панели переводов (совпадает с DESIGNER_TR_FIELDS). */
export const DESIGNER_TR_FIELD_DEFS: readonly TranslatableFieldDef[] = [
  { key: 'name', label: 'Имя', kind: 'text' },
  { key: 'description', label: 'Описание', kind: 'textarea' },
  { key: 'country', label: 'Страна', kind: 'text' },
];

/** Whitelist-поля CMS-страницы (совпадает с CMS_PAGE_TR_FIELDS). */
export const CMS_PAGE_TR_FIELD_DEFS: readonly TranslatableFieldDef[] = [
  { key: 'title', label: 'Заголовок', kind: 'text' },
  { key: 'seoTitle', label: 'SEO Title', kind: 'text' },
  { key: 'seoDescription', label: 'SEO Description', kind: 'textarea' },
  { key: 'ogTitle', label: 'OG Title', kind: 'text' },
  { key: 'ogDescription', label: 'OG Description', kind: 'textarea' },
];
