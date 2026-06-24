import type { Money } from '@/lib/catalog/pricing';
import { isOnSale } from '@/lib/catalog/pricing';
import { formatPrice } from '@/lib/admin/format';

import { DiscountBadge } from './Badges';

/**
 * Ячейка цены: текущая цена + зачёркнутая «было» + бейдж скидки% (docs/06 §3.1).
 * «Со скидкой» определяется pricing.isOnSale; форматирование — по валюте магазина.
 */
export function PriceCell({
  price,
  compareAt,
  discountPct,
  currency,
}: {
  price: Money;
  compareAt: Money;
  discountPct: number | null;
  currency: string;
}) {
  const onSale = isOnSale(price, compareAt);
  return (
    <div className="flex flex-col gap-0.5">
      <span className="font-medium text-gray-900">
        {formatPrice(price, currency)}
      </span>
      {onSale ? (
        <span className="flex items-center gap-1.5">
          <span className="text-xs text-gray-400 line-through">
            {formatPrice(compareAt, currency)}
          </span>
          <DiscountBadge pct={discountPct} />
        </span>
      ) : null}
    </div>
  );
}
