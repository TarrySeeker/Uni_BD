import type { ProductStatus } from '@/lib/catalog/types';
import { formatDiscount } from '@/lib/admin/format';

/**
 * Презентационные бейджи каталога (без 'use client' — чистый рендер).
 * Используются в списке товаров и карточке: статус, флаги New/Хит, скидка%.
 */

const STATUS_LABEL: Record<ProductStatus, string> = {
  draft: 'Черновик',
  active: 'Активен',
  archived: 'В архиве',
};

const STATUS_CLASS: Record<ProductStatus, string> = {
  draft: 'bg-gray-100 text-gray-700',
  active: 'bg-green-100 text-green-800',
  archived: 'bg-amber-100 text-amber-800',
};

export function StatusBadge({ status }: { status: ProductStatus }) {
  return (
    <span
      className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_CLASS[status]}`}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

/** Бейдж «Новинка» (вычисленная новизна). */
export function NewBadge() {
  return (
    <span className="inline-block rounded bg-blue-100 px-1.5 py-0.5 text-xs font-semibold text-blue-800">
      New
    </span>
  );
}

/** Бейдж «Хит/Рекомендуемый» (ручной флаг is_featured). */
export function FeaturedBadge() {
  return (
    <span className="inline-block rounded bg-purple-100 px-1.5 py-0.5 text-xs font-semibold text-purple-800">
      Хит
    </span>
  );
}

/**
 * Бейдж скидки «−21 %» (docs/06 §3.1). Возвращает null, если скидки нет —
 * предикат «со скидкой»/процент вычисляются в pricing.ts/repository.
 */
export function DiscountBadge({ pct }: { pct: number | null }) {
  const label = formatDiscount(pct);
  if (!label) {
    return null;
  }
  return (
    <span className="inline-block rounded bg-red-100 px-1.5 py-0.5 text-xs font-semibold text-red-700">
      {label}
    </span>
  );
}
