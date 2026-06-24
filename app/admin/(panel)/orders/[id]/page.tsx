import Link from 'next/link';

import { sql } from '@/lib/db/client';
import { can } from '@/lib/auth/rbac';
import { isModuleEffectivelyEnabled } from '@/lib/config/settings';
import {
  getShipmentByOrderId,
  listStatusLogByOrderId,
} from '@/lib/cdek/repository';
import { isOrderPaidForShipment } from '@/lib/cdek/services/order';
import { formatPrice } from '@/lib/admin/format';
import {
  deliveryTypeLabel,
  paymentMethodLabel,
  historyKindLabel,
  formatDateTime,
  orderStatusLabel,
  paymentStatusLabel,
  deliveryStatusLabel,
} from '@/lib/admin/order-format';
import { getOrderById } from '@/lib/orders/repository';
import type { OrderStatusHistory } from '@/lib/orders/types';

import { Forbidden } from '../../_components/Forbidden';
import { guardOrders } from '../_components/guard';
import {
  OrderStatusBadge,
  PaymentStatusBadge,
  DeliveryStatusBadge,
} from '../_components/StatusBadges';
import { OrderActionsPanel } from '../_components/OrderActionsPanel';
import {
  CdekBlock,
  type CdekShipmentView,
  type CdekStatusLogView,
} from './_components/CdekBlock';

/**
 * Карточка заказа админки (docs/07 §5, Пакет 3.E).
 *
 * Серверная загрузка через getOrderById (заголовок + позиции-снимок). История
 * статусов (order_status_history) читается прямым параметризованным sql во
 * view-слое (репозиторий не экспортирует чтение ленты — допустимо для страницы).
 * Показывает: позиции (снимок name/sku/attributes/qty/цена/сумма), суммы
 * (товары/скидка/доставка/итог), данные покупателя/доставки/оплаты, промокод;
 * статус-машину (OrderActionsPanel — кнопки допустимых переходов, отмена/возврат)
 * и доменную ленту истории. Доступ к чтению — orders.read; действия — orders.write
 * (серверно внутри Server Actions).
 *
 * force-dynamic: читает БД/cookies — не пререндерить при build.
 */
export const dynamic = 'force-dynamic';

/** Маппер строки order_status_history → домен (только для чтения в карточке). */
function mapHistory(row: Record<string, unknown>): OrderStatusHistory {
  return {
    id: String(row.id),
    orderId: String(row.order_id),
    kind: row.kind as OrderStatusHistory['kind'],
    fromStatus: row.from_status === null || row.from_status === undefined ? null : String(row.from_status),
    toStatus: String(row.to_status),
    actorUserId: row.actor_user_id === null || row.actor_user_id === undefined ? null : String(row.actor_user_id),
    comment: String(row.comment ?? ''),
    createdAt: row.created_at instanceof Date ? row.created_at : new Date(String(row.created_at)),
  };
}

/** Лента истории статусов заказа (хронологически). */
async function loadHistory(orderId: string): Promise<OrderStatusHistory[]> {
  const rows = await sql<Record<string, unknown>[]>`
    SELECT id, order_id, kind, from_status, to_status, actor_user_id, comment, created_at
    FROM order_status_history
    WHERE order_id = ${orderId}
    ORDER BY created_at DESC, id DESC
  `;
  return rows.map(mapHistory);
}

/**
 * Серверно подгружает отправление СДЭК и историю его статусов для блока СДЭК.
 * Возвращает сериализуемые view (даты → ISO-строки) для клиентского компонента.
 */
async function loadCdek(
  orderId: string,
): Promise<{ shipment: CdekShipmentView | null; history: CdekStatusLogView[] }> {
  const shipment = await getShipmentByOrderId(orderId);
  const log = await listStatusLogByOrderId(orderId);
  return {
    shipment: shipment
      ? {
          id: shipment.id,
          cdekUuid: shipment.cdekUuid,
          cdekNumber: shipment.cdekNumber,
          statusCode: shipment.statusCode,
          statusName: shipment.statusName,
          statusAt: shipment.statusAt ? shipment.statusAt.toISOString() : null,
          pvzCode: shipment.pvzCode,
          deliveryMode: shipment.deliveryMode,
          printUrl: shipment.printUrl,
          isMock: shipment.isMock,
          error: shipment.error,
        }
      : null,
    history: log.map((h) => ({
      id: h.id,
      statusCode: h.statusCode,
      statusName: h.statusName,
      cityName: h.cityName,
      receivedAt: h.receivedAt.toISOString(),
      isMock: h.isMock,
    })),
  };
}

/** Переводит код статуса в лейбл соответствующей машины (для ленты истории). */
function historyStatusLabel(kind: string, code: string | null): string {
  if (code === null) return '—';
  if (kind === 'payment') return paymentStatusLabel(code);
  if (kind === 'delivery') return deliveryStatusLabel(code);
  return orderStatusLabel(code);
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 py-1 text-sm">
      <dt className="text-gray-500">{label}</dt>
      <dd className="text-right text-gray-900">{value}</dd>
    </div>
  );
}

export default async function OrderDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const guard = await guardOrders('orders.read');
  if (!guard.ok) {
    if (guard.reason === 'module_disabled') {
      return <Forbidden permission="orders (модуль выключен)" />;
    }
    return <Forbidden permission={guard.permission} />;
  }

  const { id } = await params;
  const detail = await getOrderById(id);
  if (!detail) {
    return (
      <div role="alert" className="rounded-md border border-amber-200 bg-amber-50 p-6">
        <h1 className="text-xl font-semibold text-amber-800">Заказ не найден</h1>
        <p className="mt-2 text-sm text-amber-700">
          Возможно, он был удалён.{' '}
          <Link href="/admin/orders" className="text-blue-700 hover:underline">
            К списку заказов
          </Link>
        </p>
      </div>
    );
  }

  const { order, items } = detail;
  const history = await loadHistory(order.id);
  // UI-гейт панели действий (право orders.write); сервер всё равно проверяет
  // право внутри каждого Server Action — это лишь скрытие кнопок без права.
  const canWrite = can(guard.user, 'orders.write');

  // Блок СДЭК: виден только при включённом модуле cdek и праве cdek.manage
  // (сервер всё равно проверяет право внутри каждого Server Action).
  const showCdek = (await isModuleEffectivelyEnabled('cdek')) && can(guard.user, 'cdek.manage');
  const cdek = showCdek ? await loadCdek(order.id) : null;

  return (
    <div>
      <nav className="text-sm" aria-label="Хлебные крошки">
        <Link href="/admin/orders" className="text-blue-700 hover:underline">
          Заказы
        </Link>
        <span className="mx-1 text-gray-400">/</span>
        <span className="text-gray-600">{order.number}</span>
      </nav>

      <div className="mt-2 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold text-gray-900">Заказ {order.number}</h1>
        <OrderStatusBadge status={order.status} />
        <PaymentStatusBadge status={order.paymentStatus} />
        <DeliveryStatusBadge status={order.deliveryStatus} />
      </div>
      <p className="mt-1 text-sm text-gray-500">
        Создан {formatDateTime(order.createdAt)} · источник:{' '}
        {order.source === 'admin' ? 'админка' : 'витрина'}
      </p>

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* --- Левая колонка: позиции + суммы --- */}
        <div className="lg:col-span-2">
          <section className="rounded-lg border border-gray-200 bg-white">
            <h2 className="border-b border-gray-200 px-4 py-3 text-sm font-semibold text-gray-800">
              Позиции
            </h2>
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200 text-sm">
                <thead className="bg-gray-50 text-left text-gray-500">
                  <tr>
                    <th scope="col" className="px-4 py-2 font-medium">Товар</th>
                    <th scope="col" className="px-4 py-2 font-medium">Артикул</th>
                    <th scope="col" className="px-4 py-2 font-medium">Кол-во</th>
                    <th scope="col" className="px-4 py-2 font-medium">Цена</th>
                    <th scope="col" className="px-4 py-2 font-medium">Сумма</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {items.map((item) => {
                    const attrs = Object.entries(item.attributesSnapshot);
                    return (
                      <tr key={item.id}>
                        <td className="px-4 py-2">
                          <div className="font-medium text-gray-900">
                            {item.nameSnapshot}
                            {item.isGift ? (
                              <span className="ml-2 rounded bg-green-100 px-1.5 py-0.5 text-xs font-medium text-green-700">
                                Подарок
                              </span>
                            ) : null}
                          </div>
                          {attrs.length > 0 ? (
                            <div className="text-xs text-gray-400">
                              {attrs.map(([k, v]) => `${k}: ${String(v)}`).join(', ')}
                            </div>
                          ) : null}
                        </td>
                        <td className="px-4 py-2 text-gray-600">
                          <code className="text-xs">{item.skuSnapshot}</code>
                        </td>
                        <td className="px-4 py-2 text-gray-700">{item.quantity}</td>
                        <td className="px-4 py-2 text-gray-700">
                          {formatPrice(item.unitPrice, order.currency)}
                        </td>
                        <td className="px-4 py-2 font-medium text-gray-900">
                          {formatPrice(item.lineTotal, order.currency)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <dl className="border-t border-gray-200 px-4 py-3">
              <Row label="Товары" value={formatPrice(order.itemsTotal, order.currency)} />
              <Row
                label="Скидка"
                value={`− ${formatPrice(order.discountTotal, order.currency)}`}
              />
              <Row label="Доставка" value={formatPrice(order.deliveryTotal, order.currency)} />
              <div className="mt-1 border-t border-gray-200 pt-2">
                <div className="flex justify-between text-base font-semibold">
                  <span>Итого</span>
                  <span>{formatPrice(order.grandTotal, order.currency)}</span>
                </div>
              </div>
            </dl>
          </section>

          {/* --- История статусов --- */}
          <section className="mt-6 rounded-lg border border-gray-200 bg-white">
            <h2 className="border-b border-gray-200 px-4 py-3 text-sm font-semibold text-gray-800">
              История статусов
            </h2>
            <ul className="divide-y divide-gray-100">
              {history.length === 0 ? (
                <li className="px-4 py-3 text-sm text-gray-400">История пуста.</li>
              ) : (
                history.map((h) => (
                  <li key={h.id} className="px-4 py-2 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-600">
                        {historyKindLabel(h.kind)}
                      </span>
                      <span className="text-gray-700">
                        {historyStatusLabel(h.kind, h.fromStatus)} →{' '}
                        <strong>{historyStatusLabel(h.kind, h.toStatus)}</strong>
                      </span>
                      <span className="ml-auto text-xs text-gray-400">
                        {formatDateTime(h.createdAt)}
                      </span>
                    </div>
                    {h.comment ? (
                      <p className="mt-1 text-xs text-gray-500">{h.comment}</p>
                    ) : null}
                  </li>
                ))
              )}
            </ul>
          </section>
        </div>

        {/* --- Правая колонка: покупатель/доставка/оплата + действия --- */}
        <div className="space-y-6">
          <section className="rounded-lg border border-gray-200 bg-white p-4">
            <h2 className="text-sm font-semibold text-gray-800">Покупатель</h2>
            <dl className="mt-2">
              <Row label="Имя" value={order.customerName} />
              <Row label="Email" value={order.customerEmail} />
              <Row label="Телефон" value={order.customerPhone} />
              {order.comment ? <Row label="Комментарий" value={order.comment} /> : null}
            </dl>
          </section>

          <section className="rounded-lg border border-gray-200 bg-white p-4">
            <h2 className="text-sm font-semibold text-gray-800">Доставка</h2>
            <dl className="mt-2">
              <Row label="Тип" value={deliveryTypeLabel(order.deliveryType)} />
              <Row label="Статус" value={<DeliveryStatusBadge status={order.deliveryStatus} />} />
              {order.deliveryCity ? <Row label="Город" value={order.deliveryCity} /> : null}
              {order.deliveryAddress ? <Row label="Адрес" value={order.deliveryAddress} /> : null}
              {order.deliveryPvzCode ? <Row label="ПВЗ" value={order.deliveryPvzCode} /> : null}
              {order.deliveryCost ? (
                <Row label="Стоимость" value={formatPrice(order.deliveryCost, order.currency)} />
              ) : null}
              {order.cdekTrack ? <Row label="Трек" value={order.cdekTrack} /> : null}
            </dl>
          </section>

          <section className="rounded-lg border border-gray-200 bg-white p-4">
            <h2 className="text-sm font-semibold text-gray-800">Оплата</h2>
            <dl className="mt-2">
              <Row label="Способ" value={paymentMethodLabel(order.paymentMethod)} />
              <Row label="Статус" value={<PaymentStatusBadge status={order.paymentStatus} />} />
              {order.paidAt ? <Row label="Оплачен" value={formatDateTime(order.paidAt)} /> : null}
            </dl>
          </section>

          {order.promoCode ? (
            <section className="rounded-lg border border-gray-200 bg-white p-4">
              <h2 className="text-sm font-semibold text-gray-800">Промокод</h2>
              <dl className="mt-2">
                <Row label="Код" value={<code className="text-xs">{order.promoCode}</code>} />
                <Row
                  label="Скидка"
                  value={formatPrice(order.discountTotal, order.currency)}
                />
              </dl>
            </section>
          ) : null}

          {canWrite ? (
            <OrderActionsPanel
              orderId={order.id}
              status={order.status}
              paymentStatus={order.paymentStatus}
              deliveryStatus={order.deliveryStatus}
            />
          ) : null}

          {cdek ? (
            <CdekBlock
              orderId={order.id}
              shipment={cdek.shipment}
              history={cdek.history}
              deliveryType={order.deliveryType}
              paymentReady={isOrderPaidForShipment(order)}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}
