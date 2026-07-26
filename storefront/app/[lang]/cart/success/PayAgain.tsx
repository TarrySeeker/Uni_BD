'use client';

/**
 * Кнопка «Оплатить заказ» на странице успеха — выход из ТУПИКА ОТМЕНЁННОЙ ОПЛАТЫ.
 *
 * Покупатель нажал «Отмена» на шлюзе (или банк отказал, или закрылась вкладка):
 * заказ уже создан, корзина очищена, оформить его заново нечем. Эта кнопка
 * инициирует оплату УЖЕ СУЩЕСТВУЮЩЕГО заказа — нового заказа не создаётся.
 *
 * 🔴 ПЕРИМЕТР ДОСТУПА НЕ РАСШИРЯЕТСЯ: ровно та же пара «номер + HMAC-токен», по
 * которой страница читает заказ и показывает коды сертификатов. Никакого
 * email-пути (он допустим для чтения статуса, но для инициации платежа расширял
 * бы доступ до угадываемого значения). Всю проверку делает сервер:
 * verifyOrderAccess + гард оплачиваемости (paid/refunded/отменённый → 409).
 *
 * Идемпотентность: эндпоинт инициации платежа только выставляет счёт по заказу,
 * поэтому повторное нажатие даёт новую платёжную ссылку на ТОТ ЖЕ заказ, а не
 * второй заказ. От двойного клика защищает `busy`.
 *
 * Клиентский компонент: серверных импортов здесь быть не может (guard-тест).
 */

import { useState } from 'react';
import { ApiError, initPaykeeperPayment } from '@/lib/api';

/** Строки блока (plain-объект из словаря; функций в пропсах быть не должно). */
export interface PayAgainStrings {
  payAgain: string;
  payAgainBusy: string;
  payAgainError: string;
  payAgainNotPayable: string;
  payAgainInProgress: string;
}

export default function PayAgain({
  number,
  token,
  strings,
}: {
  number: string;
  token: string;
  strings: PayAgainStrings;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pay(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      // Возвращаемся на ЭТУ ЖЕ страницу заказа (локаль, номер и токен уже в URL).
      const returnUrl = `${window.location.origin}${window.location.pathname}?number=${encodeURIComponent(
        number,
      )}&token=${encodeURIComponent(token)}`;
      const payment = await initPaykeeperPayment({
        orderNumber: number,
        accessToken: token,
        returnUrl,
      });
      window.location.href = payment.paymentUrl;
    } catch (err) {
      // 🔴 Ни серверное сообщение, ни машинный код покупателю не показываем:
      // сообщение на языке магазина, код ему ничего не говорит. Диагностика — в лог.
      //
      // 🔴 ДВЕ РАЗНЫЕ ДОМЕННЫЕ ПРИЧИНЫ ОТКАЗА. Кнопка рисуется по статусу, который
      // страница прочитала РАНЬШЕ клика: пока покупатель смотрел на неё, вебхук
      // мог довести оплату до холда (`authorized`). Сервер такую инициацию
      // отклоняет (второй счёт = второе списание) и присылает
      // `payment_in_progress` — и покупателю надо сказать «деньги удержаны,
      // платить снова не нужно», а не «не удалось перейти к оплате»: второй текст
      // толкает на новую попытку с другой карты.
      const reason = err instanceof ApiError ? err.reason : undefined;
      if (reason) console.warn('[pay-again]', reason);
      const byReason: Record<string, string> = {
        order_not_payable: strings.payAgainNotPayable,
        payment_in_progress: strings.payAgainInProgress,
      };
      setError((reason && byReason[reason]) ?? strings.payAgainError);
      setBusy(false);
    }
  }

  // Стили держим ЛОКАЛЬНО (как соседний GiftCodes): общий public/storefront.css
  // принадлежит другим трекам, а классы кнопки/уведомления уже существуют.
  return (
    <div className="sf-success__pay" style={{ marginTop: 24 }}>
      {error ? (
        <div
          className="sf-checkout__notice sf-checkout__notice--error"
          role="alert"
          style={{ marginBottom: 12 }}
        >
          {error}
        </div>
      ) : null}
      <button
        type="button"
        className="sf-checkout__submit sf-success__pay-btn"
        onClick={() => void pay()}
        disabled={busy}
      >
        {busy ? strings.payAgainBusy : strings.payAgain}
      </button>
    </div>
  );
}
