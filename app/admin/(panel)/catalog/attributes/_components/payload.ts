import type {
  AttributeCreateInput,
  AttributeUpdateInput,
  AttributeValueInput,
  AttributeValueUpdateInput,
} from '@/lib/catalog/schemas';
import type { AttributeType } from '@/lib/catalog/types';

/**
 * Сборка payload форм справочника характеристик (F3 аудита тупиков).
 *
 * Чистые функции без React/'use server' — общий источник правды для клиентских
 * форм (_components) и для тестов (tests/catalog/attributes-form.test.ts).
 * Возвращают объект, который затем валидируется соответствующей Zod-схемой
 * каталога ВНУТРИ defineAction (createAttribute/updateAttribute/addAttributeValue) —
 * здесь Zod НЕ дублируется, только нормализуем строки формы (trim, пустое→undefined).
 *
 * Принцип единого контракта: тип возврата сужен до Partial входной схемы Action,
 * поэтому рассинхрон формы и схемы ловится TypeScript на этапе сборки.
 */

/** Сырые поля формы создания характеристики. */
export interface AttributeCreateFormValues {
  code: string;
  name: string;
  type?: AttributeType;
  unit?: string;
  isVariant?: boolean;
  isFilterable?: boolean;
  isRequired?: boolean;
  sort?: number;
}

/** Сырые поля формы правки характеристики (code неизменяем). */
export interface AttributeUpdateFormValues {
  name?: string;
  type?: AttributeType;
  /** undefined — не трогаем; '' — сброс в null; иначе — установить. */
  unit?: string;
  isVariant?: boolean;
  isFilterable?: boolean;
  isRequired?: boolean;
  sort?: number;
}

/** Сырые поля формы добавления значения словаря. */
export interface AttributeValueFormValues {
  value: string;
  slug?: string;
  sort?: number;
  /**
   * HEX цвета как его ввёл человек. Поле показывается только для справочника
   * «Цвет»; для прочих справочников не передаётся вовсе (undefined).
   */
  colorHex?: string;
}

/** Сырые поля формы правки значения словаря (attributeId неизменяем). */
export interface AttributeValueUpdateFormValues {
  value?: string;
  slug?: string;
  sort?: number;
  /** undefined — не трогаем; '' — очистка hex в null; иначе — нормализованный HEX. */
  colorHex?: string;
}

/**
 * Нормализует ввод HEX к виду '#RRGGBB'.
 *
 * ПОЧЕМУ ЗДЕСЬ, А НЕ В ZOD: схема (и CHECK в БД) принимают строго '#RRGGBB',
 * а человек набирает и `FFFFFF`, и `#fff`. Отвергать такой ввод ошибкой —
 * бессмысленная работа для редактора, поэтому бытовые формы дополняем здесь, в
 * общем месте для формы и тестов. Всё, что не распознано, отдаём КАК ЕСТЬ:
 * решение «это невалидно» принимает Zod на сервере, а не форма.
 */
function normalizeHexInput(v: string): string {
  const t = v.trim();
  const body = t.startsWith('#') ? t.slice(1) : t;
  if (/^[0-9a-fA-F]{6}$/.test(body)) {
    return `#${body.toUpperCase()}`;
  }
  // Сокращённая запись #RGB → #RRGGBB (дублируем каждый нибл).
  if (/^[0-9a-fA-F]{3}$/.test(body)) {
    return `#${body
      .split('')
      .map((c) => c + c)
      .join('')
      .toUpperCase()}`;
  }
  return t;
}

/** Пустая строка → null (очистка hex), иначе нормализованный HEX. */
function hexToPayload(v: string | undefined): string | null | undefined {
  if (v === undefined) return undefined;
  return v.trim() === '' ? null : normalizeHexInput(v);
}

/** Пустую/пробельную строку приводим к undefined (поле не передаём). */
function blankToUndefined(v: string | undefined): string | undefined {
  if (v == null) return undefined;
  const t = v.trim();
  return t === '' ? undefined : t;
}

/**
 * Создание характеристики → вход createAttribute (AttributeCreateSchema).
 * Дефолты type/флагов/sort оставляем схеме (Zod 4 применяет .default()).
 */
export function buildAttributeCreatePayload(
  v: AttributeCreateFormValues,
): Partial<AttributeCreateInput> {
  return {
    code: v.code.trim(),
    name: v.name.trim(),
    type: v.type,
    unit: blankToUndefined(v.unit),
    isVariant: v.isVariant,
    isFilterable: v.isFilterable,
    isRequired: v.isRequired,
    sort: v.sort,
  };
}

/**
 * Правка характеристики → вход updateAttribute (AttributeUpdateSchema).
 * unit: undefined — не трогаем; пустая строка — сброс в null; иначе — trim.
 * (UpDate-схема: unit.nullish(); сервер пишет null лишь когда передан.)
 */
export function buildAttributeUpdatePayload(
  id: string,
  v: AttributeUpdateFormValues,
): Partial<AttributeUpdateInput> & { id: string } {
  const unit =
    v.unit === undefined ? undefined : v.unit.trim() === '' ? null : v.unit.trim();
  return {
    id,
    name: v.name === undefined ? undefined : v.name.trim(),
    type: v.type,
    unit,
    isVariant: v.isVariant,
    isFilterable: v.isFilterable,
    isRequired: v.isRequired,
    sort: v.sort,
  };
}

/**
 * Добавление значения словаря → вход addAttributeValue (AttributeValueSchema).
 * Пустой slug → undefined: сервер сгенерирует его сам.
 */
export function buildAttributeValuePayload(
  attributeId: string,
  v: AttributeValueFormValues,
): Partial<AttributeValueInput> & { attributeId: string } {
  // HEX при создании: пустое поле — просто не передаём (значение без hex
  // валидно). Очистка через null здесь не нужна — очищать ещё нечего.
  const rawHex = blankToUndefined(v.colorHex);
  return {
    attributeId,
    value: v.value.trim(),
    slug: blankToUndefined(v.slug),
    sort: v.sort,
    colorHex: rawHex === undefined ? undefined : normalizeHexInput(rawHex),
  };
}

/**
 * Правка значения словаря → вход updateAttributeValue (AttributeValueUpdateSchema).
 * Поля, которых нет в форме, остаются undefined — сервер их не трогает.
 * colorHex: '' — осознанная ОЧИСТКА hex (null), иначе нормализованный HEX.
 */
export function buildAttributeValueUpdatePayload(
  id: string,
  v: AttributeValueUpdateFormValues,
): Partial<AttributeValueUpdateInput> & { id: string } {
  return {
    id,
    value: v.value === undefined ? undefined : v.value.trim(),
    slug: v.slug === undefined ? undefined : v.slug.trim() === '' ? null : v.slug.trim(),
    sort: v.sort,
    colorHex: hexToPayload(v.colorHex),
  };
}
