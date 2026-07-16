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
 */

import { formatDisplayPrice } from '@/lib/format';
import { useCurrency } from '@/lib/currency';

interface Props {
  /** Цена в рублях (строка NUMERIC "7500.00" или число). */
  priceRub: string | number | null | undefined;
  className?: string;
}

export default function Price({ priceRub, className }: Props) {
  const { selected } = useCurrency();
  const text = formatDisplayPrice(priceRub, selected);
  return <span className={className}>{text}</span>;
}
