/**
 * Персонализация позиции — универсальный механизм платформы.
 *
 * Задача. Часть магазинов продаёт изделие «под покупателя»: гравировка на
 * флешке, имя на футболке, надпись на кружке, дата на подарке. Позиция корзины
 * у таких магазинов — это не только «какой вариант и сколько», но и «что именно
 * нанести». До появления этого модуля строка заказа несла лишь `variantId + qty`,
 * и заказ доезжал до цеха без содержания работы.
 *
 * Здесь ровно две вещи, и их важно не путать:
 *
 *   ОПИСАНИЕ (`PersonalizationSpec`) — какие поля заполняет покупатель. Задаёт
 *   владелец в карточке товара, лежит в `products.personalization`.
 *
 *   ЗНАЧЕНИЯ (`PersonalizationValues`) — что покупатель вписал. Приходят с
 *   витрины, проверяются по описанию и снимком ложатся в
 *   `order_items.personalization`.
 *
 * Инварианты:
 *
 * 1. **Проверяет сервер.** Значения валидируются по описанию, прочитанному ИЗ БД,
 *    а не по тому, что прислала витрина. Storefront API и Server Action — обычные
 *    HTTP-эндпоинты; «из формы такое не придёт» защитой не является (docs/32 §8).
 * 2. **Отказ, а не молчаливая правка.** Слишком длинная строка отклоняется, а не
 *    обрезается; лишний ключ отклоняется, а не выбрасывается. Молчаливая правка —
 *    это «сохранено», после которого покупатель получает не то, что заказывал
 *    (docs/32 §2 и §3).
 * 3. **Ноль хардкода под нишу.** Типы полей описывают форму ввода, а не предмет
 *    торговли: `text_lines` — это и три строки гравировки, и две строки вышивки.
 */

import { z } from 'zod';

// -----------------------------------------------------------------------------
// Описание полей (то, что задаёт владелец в карточке товара)
// -----------------------------------------------------------------------------

/** Пределы — страховка от описания, которое невозможно ни заполнить, ни напечатать. */
export const MAX_FIELDS = 12;
export const MAX_LINES = 10;
export const MAX_TEXT_LENGTH = 200;
export const MAX_OPTIONS = 200;

/**
 * Ключ поля уходит в JSON, в API и в печатные формы, поэтому только латиница:
 * кириллический ключ переживает не каждый шаг этого пути.
 */
const fieldKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^[a-z][a-z0-9_]*$/i, 'Ключ поля — латиница, цифры и подчёркивание, начиная с буквы.');

const labelSchema = z.string().trim().min(1, 'У поля должна быть подпись.').max(120);

const optionSchema = z.object({
  value: z.string().trim().min(1).max(80),
  label: z.string().trim().min(1).max(160),
});

/** Одна строка ввода: надпись на кружке, имя на футболке. */
const textFieldSchema = z.object({
  key: fieldKeySchema,
  type: z.literal('text'),
  label: labelSchema,
  hint: z.string().trim().max(300).optional(),
  maxLength: z.number().int().min(1).max(MAX_TEXT_LENGTH),
  required: z.boolean().optional().default(false),
});

/**
 * Несколько строк с общим пределом длины: гравировка в три строки, адрес на
 * бирке. Место строки значимо — вторая строка остаётся второй, даже если пуста.
 */
const textLinesFieldSchema = z.object({
  key: fieldKeySchema,
  type: z.literal('text_lines'),
  label: labelSchema,
  hint: z.string().trim().max(300).optional(),
  lines: z.number().int().min(1).max(MAX_LINES),
  maxLength: z.number().int().min(1).max(MAX_TEXT_LENGTH),
  required: z.boolean().optional().default(false),
});

/** Выбор из списка: знак вида спорта, шрифт, тип нанесения. */
const selectFieldSchema = z.object({
  key: fieldKeySchema,
  type: z.literal('select'),
  label: labelSchema,
  hint: z.string().trim().max(300).optional(),
  options: z
    .array(optionSchema)
    .min(1, 'У выбора должен быть хотя бы один вариант.')
    .max(MAX_OPTIONS),
  /** Допустимо ли «ничего не выбрано». */
  allowEmpty: z.boolean().optional().default(false),
  /** Как назвать пустой выбор в интерфейсе и в печати («Без знака»). */
  emptyLabel: z.string().trim().max(120).optional(),
  required: z.boolean().optional().default(false),
});

/**
 * Произвольный цвет вне палитры вариантов.
 *
 * Палитра, которую производство умеет всегда, — это варианты товара (у них своя
 * цена и свой остаток). Поле `color` нужно там, где покупателю разрешают
 * заказать оттенок вне палитры: значение едет в заказ как HEX.
 */
const colorFieldSchema = z.object({
  key: fieldKeySchema,
  type: z.literal('color'),
  label: labelSchema,
  hint: z.string().trim().max(300).optional(),
  required: z.boolean().optional().default(false),
});

export const PersonalizationFieldSchema = z.discriminatedUnion('type', [
  textFieldSchema,
  textLinesFieldSchema,
  selectFieldSchema,
  colorFieldSchema,
]);

export type PersonalizationField = z.infer<typeof PersonalizationFieldSchema>;

/**
 * Описание целиком. Пустой список запрещён: товар либо персонализируется, либо
 * у него `personalization = NULL`. Пустой объект `{ fields: [] }` — это третье,
 * неотличимое состояние, из-за которого витрина рисовала бы пустую форму.
 */
export const PersonalizationSpecSchema = z
  .object({
    fields: z
      .array(PersonalizationFieldSchema)
      .min(1, 'Нужно хотя бы одно поле, иначе персонализации у товара нет.')
      .max(MAX_FIELDS),
  })
  .superRefine((spec, ctx) => {
    const seen = new Set<string>();
    spec.fields.forEach((field, index) => {
      const key = field.key.toLowerCase();
      if (seen.has(key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['fields', index, 'key'],
          message: `Ключ «${field.key}» повторяется: одно значение затёрло бы другое.`,
        });
      }
      seen.add(key);
    });
  });

export type PersonalizationSpec = z.infer<typeof PersonalizationSpecSchema>;

/**
 * Разбор значения из БД. Битое описание НЕ роняет карточку товара и не роняет
 * заказ: возвращаем null, владелец увидит «персонализации нет» и задаст заново.
 * Падать здесь означало бы уронить весь каталог из-за одной строки в jsonb.
 */
export function parseSpec(raw: unknown): PersonalizationSpec | null {
  if (raw === null || raw === undefined) return null;
  const parsed = PersonalizationSpecSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export function isPersonalized(spec: PersonalizationSpec | null | undefined): boolean {
  return spec !== null && spec !== undefined && spec.fields.length > 0;
}

// -----------------------------------------------------------------------------
// Значения (то, что присылает покупатель)
// -----------------------------------------------------------------------------

export type PersonalizationValues = Record<string, string | string[]>;

export type ValidateResult =
  | { ok: true; values: PersonalizationValues }
  | { ok: false; message: string };

const HEX = /^#[0-9a-f]{6}$/i;

/**
 * Управляющие символы (включая перевод строки и табуляцию) в однострочном поле —
 * это либо вставка из буфера, либо попытка сломать печатную форму. Обычный
 * пробел внутри строки при этом законен: «5 «Б»», «с любовью».
 */
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;

function fail(message: string): ValidateResult {
  return { ok: false, message };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Нормализация одной строки ввода: края обрезаем, середину не трогаем. */
function normalizeLine(value: unknown, field: PersonalizationField): string | { error: string } {
  if (typeof value !== 'string') {
    return { error: `Поле «${field.label}»: ожидается текст.` };
  }
  const trimmed = value.trim();
  if (CONTROL_CHARS.test(trimmed)) {
    return { error: `Поле «${field.label}»: недопустимый символ в строке.` };
  }
  return trimmed;
}

/**
 * Проверка значений по описанию товара.
 *
 * `spec === null` означает «товар не персонализируется»: тогда единственное
 * допустимое значение — пустой объект. Присланная персонализация к такому товару
 * отклоняется, а не игнорируется молча — иначе покупатель заплатит за надпись,
 * которой не будет.
 */
export function validateValues(
  /**
   * `undefined` принимается наравне с `null` намеренно: описание приходит из
   * колонки, которой у старых объектов может не быть вовсе (маппер прошлой
   * версии, мок в тесте, частичная выборка). Падение здесь означало бы 500 на
   * создании заказа — а «описания нет» в этом месте однозначно значит «товар не
   * персонализируется», и присланные значения будут отвергнуты ниже.
   */
  spec: PersonalizationSpec | null | undefined,
  raw: unknown,
): ValidateResult {
  if (!isPlainObject(raw)) {
    return fail('Персонализация должна быть объектом.');
  }

  const keys = Object.keys(raw);

  if (spec === null || spec === undefined) {
    if (keys.length > 0) {
      return fail('Этот товар не персонализируется — персонализация для него не принимается.');
    }
    return { ok: true, values: {} };
  }

  const declared = new Set(spec.fields.map((f) => f.key));
  const extra = keys.filter((k) => !declared.has(k));
  if (extra.length > 0) {
    return fail(`Неизвестное поле персонализации: ${extra.join(', ')}.`);
  }

  // Порядок снимка — как в описании: он же порядок печати в накладной.
  const values: PersonalizationValues = {};

  for (const field of spec.fields) {
    const present = Object.prototype.hasOwnProperty.call(raw, field.key);
    const value = raw[field.key];

    if (!present || value === undefined || value === null) {
      if (field.required) {
        return fail(`Поле «${field.label}» обязательно к заполнению.`);
      }
      continue;
    }

    switch (field.type) {
      case 'text': {
        const line = normalizeLine(value, field);
        if (typeof line !== 'string') return fail(line.error);
        if (line.length > field.maxLength) {
          return fail(`Поле «${field.label}»: не длиннее ${field.maxLength} знаков.`);
        }
        if (field.required && line.length === 0) {
          return fail(`Поле «${field.label}» обязательно к заполнению.`);
        }
        values[field.key] = line;
        break;
      }

      case 'text_lines': {
        if (!Array.isArray(value)) {
          return fail(`Поле «${field.label}»: ожидается список строк.`);
        }
        if (value.length > field.lines) {
          return fail(`Поле «${field.label}»: не больше ${field.lines} строк.`);
        }
        const lines: string[] = [];
        for (const item of value) {
          const line = normalizeLine(item, field);
          if (typeof line !== 'string') return fail(line.error);
          if (line.length > field.maxLength) {
            return fail(`Поле «${field.label}»: строка не длиннее ${field.maxLength} знаков.`);
          }
          lines.push(line);
        }
        if (field.required && lines.every((l) => l.length === 0)) {
          return fail(`Поле «${field.label}» обязательно к заполнению.`);
        }
        // Хвостовые пустые строки сохраняем: место строки значимо на изделии.
        values[field.key] = lines;
        break;
      }

      case 'select': {
        const line = normalizeLine(value, field);
        if (typeof line !== 'string') return fail(line.error);
        if (line.length === 0) {
          if (field.required || !field.allowEmpty) {
            return fail(`Поле «${field.label}»: нужно выбрать вариант.`);
          }
          values[field.key] = '';
          break;
        }
        if (!field.options.some((o) => o.value === line)) {
          return fail(`Поле «${field.label}»: вариант «${line}» недоступен.`);
        }
        values[field.key] = line;
        break;
      }

      case 'color': {
        const line = normalizeLine(value, field);
        if (typeof line !== 'string') return fail(line.error);
        if (line.length === 0) {
          if (field.required) {
            return fail(`Поле «${field.label}» обязательно к заполнению.`);
          }
          break;
        }
        if (!HEX.test(line)) {
          return fail(`Поле «${field.label}»: цвет задаётся в виде #RRGGBB.`);
        }
        values[field.key] = line.toUpperCase();
        break;
      }
    }
  }

  return { ok: true, values };
}

// -----------------------------------------------------------------------------
// Снимок для строки заказа
// -----------------------------------------------------------------------------

/**
 * Что ложится в `order_items.personalization`.
 *
 * Вместе со значениями снимается и ОПИСАНИЕ полей. Одних значений мало: они
 * машинные (`{"sign":"hoop"}`), а подписи и словарь вариантов живут в карточке
 * товара, которую владелец правит и может удалить вовсе (тогда `product_id`
 * станет NULL). Без снимка описания цех увидел бы сырой JSON без единой подписи
 * — по заказу годичной давности стало бы невозможно понять, что наносить.
 *
 * Это тот же принцип, что у `name_snapshot` и `unit_price` (ADR-010): история
 * заказа не меняется от правок каталога. Пустой объект `{}` — позиция без
 * персонализации.
 */
export type PersonalizationSnapshot = { spec: PersonalizationSpec; values: PersonalizationValues };

export function buildSnapshot(
  spec: PersonalizationSpec | null | undefined,
  values: PersonalizationValues,
): PersonalizationSnapshot | Record<string, never> {
  if (spec === null || spec === undefined || Object.keys(values).length === 0) return {};
  return { spec, values };
}

/** Разбор снимка из БД. Пустой объект и мусор дают null — позиция без персонализации. */
export function parseSnapshot(raw: unknown): PersonalizationSnapshot | null {
  if (!isPlainObject(raw)) return null;
  const spec = parseSpec(raw.spec);
  if (spec === null) return null;
  if (!isPlainObject(raw.values)) return null;
  return { spec, values: raw.values as PersonalizationValues };
}

/** Строки «подпись — значение» прямо из снимка заказа, без обращения к каталогу. */
export function describeSnapshot(raw: unknown): PersonalizationRow[] {
  const snapshot = parseSnapshot(raw);
  return snapshot === null ? [] : describePersonalization(snapshot.spec, snapshot.values);
}

// -----------------------------------------------------------------------------
// Человекочитаемый вид: карточка заказа в админке и печатные формы
// -----------------------------------------------------------------------------

export type PersonalizationRow = { label: string; value: string };

/**
 * Раскладывает снимок в строки «подпись — значение».
 *
 * Печатается ПОДПИСЬ варианта, а не его код: оператор читает «Обруч», а не
 * «hoop». Если варианта уже нет в описании (владелец убрал его после заказа),
 * печатается сырое значение — потерять его нельзя, иначе цех не узнает, что
 * наносить.
 */
export function describePersonalization(
  spec: PersonalizationSpec | null | undefined,
  values: unknown,
): PersonalizationRow[] {
  if (spec === null || spec === undefined || !isPlainObject(values)) return [];

  const rows: PersonalizationRow[] = [];

  for (const field of spec.fields) {
    if (!Object.prototype.hasOwnProperty.call(values, field.key)) continue;
    const value = values[field.key];

    switch (field.type) {
      case 'text_lines': {
        if (!Array.isArray(value)) break;
        const text = value
          .filter((l): l is string => typeof l === 'string' && l.trim().length > 0)
          .join(' / ');
        if (text) rows.push({ label: field.label, value: text });
        break;
      }
      case 'select': {
        if (typeof value !== 'string') break;
        if (value === '') {
          rows.push({ label: field.label, value: field.emptyLabel ?? 'не выбрано' });
          break;
        }
        const option = field.options.find((o) => o.value === value);
        rows.push({ label: field.label, value: option?.label ?? value });
        break;
      }
      default: {
        if (typeof value !== 'string' || value.trim().length === 0) break;
        rows.push({ label: field.label, value: value.trim() });
        break;
      }
    }
  }

  return rows;
}

/** Однострочная сводка для списков заказов, где места на таблицу нет. */
export function summarizePersonalization(
  spec: PersonalizationSpec | null,
  values: unknown,
): string {
  return describePersonalization(spec, values)
    .map((r) => `${r.label}: ${r.value}`)
    .join('; ');
}
