'use client';

/**
 * Клиентское отображение цены в ВЫБРАННОЙ валюте (мультивалюта ₽/€).
 *
 * Принимает РУБЛЁВУЮ цену (строка NUMERIC или число) — как приходит из каталога —
 * и форматирует её в текущей валюте отображения (useCurrency). До маунта (SSR и
 * первый client-render) валюта = базовая (₽), поэтому server/client разметка
 * совпадает и гидрация не рвётся; после маунта цена пересчитывается в выбранную
 * валюту по курсу. Заменяет прямой вызов formatPrice в местах, где нужен показ в
 * выбранной валюте (карточка/страница товара/корзина).
 *
 * 🔴 РУЧНАЯ «КРУГЛАЯ» ЦЕНА (этап 3). Если у товара задана ручная цена для
 * выбранной валюты (`displayPrices` из DTO), показываем РОВНО ЕЁ вместо деления
 * на курс — «480 €» вместо «4783,12 €». Это ТОЛЬКО ценник: сумма к оплате
 * считается от рублёвой цены, и в корзину/чекаут карта не передаётся.
 */

import { formatDisplayPrice, type DisplayPrices } from '@/lib/format';
import { useCurrency } from '@/lib/currency';

interface Props {
  /** Цена в рублях (строка NUMERIC "7500.00" или число). */
  priceRub: string | number | null | undefined;
  /**
   * Ручные цены показа товара ({"EUR":"480.00"}). Не задано/пусто → цена
   * считается по курсу, как раньше (анти-регресс для всех прежних вызовов).
   */
  displayPrices?: DisplayPrices | null;
  className?: string;
}

export default function Price({ priceRub, displayPrices, className }: Props) {
  const { selected } = useCurrency();
  const text = formatDisplayPrice(priceRub, selected, displayPrices);
  return <span className={className}>{text}</span>;
}
