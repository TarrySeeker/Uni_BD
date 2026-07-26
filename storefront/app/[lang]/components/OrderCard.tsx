/**
 * Карточка заказа: статусы, ДОСТАВКА (где посылка) и состав. Одна и та же на
 * странице подтверждения (/cart/success) и на постоянной странице заказа
 * (/order) — чтобы покупатель видел одно и то же в обоих местах.
 *
 * Находка аудита №5: данные о доставке (статус, трек, пункт выдачи/адрес) уже
 * приходили в публичном DTO, но не рендерились нигде — покупатель физически не
 * мог узнать, где его посылка (писем о смене статуса платформа не шлёт, ЛК на
 * витрине нет).
 *
 * 🔴 Статус доставки берётся ПО КОДУ из словаря витрины (deliveryStatusText):
 * серверный `deliveryStatusLabel` всегда русский, и его рендер закрепил бы
 * русские статусы для en/fr. Серверная подпись остаётся фолбэком для кодов,
 * которых витрина ещё не знает.
 *
 * Серверный компонент: ничего интерактивного, только разметка (мультитенантно —
 * ни одного зашитого под конкретный магазин слова, всё из словаря и DTO).
 */

import { formatPrice } from '@/lib/format';
import type { OrderDict } from '@/lib/order-view';
import {
  deliveryStatusText,
  deliveryMethodText,
  deliveryPlaceText,
} from '@/lib/order-view';
import type { OrderPublicDto } from '@/lib/types';

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="sf-summary-row">
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}

export default function OrderCard({
  order,
  t,
}: {
  order: OrderPublicDto;
  t: OrderDict;
}) {
  const place = deliveryPlaceText(order.delivery);
  const track = order.delivery.track?.trim() ?? '';

  return (
    <>
      <div className="sf-success__status">
        <Row label={t.statusOrder} value={order.statusLabel} />
        <Row label={t.statusPayment} value={order.paymentStatusLabel} />
        {/* 🔴 по коду, а не серверной русской подписью */}
        <Row label={t.statusDelivery} value={deliveryStatusText(order, t)} />
        <Row label={t.method} value={deliveryMethodText(order.delivery, t)} />
        {place ? <Row label={t.destination} value={place} /> : null}

        {track ? (
          <Row label={t.track} value={track} />
        ) : null}

        <div className="sf-summary-row sf-summary-row--total">
          <span>{t.statusTotal}</span>
          <span>{formatPrice(order.grandTotal, order.currency)}</span>
        </div>
      </div>

      <p className="sf-success__text sf-field__hint">
        {track ? t.trackHint : t.noTrackYet}
      </p>

      <div className="sf-summary-lines">
        {order.items.map((it, i) => (
          <div className="sf-summary-line" key={`${it.sku}-${i}`}>
            <div className="sf-summary-line__name">
              {it.name}
              <span className="sf-summary-line__qty"> × {it.qty}</span>
            </div>
            <div className="sf-summary-line__price">
              {formatPrice(it.lineTotal, order.currency)}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
