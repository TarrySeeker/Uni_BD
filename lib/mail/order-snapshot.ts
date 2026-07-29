/**
 * Чтение данных заказа для писем: снимок заказа, выпущенные по нему сертификаты
 * и абсолютный адрес страницы заказа.
 *
 * ВЫНЕСЕНО ИЗ notifications.ts, чтобы тот остался чистым и тестируемым без БД:
 * там — политика («что и кому слать»), здесь — доступ к данным.
 *
 * 🔴 ССЫЛКА НА ЗАКАЗ СОБИРАЕТСЯ ТЕМ ЖЕ buildOrderReturnUrl, что и адрес возврата
 * с платёжного шлюза (lib/payments/return-url.ts). Это не экономия строк, а
 * требование безопасности: origin берётся ТОЛЬКО из доверенных источников
 * (shop_settings.seo.site_url → STOREFRONT_ALLOWED_ORIGINS), а токен доступа
 * подписывается сервером. Своя сборка URL здесь означала бы второй, неизбежно
 * более слабый набор правил против open redirect.
 *
 * 🔴 ПОЧЕМУ В ПИСЬМЕ ВООБЩЕ ЕСТЬ ТОКЕН: страница заказа витрины пускает по
 * HMAC-токену (lib/storefront/order-dto.ts), потому что номера заказов
 * последовательны. Без токена ссылка из письма бесполезна.
 */

import { getBalance } from '@/lib/gift-certificates/repository';
import { sql } from '@/lib/db/client';
import { buildOrderReturnUrl } from '@/lib/payments/return-url';
import { parseAllowedOrigins } from '@/lib/storefront/env';

import type { MailCertificate, MailOrderItem } from './types';
import type { OrderMailSnapshot } from './notifications';

/**
 * Снимок заказа для письма.
 *
 * Язык покупателя берётся из карточки клиента (customers.preferred_locale) —
 * заказ своей колонки языка не имеет. LEFT JOIN, потому что чекаут гостевой:
 * у большинства заказов customer_id пуст, и тогда язык решает вызывающий
 * (fallback на язык магазина).
 */
export async function getOrderMailSnapshot(orderId: string): Promise<OrderMailSnapshot | null> {
  const rows = await sql<Record<string, unknown>[]>`
    SELECT o.id, o.number, o.currency, o.grand_total, o.cdek_track,
           o.customer_name, o.customer_email, c.preferred_locale
      FROM orders o
      LEFT JOIN customers c ON c.id = o.customer_id
     WHERE o.id = ${orderId}
     LIMIT 1
  `;
  const o = rows[0];
  if (!o) return null;

  const items = await sql<Record<string, unknown>[]>`
    SELECT name_snapshot, quantity, line_total
      FROM order_items
     WHERE order_id = ${orderId}
     ORDER BY id
  `;

  return {
    orderId: String(o.id),
    orderNumber: String(o.number ?? ''),
    customerName: String(o.customer_name ?? ''),
    customerEmail: String(o.customer_email ?? ''),
    locale: o.preferred_locale != null ? String(o.preferred_locale) : null,
    grandTotal: String(o.grand_total ?? '0'),
    currency: String(o.currency ?? 'RUB'),
    trackNumber: o.cdek_track != null ? String(o.cdek_track) : null,
    items: items.map<MailOrderItem>((row) => ({
      name: String(row.name_snapshot ?? ''),
      qty: Number(row.quantity ?? 1),
      sum: String(row.line_total ?? '0'),
    })),
  };
}

/**
 * Сертификаты, ВЫПУЩЕННЫЕ по этому заказу (issued_order_id), — то есть коды,
 * которые покупатель купил и обязан получить.
 *
 * ⚠️ НЕ ПУТАТЬ с orders.gift_certificate_id: тот означает ПРОТИВОПОЛОЖНОЕ —
 * «сертификатом ОПЛАЧЕН этот заказ» (см. предупреждение в шапке миграции 0054).
 * Слать код, которым покупатель расплатился, было бы бессмысленно и опасно.
 *
 * Берутся только ДЕЙСТВУЮЩИЕ коды: отключённый вручную или истёкший сертификат
 * покупателю слать нечего — он всё равно не оплатит им заказ.
 */
export async function getIssuedCertificatesForMail(
  orderId: string,
): Promise<readonly MailCertificate[]> {
  const rows = await sql<Record<string, unknown>[]>`
    SELECT code, initial_amount, valid_until
      FROM gift_certificates
     WHERE issued_order_id = ${orderId}
       AND status = 'active'
     ORDER BY created_at, id
  `;

  return rows.map<MailCertificate>((row) => ({
    code: String(row.code ?? ''),
    amount: String(row.initial_amount ?? '0'),
    // Валюта сертификата = валюта магазина (номинал хранится в базовой валюте).
    currency: 'RUB',
    validUntil: row.valid_until ? formatDateOnly(row.valid_until) : null,
  }));
}

/** Дата без времени в виде ДД.ММ.ГГГГ (в письме время срока действия не нужно). */
function formatDateOnly(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) return '';
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${dd}.${mm}.${date.getUTCFullYear()}`;
}

/** Валюта магазина для отображения номинала (без хардкода ниши). */
export async function resolveShopCurrency(): Promise<string> {
  try {
    const { getEffectiveSettings } = await import('@/lib/config/settings');
    const settings = await getEffectiveSettings();
    return settings.currency.code ?? 'RUB';
  } catch {
    return 'RUB';
  }
}

/**
 * Абсолютный адрес страницы заказа для письма (номер + HMAC-токен).
 *
 * Возвращает null, когда доверенного origin нет (владелец не задал «Настройки →
 * SEO → Адрес сайта» и STOREFRONT_ALLOWED_ORIGINS). Тогда письмо уходит БЕЗ
 * ссылки — но уходит: для письма с кодом сертификата отсутствие ссылки не
 * критично (код в теле), а вот неотправленное письмо критично.
 */
export async function buildOrderMailUrl(
  snapshot: OrderMailSnapshot,
  env: Record<string, string | undefined> = process.env,
): Promise<string | null> {
  try {
    const { getEffectiveSettings } = await import('@/lib/config/settings');
    const { orderAccessToken } = await import('@/lib/storefront/order-dto');

    let siteUrl: string | null = null;
    try {
      siteUrl = (await getEffectiveSettings()).seo.site_url ?? null;
    } catch {
      // Настройки недоступны — остаётся env-источник; письмо это не роняет.
    }

    let accessToken: string | null = null;
    try {
      accessToken = orderAccessToken(snapshot.orderId, env);
    } catch {
      // Секрет токена не настроен: ссылка без токена бесполезна для страницы
      // заказа, поэтому лучше отдать её без параметра, чем не отдать вовсе.
      accessToken = null;
    }

    return (
      buildOrderReturnUrl({
        orderNumber: snapshot.orderNumber,
        accessToken,
        siteUrl,
        allowedOrigins: parseAllowedOrigins(env.STOREFRONT_ALLOWED_ORIGINS),
      }) ?? null
    );
  } catch {
    // Ни одна беда со сборкой ссылки не должна отменять отправку письма.
    return null;
  }
}

/** Остаток по сертификату (переиспользование домена, без дублирования SQL). */
export { getBalance as getGiftBalance };
