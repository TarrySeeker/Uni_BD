/**
 * Страница оформления заказа carre (/cart/order, /en/cart/order, …). Повторяет
 * боевой флоу carrerusse.com: заполнение контактов/доставки → серверный расчёт
 * (/cart/quote) → создание заказа (/orders) → инициация онлайн-оплаты PayKeeper
 * (/payments/paykeeper/init) → редирект на invoice_url → страница успеха.
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

  const currencyCode = settings?.currency.code ?? 'RUB';
  const currencySymbol = settings?.currency.symbol ?? null;
  const zones = settings?.delivery?.zones ?? [];

  return (
    <>
      <div className="page-title">
        <h1>{dict.checkout.title}</h1>
      </div>
      <CheckoutForm
        currencyCode={currencyCode}
        currencySymbol={currencySymbol}
        zones={zones}
        locale={locale}
      />
    </>
  );
}
