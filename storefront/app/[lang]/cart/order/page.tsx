/**
 * Страница оформления заказа carre (/cart/order, /en/cart/order, …). Повторяет
 * боевой флоу carrerusse.com: заполнение контактов/доставки → серверный расчёт
 * (/cart/quote) → создание заказа (/orders) → инициация онлайн-оплаты у АКТИВНОГО
 * эквайера (/payments/init) → редирект на платёжную форму → страница успеха.
 *
 * Серверная обёртка: тянет публичные настройки (зоны доставки, валюта) и отдаёт
 * их клиентской форме. Сам чекаут — client-компонент. Anti-tamper: цену считает
 * ТОЛЬКО сервер. i18n: locale пробрасывается в форму (для /cart/quote и /orders —
 * локализованные подписи) и в заголовок страницы.
 */

import type { Metadata } from 'next';
import { getSettings } from '@/lib/api';
import { toLocale } from '@/lib/i18n';
import { getDictionary } from '@/lib/dictionaries';
import CheckoutForm from './CheckoutForm';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ lang: string }>;
}): Promise<Metadata> {
  const locale = toLocale((await params).lang);
  return {
    title: getDictionary(locale).checkout.title,
    robots: { index: false, follow: false },
  };
}

export const dynamic = 'force-dynamic';

export default async function OrderPage({
  params,
}: {
  params: Promise<{ lang: string }>;
}) {
  const locale = toLocale((await params).lang);
  const dict = getDictionary(locale);
  const settings = await getSettings(locale);

  const currencyCode = settings?.currency?.code ?? 'RUB';
  const currencySymbol = settings?.currency?.symbol ?? null;
  const zones = settings?.delivery?.zones ?? [];
  // 🔴 Аудит №20 — ДОСТУПНЫЕ способы доставки (возможности магазина из публичного
  // DTO). Форма не предлагает то, чего магазин выполнить не может: при выключенном
  // модуле СДЭК его радио не рендерятся вовсе. `undefined` (старый ответ API без
  // поля либо недоступные настройки) → прежнее поведение, без регресса.
  const deliveryMethods = settings?.delivery?.methods;
  // 🔴 Аудит №9 — формат чисел магазина («Формат чисел» + «Знаков после запятой»
  // из настроек). Отсутствие настроек → исторический показ, без регресса.
  const numberFormat = {
    locale: settings?.currency?.locale ?? null,
    fractionDigits: settings?.currency?.fractionDigits ?? null,
  };

  return (
    <>
      <div className="page-title">
        <h1>{dict.checkout.title}</h1>
      </div>
      <CheckoutForm
        currencyCode={currencyCode}
        currencySymbol={currencySymbol}
        zones={zones}
        deliveryMethods={deliveryMethods}
        locale={locale}
        numberFormat={numberFormat}
      />
    </>
  );
}
