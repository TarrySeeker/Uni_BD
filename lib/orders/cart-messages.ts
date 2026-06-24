/**
 * Человекочитаемые сообщения для машинных кодов недоступности позиции корзины
 * (`LineResolution.reason` + кумулятивный `out_of_stock` из quoteCart).
 *
 * ЕДИНЫЙ СЛОВАРЬ (общий корень, синтез разбора дефектов): технический код
 * (`inactive`, `out_of_stock`, …) НИКОГДА не должен утекать в UI как есть —
 * раньше createOrder отдавал `Позиция недоступна: ${reason}.` (например
 * «Позиция недоступна: out_of_stock.»), что покупатель не понимает.
 *
 * Чистая функция — тестируема без БД/Next. Переиспользуется всеми витринами
 * (мультитенант): один словарь → одинаковые понятные тексты. Storefront (storefront)
 * держит зеркальную копию для кодов из quote-issues (см. checkout).
 */

/** Коды недоступности позиции, известные домену заказов. */
export type CartLineIssueCode =
  | 'product_not_found'
  | 'variant_not_found'
  | 'inactive'
  | 'out_of_stock';

const MESSAGES: Record<CartLineIssueCode, string> = {
  product_not_found: 'Товар больше недоступен',
  variant_not_found: 'Выбранный вариант товара недоступен',
  inactive: 'Товар больше не продаётся',
  out_of_stock: 'Недостаточно товара на складе',
};

/**
 * Код → понятный покупателю текст. Неизвестный код деградирует к нейтральному
 * «Позиция недоступна» (без утечки сырого кода).
 */
export function cartLineIssueMessage(code: string): string {
  return (MESSAGES as Record<string, string>)[code] ?? 'Позиция недоступна';
}
