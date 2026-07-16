/**
 * Страница подтверждения заказа carre (/cart/success). Покупатель попадает сюда
 * после возврата с платёжной страницы PayKeeper (returnUrl в mock-режиме; боевой
 * PayKeeper возвращает по настройкам ЛК — тогда координатор проставит этот URL).
 *
 * Читает ?number= и ?token= (accessToken из ответа /orders) и показывает статус
 * заказа через GET /orders/:number?token=… (anti-enumeration: без токена — 404).
 * Оплата подтверждается асинхронным callback PayKeeper (подпись md5) → заказ
 * становится paid; поэтому paymentStatus здесь может быть ещё «ожидает оплаты»,
 * что нормально сразу после редиректа.
 */

import type { Metadata } from 'next';
import { getOrder } from '@/lib/api';
import { formatPrice } from '@/lib/format';
import { localizedHref, toLocale } from '@/lib/i18n';
import { getDictionary } from '@/lib/dictionaries';

export const metadata: Metadata = {
  title: 'Заказ оформлен — carre',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

export default async function SuccessPage({
  params,
  searchParams,
}: {
  params: Promise<{ lang: string }>;
  searchParams: Promise<{ number?: string; token?: string }>;
}) {
  const [{ lang }, { number, token }] = await Promise.all([params, searchParams]);
  const locale = toLocale(lang);
  const dict = getDictionary(locale);

  const order = number && token ? await getOrder(number, token, locale) : null;

  return (
    <>
      <div className="page-title">
        <h1>{dict.success.title}</h1>
      </div>

      <div className="sf-success">
        {!number ? (
          <p className="sf-success__text">Не удалось определить заказ.</p>
        ) : !order ? (
          <>
            <p className="sf-success__text">
              Спасибо! Ваш заказ <strong>№{number}</strong> принят.
            </p>
            <p className="sf-success__text sf-field__hint">
              Мы отправили детали на вашу почту. Если оплата ещё обрабатывается,
              статус обновится автоматически.
            </p>
          </>
        ) : (
          <>
            <p className="sf-success__text">
              Спасибо! Ваш заказ <strong>№{order.number}</strong> принят.
            </p>

            <div className="sf-success__status">
              <div className="sf-summary-row">
                <span>Статус заказа</span>
                <span>{order.statusLabel}</span>
              </div>
              <div className="sf-summary-row">
                <span>Оплата</span>
                <span>{order.paymentStatusLabel}</span>
              </div>
              <div className="sf-summary-row sf-summary-row--total">
                <span>Сумма</span>
                <span>{formatPrice(order.grandTotal, order.currency)}</span>
              </div>
            </div>

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
        )}

        <p className="sf-success__actions">
          <a href={localizedHref('/catalog', locale)} className="sf-checkout__link">
            {dict.common.continueShopping}
          </a>
        </p>
      </div>
    </>
  );
}
