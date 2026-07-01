import Link from 'next/link';

import { sql } from '@/lib/db/client';
import { can } from '@/lib/auth/rbac';
import { getEnv } from '@/lib/config/env';
import { formatPrice } from '@/lib/admin/format';
import {
  deliveryTypeLabel,
  formatDateTime,
} from '@/lib/admin/order-format';
import { mapOrder, getPromoByCode } from '@/lib/orders/repository';
import type { Order } from '@/lib/orders/types';
import {
  ORDER_STATUSES,
  PAYMENT_STATUSES,
  DELIVERY_TYPES,
  type OrderStatus,
  type PaymentStatus,
  type DeliveryType,
} from '@/lib/orders/types';

import { Forbidden } from '../_components/Forbidden';
import { PageHeader } from '../_components/PageHeader';
import { guardOrders } from './_components/guard';
import { OrderFilters } from './_components/OrderFilters';
import {
  OrderStatusBadge,
  PaymentStatusBadge,
  DeliveryStatusBadge,
} from './_components/StatusBadges';

/**
 * Список заказов админки (docs/07 §5, Пакет 3.E).
 *
 * Серверная загрузка с фильтрами из searchParams (URL = состояние, shareable):
 * поиск (номер/email/телефон), статус заказа/оплаты, тип доставки, период дат,
 * промокод; серверная пагинация. Колонки: номер/дата/покупатель/сумма(formatPrice)/
 * статус заказа(бейдж)/оплата/доставка/способ доставки. Доступ — guardOrders
 * (модуль orders + право orders.read).
 *
 * Чтение списка идёт прямым параметризованным sql во view-слое (фильтры по дате/
 * типу доставки не покрыты ListOrdersFilter репозитория — это допустимо для
 * страницы-представления); мапперы строки→домен переиспользуются из repository
 * (mapOrder), бизнес-логика lib/orders НЕ дублируется.
 *
 * force-dynamic: читает БД/cookies — не пререндерить при build.
 */
export const dynamic = 'force-dynamic';

const PAGE_SIZE = 25;

export interface OrdersFilter {
  q?: string;
  status?: OrderStatus;
  paymentStatus?: PaymentStatus;
  deliveryType?: DeliveryType;
  promoCode?: string;
  dateFrom?: string;
  dateTo?: string;
  page: number;
}

/**
 * Заданы ли хоть какие-то фильтры (кроме страницы). Баг #3 аудита тупиков:
 * пустое состояние таблицы должно различать «ничего не найдено по фильтрам» и
 * «заказов ещё нет» (новый магазин) — иначе совет «измените фильтры» бессмыслен.
 */
export function hasActiveOrderFilters(filter: OrdersFilter): boolean {
  return Boolean(
    filter.q ||
      filter.status ||
      filter.paymentStatus ||
      filter.deliveryType ||
      filter.promoCode ||
      filter.dateFrom ||
      filter.dateTo,
  );
}

function parseFilter(sp: Record<string, string | string[] | undefined>): OrdersFilter {
  const one = (k: string): string | undefined => {
    const v = sp[k];
    return Array.isArray(v) ? v[0] : v;
  };
  const status = one('status');
  const paymentStatus = one('paymentStatus');
  const deliveryType = one('deliveryType');
  const page = Number(one('page') ?? '1');
  return {
    q: one('q') || undefined,
    status: ORDER_STATUSES.includes(status as OrderStatus) ? (status as OrderStatus) : undefined,
    paymentStatus: PAYMENT_STATUSES.includes(paymentStatus as PaymentStatus)
      ? (paymentStatus as PaymentStatus)
      : undefined,
    deliveryType: DELIVERY_TYPES.includes(deliveryType as DeliveryType)
      ? (deliveryType as DeliveryType)
      : undefined,
    promoCode: one('promoCode') || undefined,
    dateFrom: one('dateFrom') || undefined,
    dateTo: one('dateTo') || undefined,
    page: Number.isFinite(page) && page > 0 ? Math.floor(page) : 1,
  };
}

/** Сохраняет текущие фильтры, меняя только page (для ссылок пагинации). */
function pageHref(
  sp: Record<string, string | string[] | undefined>,
  page: number,
): string {
  const next = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (k === 'page') continue;
    const value = Array.isArray(v) ? v[0] : v;
    if (value) next.set(k, value);
  }
  next.set('page', String(page));
  return `/admin/orders?${next.toString()}`;
}

/**
 * Загрузка отфильтрованного списка заказов (view-слой). Параметризованный sql
 * (анти-SQLi); промокод резолвится в id через repository.getPromoByCode.
 */
async function loadOrders(
  filter: OrdersFilter,
): Promise<{ rows: Order[]; total: number }> {
  const limit = PAGE_SIZE;
  const offset = (filter.page - 1) * PAGE_SIZE;
  const q = filter.q ? `%${filter.q}%` : null;

  let promoCodeId: string | null = null;
  if (filter.promoCode) {
    const promo = await getPromoByCode(filter.promoCode);
    if (!promo) {
      // Нет такого промокода → заведомо пустой результат.
      return { rows: [], total: 0 };
    }
    promoCodeId = promo.id;
  }

  // Верхняя граница периода — конец дня (включительно).
  const dateTo = filter.dateTo ? `${filter.dateTo}T23:59:59.999Z` : null;
  const dateFrom = filter.dateFrom ? `${filter.dateFrom}T00:00:00.000Z` : null;

  const where = sql`
    WHERE (${filter.status ?? null}::text IS NULL OR status = ${filter.status ?? null})
      AND (${filter.paymentStatus ?? null}::text IS NULL OR payment_status = ${filter.paymentStatus ?? null})
      AND (${filter.deliveryType ?? null}::text IS NULL OR delivery_type = ${filter.deliveryType ?? null})
      AND (${promoCodeId}::uuid IS NULL OR promo_code_id = ${promoCodeId})
      AND (${q}::text IS NULL OR number ILIKE ${q} OR customer_email ILIKE ${q} OR customer_phone ILIKE ${q})
      AND (${dateFrom}::timestamptz IS NULL OR created_at >= ${dateFrom})
      AND (${dateTo}::timestamptz IS NULL OR created_at <= ${dateTo})
  `;

  const [totalRows, rows] = await Promise.all([
    sql<{ n: string }[]>`SELECT count(*)::text AS n FROM orders ${where}`,
    sql<Record<string, unknown>[]>`
      SELECT * FROM orders ${where}
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `,
  ]);

  return { rows: rows.map(mapOrder), total: Number(totalRows[0]?.n ?? 0) };
}

export default async function OrdersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const guard = await guardOrders('orders.read');
  if (!guard.ok) {
    if (guard.reason === 'module_disabled') {
      return <Forbidden permission="orders (модуль выключен)" />;
    }
    return <Forbidden permission={guard.permission} />;
  }

  const sp = await searchParams;
  const filter = parseFilter(sp);
  const currency = getEnv().SHOP_CURRENCY;
  // Кнопка «Создать заказ» — только при праве orders.write (UI-фильтр RBAC; сама
  // страница /orders/new и экшен createManualOrder защищены отдельно на сервере).
  const canWrite = can(guard.user, 'orders.write');

  const { rows, total } = await loadOrders(filter);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const currentPage = Math.min(filter.page, totalPages);

  return (
    <div>
      <PageHeader
        title="Заказы"
        subtitle={`Найдено заказов: ${total}. Суммы в ${currency}.`}
        breadcrumbs={[{ label: 'Заказы' }]}
        action={
          <>
            {canWrite ? (
              <Link
                href="/admin/orders/new"
                className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
              >
                Создать заказ
              </Link>
            ) : null}
            <Link
              href="/admin/promo"
              className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100"
            >
              Промокоды
            </Link>
          </>
        }
      />

      <div className="mt-4">
        <OrderFilters />
      </div>

      <div className="mt-6 overflow-x-auto rounded-lg border border-gray-200">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50 text-left text-gray-500">
            <tr>
              <th scope="col" className="px-4 py-2 font-medium">Номер</th>
              <th scope="col" className="px-4 py-2 font-medium">Дата</th>
              <th scope="col" className="px-4 py-2 font-medium">Покупатель</th>
              <th scope="col" className="px-4 py-2 font-medium">Сумма</th>
              <th scope="col" className="px-4 py-2 font-medium">Статус</th>
              <th scope="col" className="px-4 py-2 font-medium">Оплата</th>
              <th scope="col" className="px-4 py-2 font-medium">Доставка</th>
              <th scope="col" className="px-4 py-2 font-medium">Способ</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {rows.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-6 text-center text-gray-400">
                  {hasActiveOrderFilters(filter) ? (
                    'По заданным фильтрам ничего не найдено. Сбросьте фильтры.'
                  ) : (
                    <span>
                      Заказов пока нет.{' '}
                      {canWrite ? (
                        <Link
                          href="/admin/orders/new"
                          className="font-medium text-blue-700 hover:underline"
                        >
                          Создать заказ
                        </Link>
                      ) : null}
                    </span>
                  )}
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.id} className="hover:bg-gray-50">
                  <td className="px-4 py-2">
                    <Link
                      href={`/admin/orders/${row.id}`}
                      className="font-medium text-blue-700 hover:underline"
                    >
                      {row.number}
                    </Link>
                  </td>
                  <td className="px-4 py-2 text-gray-600">{formatDateTime(row.createdAt)}</td>
                  <td className="px-4 py-2 text-gray-700">
                    <div>{row.customerName}</div>
                    <div className="text-xs text-gray-400">{row.customerEmail}</div>
                  </td>
                  <td className="px-4 py-2 font-medium text-gray-900">
                    {formatPrice(row.grandTotal, row.currency)}
                  </td>
                  <td className="px-4 py-2">
                    <OrderStatusBadge status={row.status} />
                  </td>
                  <td className="px-4 py-2">
                    <PaymentStatusBadge status={row.paymentStatus} />
                  </td>
                  <td className="px-4 py-2">
                    <DeliveryStatusBadge status={row.deliveryStatus} />
                  </td>
                  <td className="px-4 py-2 text-gray-600">
                    {deliveryTypeLabel(row.deliveryType)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {totalPages > 1 ? (
        <nav
          className="mt-4 flex items-center justify-between text-sm"
          aria-label="Пагинация"
        >
          <span className="text-gray-500">
            Страница {currentPage} из {totalPages}
          </span>
          <div className="flex gap-2">
            {currentPage > 1 ? (
              <Link
                href={pageHref(sp, currentPage - 1)}
                className="rounded border border-gray-300 px-3 py-1.5 hover:bg-gray-100"
              >
                Назад
              </Link>
            ) : null}
            {currentPage < totalPages ? (
              <Link
                href={pageHref(sp, currentPage + 1)}
                className="rounded border border-gray-300 px-3 py-1.5 hover:bg-gray-100"
              >
                Вперёд
              </Link>
            ) : null}
          </div>
        </nav>
      ) : null}
    </div>
  );
}
