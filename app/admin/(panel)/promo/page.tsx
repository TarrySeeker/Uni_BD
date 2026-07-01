import Link from 'next/link';

import { sql } from '@/lib/db/client';
import { getEnv } from '@/lib/config/env';
import { formatPrice } from '@/lib/admin/format';
import {
  promoKindLabel,
  promoValueSummary,
  formatDateTime,
  formatMinQty,
  formatScopeWithTargets,
} from '@/lib/admin/order-format';
import { mapPromoCode } from '@/lib/orders/repository';
import type { PromoCode } from '@/lib/orders/types';

import { Forbidden } from '../_components/Forbidden';
import { PageHeader } from '../_components/PageHeader';
import { guardOrders } from '../orders/_components/guard';
import { PromoRowActions } from './_components/PromoRowActions';

/**
 * Список промокодов админки (docs/07 §5, Пакет 3.E). CRUD под правом orders.write
 * (промокоды относятся к модулю orders). Чтение списка — прямой параметризованный
 * sql во view-слое (репозиторий не экспортирует listPromoCodes; мапппер строки→домен
 * переиспользуется из repository.mapPromoCode). Счётчик использований (used_count)
 * читается прямо из строки promo_codes. Деактивация/удаление — PromoRowActions
 * (orders.write на сервере). Цены — formatPrice (валюта из SHOP_CURRENCY).
 *
 * force-dynamic: читает БД/cookies — не пререндерить при build.
 */
export const dynamic = 'force-dynamic';

async function loadPromos(): Promise<PromoCode[]> {
  const rows = await sql<Record<string, unknown>[]>`
    SELECT id, code, kind, value, min_order_total, max_discount, usage_limit,
           per_customer_limit, used_count, starts_at, ends_at, is_active,
           bogo_buy_qty, bogo_pay_qty, apply_scope, priority, stackable, min_qty,
           gift_product_id, gift_variant_id, gift_qty, comment, created_at, updated_at
    FROM promo_codes
    ORDER BY is_active DESC, priority ASC, created_at DESC
  `;
  return rows.map(mapPromoCode);
}

/**
 * Метки конкретных таргетов по всем промокодам списка одним batch-запросом (без
 * N+1): имя категории/бренда/товара или имя/sku варианта. При ошибке/выключенном
 * каталоге деградирует в пустую Map (как loadPromoPickerData) — список всё равно
 * показывает обобщённый scope. Имена берутся из БД магазина (мультитенантно).
 */
async function loadPromoTargetLabels(ids: string[]): Promise<Map<string, string[]>> {
  const byPromo = new Map<string, string[]>();
  if (ids.length === 0) return byPromo;
  try {
    const rows = await sql<{ promo_code_id: string; label: string | null }[]>`
      SELECT pt.promo_code_id,
             COALESCE(c.name, b.name, p.name, v.name, v.sku) AS label
      FROM promo_targets pt
      LEFT JOIN categories c       ON c.id = pt.category_id
      LEFT JOIN brands b           ON b.id = pt.brand_id
      LEFT JOIN products p         ON p.id = pt.product_id
      LEFT JOIN product_variants v ON v.id = pt.variant_id
      WHERE pt.promo_code_id = ANY(${ids}::uuid[])
      ORDER BY pt.created_at, pt.id
    `;
    for (const r of rows) {
      if (r.label == null) continue;
      const arr = byPromo.get(r.promo_code_id) ?? [];
      arr.push(String(r.label));
      byPromo.set(r.promo_code_id, arr);
    }
  } catch {
    return new Map();
  }
  return byPromo;
}

/** Текст лимитов «X / ∞» (всего / на покупателя). */
function limitText(total: number | null, perCustomer: number | null): string {
  const a = total == null ? '∞' : String(total);
  const b = perCustomer == null ? '∞' : String(perCustomer);
  return `${a} / ${b}`;
}

/** Текст срока действия. */
function periodText(starts: Date | null, ends: Date | null): string {
  if (!starts && !ends) return 'бессрочно';
  const from = starts ? formatDateTime(starts) : '…';
  const to = ends ? formatDateTime(ends) : '…';
  return `${from} — ${to}`;
}

export default async function PromoPage() {
  const guard = await guardOrders('orders.write');
  if (!guard.ok) {
    if (guard.reason === 'module_disabled') {
      return <Forbidden permission="orders (модуль выключен)" />;
    }
    return <Forbidden permission={guard.permission} />;
  }

  const promos = await loadPromos();
  const labelsByPromo = await loadPromoTargetLabels(promos.map((p) => p.id));
  const currency = getEnv().SHOP_CURRENCY;

  return (
    <div>
      <PageHeader
        title="Промокоды"
        subtitle={`Всего промокодов: ${promos.length}.`}
        breadcrumbs={[{ label: 'Промокоды' }]}
        action={
          <>
            <Link
              href="/admin/orders"
              className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100"
            >
              К заказам
            </Link>
            <Link
              href="/admin/promo/new"
              className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700"
            >
              + Создать промокод
            </Link>
          </>
        }
      />

      <div className="mt-6 overflow-x-auto rounded-lg border border-gray-200">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50 text-left text-gray-500">
            <tr>
              <th scope="col" className="px-4 py-2 font-medium">Код</th>
              <th scope="col" className="px-4 py-2 font-medium">Тип</th>
              <th scope="col" className="px-4 py-2 font-medium">Значение</th>
              <th scope="col" className="px-4 py-2 font-medium">Scope</th>
              <th scope="col" className="px-4 py-2 font-medium">Приоритет</th>
              <th scope="col" className="px-4 py-2 font-medium">Мин. сумма</th>
              <th scope="col" className="px-4 py-2 font-medium">Мин. кол-во</th>
              <th scope="col" className="px-4 py-2 font-medium">Лимит (всего/на чел.)</th>
              <th scope="col" className="px-4 py-2 font-medium">Использован</th>
              <th scope="col" className="px-4 py-2 font-medium">Срок</th>
              <th scope="col" className="px-4 py-2 font-medium">Активность</th>
              <th scope="col" className="px-4 py-2 font-medium">Действия</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {promos.length === 0 ? (
              <tr>
                <td colSpan={12} className="px-4 py-6 text-center text-gray-400">
                  Промокодов пока нет. Создайте первый.
                </td>
              </tr>
            ) : (
              promos.map((p) => (
                <tr key={p.id} className="hover:bg-gray-50">
                  <td className="px-4 py-2">
                    <Link
                      href={`/admin/promo/${p.id}`}
                      className="font-medium text-blue-700 hover:underline"
                    >
                      <code>{p.code}</code>
                    </Link>
                  </td>
                  <td className="px-4 py-2 text-gray-600">{promoKindLabel(p.kind)}</td>
                  <td className="px-4 py-2 text-gray-700">
                    {p.kind === 'fixed'
                      ? formatPrice(p.value, currency)
                      : promoValueSummary(p)}
                  </td>
                  <td className="px-4 py-2 text-gray-600">
                    {formatScopeWithTargets(p.applyScope, labelsByPromo.get(p.id) ?? [])}
                    {p.stackable ? (
                      <span className="ml-1 inline-block rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-800">
                        суммируемая
                      </span>
                    ) : (
                      <span className="ml-1 inline-block rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600">
                        эксклюзивная
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-gray-600">{p.priority}</td>
                  <td className="px-4 py-2 text-gray-600">
                    {Number(p.minOrderTotal) > 0 ? formatPrice(p.minOrderTotal, currency) : '—'}
                  </td>
                  <td className="px-4 py-2 text-gray-600">{formatMinQty(p.minQty)}</td>
                  <td className="px-4 py-2 text-gray-600">
                    {limitText(p.usageLimit, p.perCustomerLimit)}
                  </td>
                  <td className="px-4 py-2 text-gray-700">{p.usedCount}</td>
                  <td className="px-4 py-2 text-xs text-gray-500">
                    {periodText(p.startsAt, p.endsAt)}
                  </td>
                  <td className="px-4 py-2">
                    {p.isActive ? (
                      <span className="inline-block rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800">
                        Активен
                      </span>
                    ) : (
                      <span className="inline-block rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600">
                        Выключен
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2">
                    <PromoRowActions id={p.id} code={p.code} isActive={p.isActive} />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
