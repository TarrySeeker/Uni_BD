import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

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
} from '@/lib/admin/order-format';
import { getShopTimeZone } from '@/lib/admin/timezone';
import {
  orderStatusLabelKey,
  paymentStatusLabelKey,
  deliveryStatusLabelKey,
} from '@/lib/orders/labels';
import { getOrderById } from '@/lib/orders/repository';
import { toMinor } from '@/lib/orders/money';
import { isRussianPhone } from '@/lib/orders/phone';
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
  certificateItemHint,
  getGiftCertificateById,
  giftFaceValueFromItem,
  listGiftCertificatesIssuedForOrder,
  manualIssueGateReason,
} from '@/lib/gift-certificates';
import { getSetting } from '@/lib/settings/repository';
import { resolveGiftSettings } from '@/lib/settings/schemas';
// Из конкретного модуля, а не из бочки: index.ts принадлежит другому треку.
import { giftRefundWarnings } from '@/lib/gift-certificates/warnings';

import {
  CdekBlock,
  type CdekShipmentView,
  type CdekStatusLogView,
} from './_components/CdekBlock';
import {
  GiftIssueBlock,
  type GiftIssueItemView,
  type IssuedCertificateView,
} from './_components/GiftIssueBlock';
import { OrderContactForm } from './_components/OrderContactForm';

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

/**
 * Переводит код статуса в подпись соответствующей машины (для ленты истории).
 *
 * 🔴 Переводчик передаётся ПАРАМЕТРОМ (аудит major №28): функция модульного
 * уровня, `t` компонента ей недоступен, а без него лента истории оставалась
 * жёстко русской при интерфейсе оператора на en/fr. Незнакомый код → сам код.
 */
function historyStatusLabel(
  kind: string,
  code: string | null,
  t: (key: string) => string,
): string {
  if (code === null) return '—';
  const key =
    kind === 'payment'
      ? paymentStatusLabelKey(code)
      : kind === 'delivery'
        ? deliveryStatusLabelKey(code)
        : orderStatusLabelKey(code);
  return key ? t(key) : code;
}

/**
 * Денежная строка домена (рубли NUMERIC(14,2)) → целые копейки; мусор/пусто → 0.
 * Нужен только для «сумма > 0?» в вёрстке: toMinor бросает на грязном значении,
 * а карточка заказа не должна падать из-за подписи в блоке итогов.
 */
function moneyMinorOrZero(value: string | null | undefined): number {
  if (!value) return 0;
  try {
    return toMinor(value);
  } catch {
    return 0;
  }
}

/**
 * Курс из снимка заказа (`orders.display_rate`, NUMERIC(18,8)) → читаемое число.
 *
 * В БД он хранится с восемью знаками ради точности («88.76020000»), но менеджеру
 * нужен курс, а не хвост нулей: печатаем до 4 знаков (как публикует ЦБ), лишние
 * нули убираем. Мусор/нечитаемое значение → null: справочная подпись просто
 * исчезнет, карточка заказа из-за неё падать не должна.
 */
function formatDisplayRate(raw: string): string | null {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return String(Number(n.toFixed(4)));
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
  const t = await getTranslations();
  const guard = await guardOrders('orders.read');
  if (!guard.ok) {
    if (guard.reason === 'module_disabled') {
      return <Forbidden permission={t('orders.detailPage.moduleDisabled')} />;
    }
    return <Forbidden permission={guard.permission} />;
  }

  const { id } = await params;
  const detail = await getOrderById(id);
  if (!detail) {
    return (
      <div role="alert" className="rounded-md border border-amber-200 bg-amber-50 p-6">
        <h1 className="text-xl font-semibold text-amber-800">{t('orders.detailPage.notFoundTitle')}</h1>
        <p className="mt-2 text-sm text-amber-700">
          {t('orders.detailPage.notFoundText')}{' '}
          <Link href="/admin/orders" className="text-blue-700 hover:underline">
            {t('orders.detailPage.backToList')}
          </Link>
        </p>
      </div>
    );
  }

  const { order, items } = detail;
  // Пояс магазина — один на всю админку (аудит major №26): карточка обязана
  // показывать то же время, что список заказов и журнал аудита.
  const timeZone = await getShopTimeZone();
  const history = await loadHistory(order.id);
  // UI-гейт панели действий (право orders.write); сервер всё равно проверяет
  // право внутри каждого Server Action — это лишь скрытие кнопок без права.
  const canWrite = can(guard.user, 'orders.write');

  // Нужен ли этому заказу телефон, пригодный для накладной СДЭК (курьер/ПВЗ).
  // Для самовывоза номер не участвует в логистике — не тревожим оператора зря.
  const needsCdekPhone = order.deliveryType === 'courier' || order.deliveryType === 'pvz';

  // Блок СДЭК: виден только при включённом модуле cdek и праве cdek.manage
  // (сервер всё равно проверяет право внутри каждого Server Action).
  const showCdek = (await isModuleEffectivelyEnabled('cdek')) && can(guard.user, 'cdek.manage');
  const cdek = showCdek ? await loadCdek(order.id) : null;

  // Блок подарочных сертификатов (ТЗ п.7): выпущенные по заказу коды + выпуск по
  // позиции. Виден при праве gift.read; кнопка требует gift.write (сервер тоже
  // проверяет). Номинал считаем ЗДЕСЬ из снимка позиции, чтобы админ видел ровно
  // ту сумму, которую запишет сервер.
  const showGift = can(guard.user, 'gift.read');

  /**
   * Находка аудита №22. Раньше выпущенные коды читались ТОЛЬКО при gift.read, и
   * у роли «Менеджер» (её в системных ролях нет — см. lib/auth/permissions)
   * предупреждение giftRefundNotice выходило пустым: менеджер жал «Возврат»,
   * молча гасил выпущенные коды на предъявителя и не видел ни слова об этом.
   * При этом панель возврата ему доступна — она за orders.write.
   *
   * РЕШЕНИЕ: право gift.read менеджеру НЕ выдаём (код сертификата —
   * предъявительский секрет, роль операционная), а читаем сертификаты для
   * ПРЕДУПРЕЖДЕНИЯ всем, кто способен нажать возврат. Разграничение проходит по
   * раскрытию кода: «сколько кодов погаснет и сколько потрачено» — не секрет,
   * «какой именно код» — секрет (revealCode: showGift → иначе маска •••1234).
   */
  const needsGiftData = showGift || canWrite;
  const issuedCerts = needsGiftData ? await listGiftCertificatesIssuedForOrder(order.id) : [];
  const giftItems: GiftIssueItemView[] = showGift
    ? items.map((it) => ({
        id: it.id,
        name: it.nameSnapshot,
        faceValue: giftFaceValueFromItem(it),
        quantity: it.quantity,
        hint: certificateItemHint(it),
      }))
    : [];
  const issuedView: IssuedCertificateView[] = issuedCerts.map((c) => ({
    id: c.id,
    code: c.code,
    initialAmount: c.initialAmount,
    orderItemId: c.issuedOrderItemId,
    recipient: c.recipient.name ?? c.recipient.email ?? '—',
    spentLabel: formatPrice(c.spentTotal, c.currency),
    status: c.status,
  }));
  // ТЗ п.11: оператор должен узнать о судьбе выпущенных кодов ДО возврата
  // (погашение не вернёт уже потраченное). Код целиком — только при gift.read.
  const giftWarningInput = issuedCerts.map((c) => ({
    code: c.code,
    spentTotal: c.spentTotal,
    currency: c.currency,
    status: c.status,
  }));
  const giftRefundNotice = giftRefundWarnings(giftWarningInput, {
    kind: 'preventive',
    revealCode: showGift,
  });
  const giftRevokedNotice = giftRefundWarnings(giftWarningInput, {
    kind: 'revoked',
    revealCode: showGift,
  });

  /**
   * Калитка ручного выпуска (находка аудита №27) — считаем ТЕМ ЖЕ правилом,
   * которое применит Server Action, чтобы форма не предлагала кнопку, ведущую
   * в гарантированный отказ, и наоборот — честно показывала путь «в обход
   * с основанием», когда оплата прошла мимо эквайринга.
   */
  const giftGate = showGift
    ? manualIssueGateReason(order, resolveGiftSettings((await getSetting('gift'))?.value))
    : null;

  // Аудит-находка #8: списание подарочного сертификата В ОПЛАТУ этого заказа.
  // Это НЕ то же, что GiftIssueBlock (там коды, ВЫПУЩЕННЫЕ по заказу). Без этой
  // строки итоги в карточке не сходятся: grand_total записан УЖЕ за вычетом
  // сертификата (repository.createOrder → finalGrandTotal), а менеджер видел
  // только товары/скидку/доставку.
  //
  // Деньги: order.giftDiscountTotal — рубли-строка NUMERIC(14,2) (копейки живут
  // только в платёжном слое). Сравнение через toMinor — целочисленно, без float.
  const giftDiscountMinor = moneyMinorOrZero(order.giftDiscountTotal);
  const giftApplied = giftDiscountMinor > 0;
  // Код сертификата тянем ТОЛЬКО когда он реально привязан к заказу — иначе
  // лишний запрос на каждой карточке. Право gift.read обязательно: код — секрет
  // на предъявителя, у менеджера без доступа к сертификатам его быть не должно.
  const appliedGiftCert =
    giftApplied && order.giftCertificateId && showGift
      ? await getGiftCertificateById(order.giftCertificateId)
      : null;

  // 🔴 СНИМОК ВАЛЮТЫ ОТОБРАЖЕНИЯ (0059) — «что видел покупатель на витрине».
  // Показываем ТОЛЬКО когда снимок есть целиком (валюта + сумма): половинчатая
  // строка «видел 540,78» без валюты дезинформирует сильнее, чем её отсутствие.
  // Курс — опционален (может не сохраниться у старых/ручных данных).
  // ЕДИНИЦЫ: displayTotal — ДЕНЬГИ в валюте показа (евро), не копейки, поэтому
  // formatPrice применяется к нему напрямую, как к остальным суммам заказа.
  const displaySnapshot =
    order.displayCurrency && order.displayTotal
      ? {
          total: formatPrice(order.displayTotal, order.displayCurrency),
          rate: order.displayRate ? formatDisplayRate(order.displayRate) : null,
        }
      : null;

  return (
    <div>
      <nav className="text-sm" aria-label={t('layout.breadcrumbs.ariaLabel')}>
        <Link href="/admin/orders" className="text-blue-700 hover:underline">
          {t('nav.orders')}
        </Link>
        <span className="mx-1 text-gray-400">/</span>
        <span className="text-gray-600">{order.number}</span>
      </nav>

      <div className="mt-2 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold text-gray-900">
          {t('orders.detailPage.title', { number: order.number })}
        </h1>
        <OrderStatusBadge status={order.status} />
        <PaymentStatusBadge status={order.paymentStatus} />
        <DeliveryStatusBadge status={order.deliveryStatus} />
      </div>
      <p className="mt-1 text-sm text-gray-500">
        {t('orders.detailPage.createdLine', {
          date: formatDateTime(order.createdAt, timeZone),
          source:
            order.source === 'admin'
              ? t('orders.detailPage.sourceAdmin')
              : t('orders.detailPage.sourceStorefront'),
        })}
      </p>

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* --- Левая колонка: позиции + суммы --- */}
        <div className="lg:col-span-2">
          <section className="rounded-lg border border-gray-200 bg-white">
            <h2 className="border-b border-gray-200 px-4 py-3 text-sm font-semibold text-gray-800">
              {t('orders.detailPage.itemsHeading')}
            </h2>
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200 text-sm">
                <thead className="bg-gray-50 text-left text-gray-500">
                  <tr>
                    <th scope="col" className="px-4 py-2 font-medium">{t('orders.detailPage.columns.product')}</th>
                    <th scope="col" className="px-4 py-2 font-medium">{t('orders.detailPage.columns.sku')}</th>
                    <th scope="col" className="px-4 py-2 font-medium">{t('orders.detailPage.columns.quantity')}</th>
                    <th scope="col" className="px-4 py-2 font-medium">{t('orders.detailPage.columns.price')}</th>
                    <th scope="col" className="px-4 py-2 font-medium">{t('orders.detailPage.columns.total')}</th>
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
                                {t('orders.detailPage.giftBadge')}
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
              <Row label={t('orders.detailPage.summary.items')} value={formatPrice(order.itemsTotal, order.currency)} />
              <Row
                label={t('orders.detailPage.labelDiscount')}
                value={`− ${formatPrice(order.discountTotal, order.currency)}`}
              />
              <Row label={t('orders.detailPage.deliveryHeading')} value={formatPrice(order.deliveryTotal, order.currency)} />
              {giftApplied ? (
                <>
                  <Row
                    label={t('orders.detailPage.summary.giftDiscount')}
                    value={`− ${formatPrice(order.giftDiscountTotal, order.currency)}`}
                  />
                  {appliedGiftCert ? (
                    <Row
                      label={t('orders.detailPage.summary.giftCode')}
                      value={<code className="text-xs">{appliedGiftCert.code}</code>}
                    />
                  ) : null}
                </>
              ) : null}
              <div className="mt-1 border-t border-gray-200 pt-2">
                <div className="flex justify-between text-base font-semibold">
                  <span>{t('orders.detailPage.summary.grandTotal')}</span>
                  <span>{formatPrice(order.grandTotal, order.currency)}</span>
                </div>
              </div>
              {/* 🔴 СНИМОК ВАЛЮТЫ ОТОБРАЖЕНИЯ (0059): «клиент видел 540,78 € по
                  курсу 88,7602». Списаны деньги в валюте заказа выше — это
                  СПРАВОЧНАЯ строка для разбора претензии «мне показывали другую
                  сумму»: курс ЦБ меняется ежедневно и восстановить экран
                  покупателя больше нечем. Заказы в базовой валюте и заказы
                  старше миграции полей не имеют → блок не рендерится вовсе. */}
              {displaySnapshot ? (
                <div className="mt-2 border-t border-gray-200 pt-2">
                  <Row
                    label={t('orders.detailPage.summary.displaySeen')}
                    value={
                      <span className="text-gray-600">
                        {displaySnapshot.total}
                        {displaySnapshot.rate ? (
                          <span className="ml-1 text-xs text-gray-400">
                            {t('orders.detailPage.summary.displayRate', {
                              rate: displaySnapshot.rate,
                            })}
                          </span>
                        ) : null}
                      </span>
                    }
                  />
                </div>
              ) : null}
            </dl>
          </section>

          {showGift ? (
            <GiftIssueBlock
              orderId={order.id}
              items={giftItems}
              issued={issuedView}
              canWrite={can(guard.user, 'gift.write')}
              warnings={giftRevokedNotice}
              orderEligible={giftGate === null}
            />
          ) : null}

          {/* --- История статусов --- */}
          <section className="mt-6 rounded-lg border border-gray-200 bg-white">
            <h2 className="border-b border-gray-200 px-4 py-3 text-sm font-semibold text-gray-800">
              {t('orders.detailPage.historyHeading')}
            </h2>
            <ul className="divide-y divide-gray-100">
              {history.length === 0 ? (
                <li className="px-4 py-3 text-sm text-gray-400">{t('orders.detailPage.historyEmpty')}</li>
              ) : (
                history.map((h) => (
                  <li key={h.id} className="px-4 py-2 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-600">
                        {historyKindLabel(h.kind)}
                      </span>
                      <span className="text-gray-700">
                        {historyStatusLabel(h.kind, h.fromStatus, t)} →{' '}
                        <strong>{historyStatusLabel(h.kind, h.toStatus, t)}</strong>
                      </span>
                      <span className="ml-auto text-xs text-gray-400">
                        {formatDateTime(h.createdAt, timeZone)}
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
            <h2 className="text-sm font-semibold text-gray-800">{t('orders.detailPage.customerHeading')}</h2>
            <dl className="mt-2">
              <Row label={t('fields.name')} value={order.customerName} />
              <Row label={t('orders.detailPage.customer.email')} value={order.customerEmail} />
              <Row label={t('orders.detailPage.customer.phone')} value={order.customerPhone} />
              {order.comment ? <Row label={t('orders.detailPage.customer.comment')} value={order.comment} /> : null}
            </dl>
            {/*
              Предупреждение ДО отгрузки (аудит-находка #8): накладную СДЭК
              создаёт только российский номер (+7XXXXXXXXXX). Раньше об этом
              сообщал сбой «Создать отправление» — уже после оплаты и без
              возможности что-либо исправить. Это предупреждение, а не запрет:
              магазин трёхъязычный, для самовывоза/зоны иностранный номер валиден.
            */}
            {needsCdekPhone && !isRussianPhone(order.customerPhone) ? (
              <p role="status" className="mt-2 rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
                {t('orders.detailPage.customer.phoneNotCdek')}
              </p>
            ) : null}
            {canWrite ? (
              <OrderContactForm
                orderId={order.id}
                customerName={order.customerName}
                customerEmail={order.customerEmail}
                customerPhone={order.customerPhone}
                deliveryCity={order.deliveryCity}
                deliveryAddress={order.deliveryAddress}
                requiresAddress={order.deliveryType === 'courier'}
                hasCdekShipment={Boolean(order.cdekUuid)}
              />
            ) : null}
          </section>

          <section className="rounded-lg border border-gray-200 bg-white p-4">
            <h2 className="text-sm font-semibold text-gray-800">{t('orders.detailPage.deliveryHeading')}</h2>
            <dl className="mt-2">
              <Row
                label={t('orders.detailPage.delivery.type')}
                value={
                  order.isPostamat
                    ? t('orders.detailPage.delivery.postamatSuffix', {
                        type: deliveryTypeLabel(order.deliveryType),
                      })
                    : deliveryTypeLabel(order.deliveryType)
                }
              />
              <Row label={t('orders.detailPage.labelStatus')} value={<DeliveryStatusBadge status={order.deliveryStatus} />} />
              {order.deliveryZoneLabel || order.deliveryZoneId ? (
                <Row label={t('orders.detailPage.delivery.zone')} value={order.deliveryZoneLabel ?? order.deliveryZoneId ?? ''} />
              ) : null}
              {order.deliveryCity ? <Row label={t('orders.detailPage.delivery.city')} value={order.deliveryCity} /> : null}
              {order.deliveryAddress ? <Row label={t('orders.detailPage.delivery.address')} value={order.deliveryAddress} /> : null}
              {order.deliveryPvzCode ? <Row label={t('orders.detailPage.delivery.pvz')} value={order.deliveryPvzCode} /> : null}
              {order.deliveryCost ? (
                <Row label={t('orders.detailPage.delivery.cost')} value={formatPrice(order.deliveryCost, order.currency)} />
              ) : null}
              {order.cdekTrack ? <Row label={t('orders.detailPage.delivery.track')} value={order.cdekTrack} /> : null}
            </dl>
          </section>

          <section className="rounded-lg border border-gray-200 bg-white p-4">
            <h2 className="text-sm font-semibold text-gray-800">{t('orders.detailPage.paymentHeading')}</h2>
            <dl className="mt-2">
              <Row label={t('orders.detailPage.payment.method')} value={paymentMethodLabel(order.paymentMethod)} />
              <Row label={t('orders.detailPage.labelStatus')} value={<PaymentStatusBadge status={order.paymentStatus} />} />
              {order.paidAt ? <Row label={t('orders.detailPage.payment.paidAt')} value={formatDateTime(order.paidAt, timeZone)} /> : null}
            </dl>
          </section>

          {order.promoCode ? (
            <section className="rounded-lg border border-gray-200 bg-white p-4">
              <h2 className="text-sm font-semibold text-gray-800">{t('orders.detailPage.promoHeading')}</h2>
              <dl className="mt-2">
                <Row label={t('orders.detailPage.promo.code')} value={<code className="text-xs">{order.promoCode}</code>} />
                <Row
                  label={t('orders.detailPage.labelDiscount')}
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
              /*
                Находка №22: без gift.read блок сертификатов не рисуется, поэтому
                постфактумное «код погашен» показываем здесь — иначе оператор,
                сделавший возврат, так и не узнал бы о судьбе кодов. Коды в этих
                строках замаскированы (revealCode: showGift).
              */
              giftWarnings={showGift ? giftRefundNotice : [...giftRefundNotice, ...giftRevokedNotice]}
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
