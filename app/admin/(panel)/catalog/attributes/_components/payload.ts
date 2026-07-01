import type {
  AttributeCreateInput,
  AttributeUpdateInput,
  AttributeValueInput,
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
  return {
    attributeId,
    value: v.value.trim(),
    slug: blankToUndefined(v.slug),
    sort: v.sort,
  };
}
