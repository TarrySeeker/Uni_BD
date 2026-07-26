/**
 * Постоянная страница заказа: /order?number=…&token=… (находка аудита №5).
 *
 * ЗАЧЕМ. Единственным местом, где покупатель хоть что-то видел о заказе, была
 * страница подтверждения сразу после оплаты. Вернуться к заказу позже было
 * НЕКУДА: личного кабинета на витрине нет, писем о смене статуса платформа не
 * шлёт. Теперь ссылка на эту страницу выдаётся на /cart/success и работает
 * сколько угодно долго (токен детерминированный, в БД не хранится).
 *
 * 🔴 ПЕРИМЕТР — номер + токен, тот же, что у кодов подарочного сертификата:
 * номера заказов последовательны, поэтому без токена страница НИЧЕГО не
 * запрашивает и ничего не показывает (перебор невозможен), а сам GET
 * /orders/:number отвечает 404 и на несуществующий заказ, и на неверный токен.
 * Поэтому же страница закрыта от индексации: в URL лежит токен доступа.
 */

import type { Metadata } from 'next';
import { getOrder } from '@/lib/api';
import { localizedHref, toLocale } from '@/lib/i18n';
import { getDictionary, fillTemplate } from '@/lib/dictionaries';
import { readOrderLink } from '@/lib/order-view';
import { SUCCESS_TEXT_KEY, resolvePaymentResult } from '@/lib/payment-result';
import OrderCard from '../components/OrderCard';
import PayAgain from '../cart/success/PayAgain';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ lang: string }>;
}): Promise<Metadata> {
  const locale = toLocale((await params).lang);
  return {
    title: getDictionary(locale).order.metaTitle,
    // В query-строке — токен доступа к заказу: ни поисковикам, ни архивам.
    robots: { index: false, follow: false },
  };
}

export const dynamic = 'force-dynamic';

export default async function OrderPage({
  params,
  searchParams,
}: {
  params: Promise<{ lang: string }>;
  searchParams: Promise<{ number?: string; token?: string }>;
}) {
  const [{ lang }, query] = await Promise.all([params, searchParams]);
  const locale = toLocale(lang);
  const dict = getDictionary(locale);
  const t = dict.order;

  const link = readOrderLink(query);
  const order = link ? await getOrder(link.number, link.token, locale) : null;

  // Исход оплаты (находка №1): постоянная ссылка на заказ — это и есть та самая
  // «страница оплатить заказ по номеру», которой не существовало. Подсказки шлюза
  // здесь нет (сюда приходят не с редиректа), решает СТАТУС заказа.
  const result = order
    ? resolvePaymentResult({
        paymentStatus: order.paymentStatus,
        status: order.status,
        grandTotal: order.grandTotal,
        hint: null,
        // Та же защита от двойной оплаты, что и на странице успеха: сюда можно
        // прийти по постоянной ссылке через минуту после ухода на шлюз.
        paymentInitiatedAt: order.paymentInitiatedAt,
      })
    : null;

  return (
    <>
      <div className="page-title">
        <h1>{t.title}</h1>
      </div>

      <div className="sf-success">
        {!link ? (
          <p className="sf-success__text">{t.needLink}</p>
        ) : !order ? (
          <p className="sf-success__text">{t.notFound}</p>
        ) : (
          <>
            <p className="sf-success__text">
              {order.number} · {t.placedAt}{' '}
              {new Date(order.createdAt).toLocaleDateString(locale)}
            </p>
            {/*
              Состояние оплаты словами — ВСЕГДА, а не только когда есть кнопка:
              иначе покупатель, попавший сюда в момент «подтверждение в пути»,
              видит карточку заказа и ни слова о деньгах.
            */}
            {result ? (
              <p className="sf-success__text">
                {fillTemplate(dict.success[SUCCESS_TEXT_KEY[result.outcome]], {
                  number: order.number,
                })}
              </p>
            ) : null}
            {result?.outcome === 'settling' ? (
              <p className="sf-success__text sf-field__hint">{dict.success.settlingHint}</p>
            ) : null}

            {/* Заказ жив и не оплачен — доплатить можно прямо отсюда, без звонка. */}
            {result && result.canRetry && link ? (
              <PayAgain
                number={order.number}
                token={link.token}
                strings={{
                  payAgain: dict.success.payAgain,
                  payAgainBusy: dict.success.payAgainBusy,
                  payAgainError: dict.success.payAgainError,
                  payAgainNotPayable: dict.success.payAgainNotPayable,
                  payAgainInProgress: dict.success.payAgainInProgress,
                }}
              />
            ) : null}

            <OrderCard order={order} t={t} />
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
