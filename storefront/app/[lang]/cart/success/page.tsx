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
 *
 * 🔴 ИСХОД ОПЛАТЫ (аудит 2026-07-26, находка №1 — тупик отменённой оплаты).
 * Корзина очищается ДО ухода на шлюз, поэтому «оформить заново» покупателю
 * нечего. Раньше страница печатала «Спасибо! Ваш заказ принят» одинаково и для
 * оплаченного заказа, и для нажатой на шлюзе «Отмены», и для отказа банка, и не
 * давала ни одного способа доплатить. Теперь исход считает чистый модуль
 * lib/payment-result (статус заказа + параметр возврата шлюза), заголовок и
 * текст берутся ПО ИСХОДУ, а неоплаченный живой заказ получает кнопку оплаты по
 * тому же периметру доступа (номер + HMAC-токен).
 */

import type { Metadata } from 'next';
import { getOrder } from '@/lib/api';
import { localizedHref, toLocale } from '@/lib/i18n';
import { getDictionary, fillTemplate } from '@/lib/dictionaries';
import {
  SUCCESS_TEXT_KEY,
  SUCCESS_TITLE_KEY,
  readGatewayHint,
  resolvePaymentResult,
} from '@/lib/payment-result';
import { orderTrackingPath } from '@/lib/order-view';
import OrderCard from '../../components/OrderCard';
import GiftCodes from './GiftCodes';
import PayAgain from './PayAgain';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ lang: string }>;
}): Promise<Metadata> {
  const locale = toLocale((await params).lang);
  return {
    title: getDictionary(locale).success.metaTitle,
    robots: { index: false, follow: false },
  };
}

export const dynamic = 'force-dynamic';

export default async function SuccessPage({
  params,
  searchParams,
}: {
  params: Promise<{ lang: string }>;
  searchParams: Promise<{
    number?: string;
    token?: string;
    /** Возврат шлюза: cancelled | failed (demo-страница оплаты app/mock). */
    payment?: string;
    /** Возврат шлюза: '1' — оплата подтверждена demo-шлюзом. */
    paid?: string;
  }>;
}) {
  const [{ lang }, { number, token, payment, paid }] = await Promise.all([params, searchParams]);
  const locale = toLocale(lang);
  const dict = getDictionary(locale);

  const order = number && token ? await getOrder(number, token, locale) : null;

  // Исход считается по СТАТУСУ ЗАКАЗА (источник истины), подсказка шлюза лишь
  // уточняет ещё не подтверждённое состояние. Без прочитанного заказа исхода нет.
  const hint = readGatewayHint({ payment, paid });
  // 🔴 Гонка «оплатил → вернулся раньше вебхука»: боевой шлюз подсказок не шлёт
  // (?paid=1 ставит только mock), поэтому решает СЕРВЕРНЫЙ ФАКТ — когда по заказу
  // выставили счёт (paymentInitiatedAt). Пока платёж свежий, кнопки оплаты нет.
  const result = order
    ? resolvePaymentResult({
        paymentStatus: order.paymentStatus,
        status: order.status,
        grandTotal: order.grandTotal,
        hint,
        paymentInitiatedAt: order.paymentInitiatedAt,
      })
    : null;

  // Ссылка «проверить статус ещё раз» — тот же заказ БЕЗ подсказки шлюза: иначе
  // застрявшее «подтверждается» невозможно было бы пересмотреть перезагрузкой.
  const refreshHref =
    number && token
      ? `${localizedHref('/cart/success', locale)}?number=${encodeURIComponent(
          number,
        )}&token=${encodeURIComponent(token)}`
      : null;

  // Постоянная ссылка на заказ (находка №5): по ней покупатель вернётся к статусу
  // доставки и треку когда угодно — периметр тот же, номер + токен.
  const orderHref = number && token ? orderTrackingPath(number, token, locale) : null;

  return (
    <>
      <div className="page-title">
        <h1>{result ? dict.success[SUCCESS_TITLE_KEY[result.outcome]] : dict.success.title}</h1>
      </div>

      <div className="sf-success">
        {!number ? (
          <p className="sf-success__text">{dict.success.noOrder}</p>
        ) : !order || !result ? (
          <>
            <p className="sf-success__text">
              {fillTemplate(dict.success.thanks, { number })}
            </p>
            <p className="sf-success__text sf-field__hint">
              {dict.success.emailNote}
            </p>
          </>
        ) : (
          <>
            <p className="sf-success__text">
              {fillTemplate(dict.success[SUCCESS_TEXT_KEY[result.outcome]], {
                number: order.number,
              })}
            </p>

            {/* Выход из тупика: заказ жив и не оплачен — платим по нему прямо тут. */}
            {result.canRetry && token ? (
              <PayAgain
                number={order.number}
                token={token}
                strings={{
                  payAgain: dict.success.payAgain,
                  payAgainBusy: dict.success.payAgainBusy,
                  payAgainError: dict.success.payAgainError,
                  payAgainNotPayable: dict.success.payAgainNotPayable,
                  payAgainInProgress: dict.success.payAgainInProgress,
                }}
              />
            ) : null}

            {/*
              Подтверждение в пути: кнопки оплаты нет (иначе двойное списание),
              но покупатель не заперт — есть перепроверка статуса, а если платёж
              так и не подтвердится, окно ожидания истечёт и кнопка вернётся
              сама. Об этом говорим прямо (settlingHint), иначе ожидание выглядит
              новым тупиком.
            */}
            {result.outcome === 'settling' ? (
              <>
                {refreshHref ? (
                  <p className="sf-success__text">
                    <a href={refreshHref} className="sf-checkout__link">
                      {dict.success.refreshStatus}
                    </a>
                  </p>
                ) : null}
                <p className="sf-success__text sf-field__hint">{dict.success.settlingHint}</p>
              </>
            ) : null}

            {/*
              Статусы + ДОСТАВКА (находка №5): статус доставки, трек-номер, способ
              и пункт выдачи/адрес. Общая карточка с постоянной страницей заказа —
              покупатель видит одно и то же в обоих местах.
            */}
            <OrderCard order={order} t={dict.order} />

            {/*
              🔴 Ссылка «вернуться к заказу» (находка №5). Писем о смене статуса
              платформа не шлёт, ЛК на витрине нет — эта ссылка единственный способ
              узнать позже, где посылка. Показываем её там, где покупатель точно
              смотрит: сразу под составом заказа.
            */}
            {orderHref ? (
              <div className="sf-success__status">
                <div className="sf-summary-row">
                  <span>{dict.order.linkTitle}</span>
                  <span>
                    <a href={orderHref} className="sf-checkout__link">
                      {dict.order.linkOpen}
                    </a>
                  </span>
                </div>
                <p className="sf-success__text sf-field__hint">{dict.order.linkHint}</p>
              </div>
            ) : null}
          </>
        )}

        {/*
          Код подарочного сертификата (ТЗ п.11) — ТОЛЬКО клиентский блок по токену
          заказа: в общем DTO заказа кода нет и быть не должно (деньги на
          предъявителя). Сам блок решает, показываться ли ему вообще.
        */}
        {number && token ? (
          <GiftCodes
            number={number}
            token={token}
            strings={dict.success}
            locale={locale}
          />
        ) : null}

        <p className="sf-success__actions">
          <a href={localizedHref('/catalog', locale)} className="sf-checkout__link">
            {dict.common.continueShopping}
          </a>
        </p>
      </div>
    </>
  );
}
