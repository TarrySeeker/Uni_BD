import type {
  VariantCreateInput,
  VariantUpdateInput,
} from '@/lib/catalog/schemas';
import { normalizeMoney } from '@/lib/catalog/schemas';

/**
 * Сборка payload форм вариантов товара (тупики C2/C3 аудита).
 *
 * Чистые функции без React/'use server' — общий источник правды для клиентской
 * формы VariantsSection (добавление + инлайн-редактирование) и для тестов
 * (tests/catalog/variant-payload.test.ts). Возвращают объект, который затем
 * валидируется VariantCreateSchema/VariantUpdateSchema ВНУТРИ defineAction —
 * здесь Zod НЕ дублируется, только нормализуем строки формы.
 *
 * Деньги: переиспользуем normalizeMoney (trim + запятая→точка) и дополнительно
 * убираем пробелы-разделители разрядов, чтобы RU-ввод «1 600,50» доходил до
 * сервера каноничным «1600.50» (иначе moneySchema отклонит пробел). Пустая
 * строка → null (поле наследуется от товара). Для priceDelta пусто → '0'.
 */

/** Сырые строковые поля формы варианта (добавление/редактирование). */
export interface VariantFormValues {
  /** Артикул; пусто → undefined (сервер сгенерирует уникальный). */
  sku: string;
  name: string;
  /** Своя цена варианта; пусто → null (берётся basePrice). */
  priceOverride: string;
  /** Надбавка к цене; пусто → '0'. */
  priceDelta: string;
  /** Цена «было» варианта; пусто → null (наследуется от товара). */
  compareAtPrice: string;
  /** Вес/габариты; пусто → null (наследуется от товара → дефолт магазина). */
  weight: string;
  length: string;
  width: string;
  height: string;
}

/**
 * Нормализация денежного ввода формы → каноничная строка или null.
 * normalizeMoney (запятая→точка) + удаление пробелов разрядов; пусто → null.
 */
function moneyOrNull(v: string): string | null {
  const s = normalizeMoney(v).replace(/\s/g, '');
  return s === '' ? null : s;
}

/** Пустая строка → null (наследует от товара); иначе целое (усечённое) ≥ 0 → число. */
export function strToNum(v: string): number | null {
  const t = v.trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/**
 * Поля веса/габаритов формы → объект для схемы варианта (общая часть
 * create/update).
 */
function dimensionInput(v: VariantFormValues): {
  weightG: number | null;
  lengthCm: number | null;
  widthCm: number | null;
  heightCm: number | null;
} {
  return {
    weightG: strToNum(v.weight),
    lengthCm: strToNum(v.length),
    widthCm: strToNum(v.width),
    heightCm: strToNum(v.height),
  };
}

/**
 * Добавление варианта → вход createVariant (VariantCreateSchema).
 * Пустой sku → undefined; пустые деньги → null (priceDelta → '0').
 */
export function buildVariantCreateInput(
  productId: string,
  v: VariantFormValues,
): Partial<VariantCreateInput> & { productId: string } {
  return {
    productId,
    sku: v.sku.trim() || undefined,
    name: v.name.trim(),
    priceOverride: moneyOrNull(v.priceOverride),
    priceDelta: moneyOrNull(v.priceDelta) ?? '0',
    compareAtPrice: moneyOrNull(v.compareAtPrice),
    ...dimensionInput(v),
  };
}

/**
 * Инлайн-редактирование варианта → вход updateVariant (VariantUpdateSchema).
 * Пустой sku → undefined (не трогаем); пустые деньги → null (сброс к наследованию).
 */
export function buildVariantUpdateInput(
  id: string,
  v: VariantFormValues,
): Partial<VariantUpdateInput> & { id: string } {
  return {
    id,
    sku: v.sku.trim() || undefined,
    name: v.name.trim(),
    priceOverride: moneyOrNull(v.priceOverride),
    priceDelta: moneyOrNull(v.priceDelta) ?? '0',
    compareAtPrice: moneyOrNull(v.compareAtPrice),
    ...dimensionInput(v),
  };
}
