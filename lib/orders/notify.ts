/**
 * Письмо покупателю о принятом заказе.
 *
 * Зачем это часть платформы, а не магазина. У магазина без личного кабинета
 * ссылка со статусом заказа — единственный способ вернуться к нему: номер и
 * токен живут в письме. Не отправить письмо значит оставить покупателя без
 * заказа сразу после оплаты.
 *
 * Модуль инертен, пока не настроен SMTP: `sendMail` вернёт
 * `{ sent: false, reason: 'not_configured' }`, а заказ всё равно будет создан.
 * Это осознанно — отсутствие почты не повод отказывать в покупке. Что почта не
 * настроена, видно в разделе «Готовность магазина», а не по молчанию.
 *
 * Ниша магазина здесь не упоминается: название, адрес сайта и контакты берутся
 * из настроек инстанса.
 */

import { getEffectiveSettings } from '@/lib/config/settings';
import { logger } from '@/lib/logger';
import { isMailerConfigured, sendMail } from '@/lib/mailer';
import { describeSnapshot } from '@/lib/personalization/schemas';

import type { Order, OrderItem } from './types';

/** Экранирование пользовательских строк для письма в HTML. */
function esc(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/**
 * Ссылка на статус заказа. Токен — часть ссылки: он и есть доступ, поэтому
 * письмо уходит только на адрес, указанный в заказе.
 */
export function trackingUrl(siteUrl: string, orderNumber: string, accessToken: string): string {
  const base = siteUrl.replace(/\/+$/, '');
  return `${base}/order/${encodeURIComponent(orderNumber)}?token=${encodeURIComponent(accessToken)}`;
}

/**
 * Состав заказа обычным текстом. Персонализация печатается подписями из снимка
 * позиции — покупатель должен увидеть в письме ровно то, что уйдёт в работу, и
 * успеть сообщить об ошибке до гравировки.
 */
function linesOf(items: OrderItem[]): { text: string; html: string } {
  const text: string[] = [];
  const html: string[] = [];

  for (const item of items) {
    text.push(`• ${item.nameSnapshot} × ${item.quantity} — ${item.lineTotal}`);
    html.push(
      `<li><strong>${esc(item.nameSnapshot)}</strong> × ${item.quantity} — ${esc(item.lineTotal)}`,
    );

    for (const row of describeSnapshot(item.personalization)) {
      text.push(`    ${row.label}: ${row.value}`);
      html.push(`<br><span>${esc(row.label)}: ${esc(row.value)}</span>`);
    }
    html.push('</li>');
  }

  return { text: text.join('\n'), html: `<ul>${html.join('')}</ul>` };
}

/**
 * Отправляет письмо о принятом заказе. Никогда не бросает: сбой почты не должен
 * отменять уже созданный заказ — он уходит в лог, где его видно мониторингу.
 */
export async function sendOrderConfirmation(
  order: Order,
  items: OrderItem[],
  /** Токен доступа к заказу — его считает роут витрины, домен о нём не знает. */
  accessToken: string,
): Promise<void> {
  if (!isMailerConfigured()) {
    logger.warn('order mail: SMTP не настроен — письмо о заказе не отправлено', {
      module: 'orders',
      orderNumber: order.number,
    });
    return;
  }

  try {
    const settings = await getEffectiveSettings();
    const shopName = settings.branding.shopName;
    const siteUrl = settings.seo.site_url ?? '';
    const body = linesOf(items);
    const link = siteUrl ? trackingUrl(siteUrl, order.number, accessToken) : null;

    const text = [
      `Здравствуйте!`,
      ``,
      `${shopName} принял ваш заказ ${order.number}.`,
      ``,
      `Состав заказа:`,
      body.text,
      ``,
      `Итого: ${order.grandTotal} ${order.currency}`,
      link ? `` : null,
      link ? `Статус заказа: ${link}` : null,
      ``,
      `Проверьте, пожалуйста, надписи выше: изделие изготавливается по ним.`,
      `Если нашли ошибку — ответьте на это письмо, пока заказ не ушёл в работу.`,
    ]
      .filter((l) => l !== null)
      .join('\n');

    const html = [
      `<p>Здравствуйте!</p>`,
      `<p><strong>${esc(shopName)}</strong> принял ваш заказ <strong>${esc(order.number)}</strong>.</p>`,
      `<p>Состав заказа:</p>`,
      body.html,
      `<p>Итого: <strong>${esc(order.grandTotal)} ${esc(order.currency)}</strong></p>`,
      link ? `<p><a href="${esc(link)}">Посмотреть статус заказа</a></p>` : '',
      `<p>Проверьте, пожалуйста, надписи выше: изделие изготавливается по ним. Если нашли ошибку — ответьте на это письмо, пока заказ не ушёл в работу.</p>`,
    ].join('');

    await sendMail({
      to: order.customerEmail,
      subject: `${shopName}: заказ ${order.number} принят`,
      text,
      html,
    });
  } catch (err) {
    logger.error('order mail: не удалось отправить письмо о заказе', {
      module: 'orders',
      orderNumber: order.number,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
