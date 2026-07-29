/**
 * Шаблоны писем: HTML + текстовая версия, на языке ПОКУПАТЕЛЯ.
 *
 * 🔴 ЭКРАНИРОВАНИЕ — ГЛАВНОЕ ТРЕБОВАНИЕ ЭТОГО ФАЙЛА. Имя покупателя, адрес,
 * названия товаров и даже имя магазина попадают в HTML, который РЕНДЕРИТ ЧУЖОЙ
 * ПОЧТОВЫЙ КЛИЕНТ. Неэкранированное `<img src=x onerror=…>` в имени — это XSS в
 * ящике покупателя, причём подписанный доменом магазина. Поэтому В ШАБЛОНАХ НЕТ
 * НИ ОДНОЙ ПОДСТАНОВКИ БЕЗ escapeHtml: единственный способ попасть в разметку —
 * пройти через него.
 *
 * ПОЧЕМУ СВОЙ РЕНДЕР, А НЕ next-intl. Каталоги messages/*.json — это язык
 * ИНТЕРФЕЙСА ОПЕРАТОРА (админка), и next-intl резолвит их из запроса. Письмо
 * уходит из вебхука эквайера и из крона, где запроса нет вовсе, а язык нужен
 * ПОКУПАТЕЛЬСКИЙ. Тащить сюда серверный next-intl означало бы связать денежный
 * путь с рантаймом Next; тексты писем — короткие и живут рядом с шаблоном.
 *
 * ПОЧЕМУ ТЕКСТОВАЯ ВЕРСИЯ ОБЯЗАТЕЛЬНА: письмо только-HTML почтовые фильтры
 * штрафуют как спам, а часть клиентов (и уведомления на часах) показывают именно
 * text/plain. Для письма с кодом сертификата попадание в спам = потеря денег.
 *
 * Модуль ЧИСТЫЙ: без БД, без сети, без Next. Тестируется напрямую.
 */

import type {
  MailTemplateContext,
  MailTemplateId,
  RenderedMail,
} from './types';

/** Все объявленные шаблоны (для guard-тестов полноты и админки). */
export const MAIL_TEMPLATE_IDS: readonly MailTemplateId[] = [
  'gift_certificate',
  'order_confirmation',
  'cdek_accepted',
  'cdek_in_transit',
  'cdek_ready_for_pickup',
  'cdek_courier_dispatched',
  'cdek_delivered',
];

/** Язык писем по умолчанию, если запрошенного в каталоге нет. */
const FALLBACK_LOCALE = 'ru';

// =============================================================================
// Экранирование.
// =============================================================================

/**
 * Экранирует значение для вставки в HTML-текст и в значение атрибута.
 *
 * Амперсанд обрабатывается ПЕРВЫМ — иначе последующие замены (`&lt;`) сами
 * содержали бы `&`, и результат экранировался бы дважды («&amp;lt;» вместо
 * «&lt;»), превращая разметку в мусор на экране покупателя.
 *
 * Одинарная кавычка экранируется тоже: атрибуты в шаблонах в двойных кавычках,
 * но правило «экранируем все пять» дешевле, чем аудит каждого места вставки.
 */
export function escapeHtml(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Схлопывает переводы строк в пробел — для темы письма.
 *
 * 🔴 CR/LF в Subject — это ИНЪЕКЦИЯ SMTP-ЗАГОЛОВКОВ: `Заказ\r\nBcc: attacker@…`
 * добавляет скрытого получателя. Номер заказа и имя магазина попадают в тему, а
 * номер приходит из данных; поэтому чистим здесь, а не полагаемся на транспорт.
 */
function singleLine(value: string): string {
  return value.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

/**
 * Пропускает только http(s)-ссылки. `javascript:`/`data:` в href письма — это
 * XSS/фишинг; адрес заказа собирается сервером, но правило единое для всех
 * подстановок в href.
 */
function safeUrl(raw: string | null | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

// =============================================================================
// Словарь текстов (ru/en/fr).
// =============================================================================

/** Строки одного языка. */
interface Strings {
  greeting: (name: string) => string;
  greetingAnon: string;
  regards: (shop: string) => string;
  orderLink: string;
  /** Заголовки и абзацы конкретных шаблонов. */
  gift: {
    subject: (shop: string) => string;
    intro: string;
    codeLabel: string;
    amountLabel: string;
    validUntilLabel: string;
    keepSafe: string;
  };
  order: {
    subject: (number: string) => string;
    intro: (number: string) => string;
    itemsHeader: string;
    totalLabel: string;
    qtyLabel: string;
  };
  delivery: {
    subject: (number: string) => string;
    trackLabel: string;
    accepted: string;
    inTransit: string;
    readyForPickup: string;
    courierDispatched: string;
    delivered: string;
  };
}

const RU: Strings = {
  greeting: (name) => `Здравствуйте, ${name}!`,
  greetingAnon: 'Здравствуйте!',
  regards: (shop) => `С уважением, ${shop}`,
  orderLink: 'Открыть заказ',
  gift: {
    subject: (shop) => `Ваш подарочный сертификат — ${shop}`,
    intro: 'Спасибо за покупку! Ваш подарочный сертификат готов.',
    codeLabel: 'Код сертификата',
    amountLabel: 'Номинал',
    validUntilLabel: 'Действует до',
    keepSafe:
      'Сохраните это письмо: код действует как денежное средство на предъявителя — ' +
      'тот, кто его знает, может оплатить им заказ.',
  },
  order: {
    subject: (number) => `Заказ ${number} принят`,
    intro: (number) => `Мы получили ваш заказ ${number} и уже занимаемся им.`,
    itemsHeader: 'Состав заказа',
    totalLabel: 'Итого',
    qtyLabel: 'шт.',
  },
  delivery: {
    subject: (number) => `Заказ ${number}: статус доставки изменился`,
    trackLabel: 'Трек-номер',
    accepted: 'Ваш заказ принят на складе службы доставки.',
    inTransit: 'Ваш заказ едет к вам.',
    readyForPickup: 'Ваш заказ прибыл и готов к выдаче в пункте выдачи.',
    courierDispatched: 'Ваш заказ передан курьеру и будет доставлен в ближайшее время.',
    delivered: 'Ваш заказ вручён. Спасибо, что выбрали нас!',
  },
};

const EN: Strings = {
  greeting: (name) => `Hello, ${name}!`,
  greetingAnon: 'Hello!',
  regards: (shop) => `Kind regards, ${shop}`,
  orderLink: 'View order',
  gift: {
    subject: (shop) => `Your gift certificate — ${shop}`,
    intro: 'Thank you for your purchase! Your gift certificate is ready.',
    codeLabel: 'Certificate code',
    amountLabel: 'Value',
    validUntilLabel: 'Valid until',
    keepSafe:
      'Please keep this email: the code works like cash to the bearer — anyone who ' +
      'knows it can pay for an order with it.',
  },
  order: {
    subject: (number) => `Order ${number} confirmed`,
    intro: (number) => `We have received your order ${number} and are working on it.`,
    itemsHeader: 'Order contents',
    totalLabel: 'Total',
    qtyLabel: 'pcs',
  },
  delivery: {
    subject: (number) => `Order ${number}: delivery status updated`,
    trackLabel: 'Tracking number',
    accepted: 'Your order has been accepted at the carrier warehouse.',
    inTransit: 'Your order is on its way.',
    readyForPickup: 'Your order has arrived and is ready for pickup.',
    courierDispatched: 'Your order has been handed to a courier and will arrive shortly.',
    delivered: 'Your order has been delivered. Thank you for choosing us!',
  },
};

const FR: Strings = {
  greeting: (name) => `Bonjour, ${name} !`,
  greetingAnon: 'Bonjour !',
  regards: (shop) => `Cordialement, ${shop}`,
  orderLink: 'Voir la commande',
  gift: {
    subject: (shop) => `Votre chèque-cadeau — ${shop}`,
    intro: 'Merci pour votre achat ! Votre chèque-cadeau est prêt.',
    codeLabel: 'Code du chèque-cadeau',
    amountLabel: 'Valeur',
    validUntilLabel: 'Valable jusqu’au',
    keepSafe:
      'Conservez cet e-mail : le code fonctionne comme un titre au porteur — toute ' +
      'personne qui le connaît peut l’utiliser pour payer une commande.',
  },
  order: {
    subject: (number) => `Commande ${number} confirmée`,
    intro: (number) => `Nous avons bien reçu votre commande ${number} et la traitons.`,
    itemsHeader: 'Contenu de la commande',
    totalLabel: 'Total',
    qtyLabel: 'pcs',
  },
  delivery: {
    subject: (number) => `Commande ${number} : statut de livraison mis à jour`,
    trackLabel: 'Numéro de suivi',
    accepted: 'Votre commande a été acceptée à l’entrepôt du transporteur.',
    inTransit: 'Votre commande est en route.',
    readyForPickup: 'Votre commande est arrivée et prête à être retirée.',
    courierDispatched: 'Votre commande a été remise à un coursier et arrivera bientôt.',
    delivered: 'Votre commande a été livrée. Merci de nous avoir choisis !',
  },
};

const CATALOG: Readonly<Record<string, Strings>> = { ru: RU, en: EN, fr: FR };

/**
 * Выбирает словарь языка. Неизвестный/пустой язык → ru (язык магазина по
 * умолчанию платформы). Пустое письмо не отдаём НИКОГДА: письмо с кодом
 * сертификата — это деньги, и «языка не нашлось» не повод его не слать.
 */
function stringsFor(locale: string): Strings {
  const key = String(locale ?? '').trim().toLowerCase().split('-')[0] ?? '';
  return CATALOG[key] ?? CATALOG[FALLBACK_LOCALE]!;
}

// =============================================================================
// Каркас письма.
// =============================================================================

/**
 * Обёртка HTML-письма. Инлайновые стили и таблица шириной 100% — потому что
 * почтовые клиенты вырезают <style> и не поддерживают современный CSS.
 * Внешних ресурсов (картинок, шрифтов, скриптов) НЕТ намеренно: они выдают факт
 * прочтения, блокируются по умолчанию и добавляют письму спам-очки.
 */
function htmlShell(bodyHtml: string): string {
  return [
    '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1f2937;max-width:600px;">',
    bodyHtml,
    '</div>',
  ].join('');
}

function paragraph(text: string): string {
  return `<p style="margin:0 0 12px;">${text}</p>`;
}

/** Блок «код сертификата»: моноширинный, крупный — его переписывают руками. */
function codeBlock(label: string, code: string): string {
  return (
    `<p style="margin:0 0 4px;color:#6b7280;font-size:13px;">${label}</p>` +
    `<p style="margin:0 0 12px;font-family:'Courier New',monospace;font-size:22px;` +
    `font-weight:bold;letter-spacing:2px;">${code}</p>`
  );
}

function linkBlock(url: string, label: string): string {
  return (
    `<p style="margin:16px 0;">` +
    `<a href="${escapeHtml(url)}" style="color:#1d4ed8;">${label}</a>` +
    `</p>`
  );
}

/** Приветствие по имени покупателя (или безличное, если имени нет). */
function greeting(s: Strings, ctx: MailTemplateContext): string {
  const name = ctx.customer?.name?.trim();
  return name ? s.greeting(escapeHtml(name)) : s.greetingAnon;
}

/** То же приветствие для текстовой версии (без экранирования — там нет разметки). */
function greetingText(s: Strings, ctx: MailTemplateContext): string {
  const name = ctx.customer?.name?.trim();
  return name ? s.greeting(name) : s.greetingAnon;
}

/** Собирает текстовую версию из строк, выкидывая пустые. */
function textBody(lines: readonly (string | null)[]): string {
  return lines.filter((l): l is string => Boolean(l && l.trim())).join('\n');
}

// =============================================================================
// Шаблоны.
// =============================================================================

function renderGift(s: Strings, ctx: MailTemplateContext): RenderedMail {
  const shop = ctx.shopName?.trim() || '';
  const certificates = ctx.certificates ?? [];
  const url = safeUrl(ctx.orderUrl);

  const htmlCerts = certificates
    .map((c) =>
      [
        '<div style="margin:0 0 20px;padding:16px;border:1px solid #e5e7eb;border-radius:8px;">',
        codeBlock(s.gift.codeLabel, escapeHtml(c.code)),
        paragraph(
          `<span style="color:#6b7280;">${s.gift.amountLabel}:</span> ` +
            `${escapeHtml(c.amount)} ${escapeHtml(c.currency)}`,
        ),
        c.validUntil
          ? paragraph(
              `<span style="color:#6b7280;">${s.gift.validUntilLabel}:</span> ` +
                `${escapeHtml(c.validUntil)}`,
            )
          : '',
        '</div>',
      ].join(''),
    )
    .join('');

  const html = htmlShell(
    [
      paragraph(greeting(s, ctx)),
      paragraph(s.gift.intro),
      htmlCerts,
      paragraph(`<strong>${s.gift.keepSafe}</strong>`),
      url ? linkBlock(url, s.orderLink) : '',
      paragraph(s.regards(escapeHtml(shop))),
    ].join(''),
  );

  const text = textBody([
    greetingText(s, ctx),
    s.gift.intro,
    '',
    ...certificates.flatMap((c) => [
      `${s.gift.codeLabel}: ${c.code}`,
      `${s.gift.amountLabel}: ${c.amount} ${c.currency}`,
      c.validUntil ? `${s.gift.validUntilLabel}: ${c.validUntil}` : null,
      '',
    ]),
    s.gift.keepSafe,
    url ? `${s.orderLink}: ${url}` : null,
    '',
    s.regards(shop),
  ]);

  return { subject: singleLine(s.gift.subject(shop)), html, text };
}

function renderOrder(s: Strings, ctx: MailTemplateContext): RenderedMail {
  const shop = ctx.shopName?.trim() || '';
  const number = ctx.orderNumber?.trim() || '';
  const items = ctx.items ?? [];
  const url = safeUrl(ctx.orderUrl);

  const rows = items
    .map(
      (i) =>
        '<tr>' +
        `<td style="padding:6px 8px;border-bottom:1px solid #f3f4f6;">${escapeHtml(i.name)}</td>` +
        `<td style="padding:6px 8px;border-bottom:1px solid #f3f4f6;white-space:nowrap;">` +
        `${escapeHtml(i.qty)} ${s.order.qtyLabel}</td>` +
        `<td style="padding:6px 8px;border-bottom:1px solid #f3f4f6;white-space:nowrap;text-align:right;">` +
        `${escapeHtml(i.sum)}</td>` +
        '</tr>',
    )
    .join('');

  const table = items.length
    ? `<p style="margin:16px 0 8px;font-weight:bold;">${s.order.itemsHeader}</p>` +
      '<table style="width:100%;border-collapse:collapse;font-size:14px;">' +
      `<tbody>${rows}</tbody></table>`
    : '';

  const html = htmlShell(
    [
      paragraph(greeting(s, ctx)),
      paragraph(s.order.intro(escapeHtml(number))),
      table,
      ctx.total
        ? paragraph(`<strong>${s.order.totalLabel}: ${escapeHtml(ctx.total)}</strong>`)
        : '',
      url ? linkBlock(url, s.orderLink) : '',
      paragraph(s.regards(escapeHtml(shop))),
    ].join(''),
  );

  const text = textBody([
    greetingText(s, ctx),
    s.order.intro(number),
    '',
    items.length ? `${s.order.itemsHeader}:` : null,
    ...items.map((i) => `- ${i.name} — ${i.qty} ${s.order.qtyLabel} — ${i.sum}`),
    ctx.total ? `${s.order.totalLabel}: ${ctx.total}` : null,
    url ? `${s.orderLink}: ${url}` : null,
    '',
    s.regards(shop),
  ]);

  return { subject: singleLine(s.order.subject(number)), html, text };
}

/** Тексты статусов доставки по шаблону (порт STATUS_TO_CLIENT_TEMPLATE). */
function deliveryBody(s: Strings, id: MailTemplateId): string {
  switch (id) {
    case 'cdek_accepted':
      return s.delivery.accepted;
    case 'cdek_in_transit':
      return s.delivery.inTransit;
    case 'cdek_ready_for_pickup':
      return s.delivery.readyForPickup;
    case 'cdek_courier_dispatched':
      return s.delivery.courierDispatched;
    case 'cdek_delivered':
      return s.delivery.delivered;
    default:
      return s.delivery.inTransit;
  }
}

function renderDelivery(
  s: Strings,
  id: MailTemplateId,
  ctx: MailTemplateContext,
): RenderedMail {
  const shop = ctx.shopName?.trim() || '';
  const number = ctx.orderNumber?.trim() || '';
  const track = ctx.trackNumber?.trim() || null;
  const url = safeUrl(ctx.orderUrl);
  const body = deliveryBody(s, id);

  const html = htmlShell(
    [
      paragraph(greeting(s, ctx)),
      paragraph(`${body} (${escapeHtml(number)})`),
      track ? paragraph(`${s.delivery.trackLabel}: ${escapeHtml(track)}`) : '',
      url ? linkBlock(url, s.orderLink) : '',
      paragraph(s.regards(escapeHtml(shop))),
    ].join(''),
  );

  const text = textBody([
    greetingText(s, ctx),
    `${body} (${number})`,
    track ? `${s.delivery.trackLabel}: ${track}` : null,
    url ? `${s.orderLink}: ${url}` : null,
    '',
    s.regards(shop),
  ]);

  return { subject: singleLine(s.delivery.subject(number)), html, text };
}

// =============================================================================
// Точка входа.
// =============================================================================

/**
 * Рендерит письмо: тема + HTML + текст. Чистая функция, НЕ бросает.
 *
 * `locale` — язык ПОКУПАТЕЛЯ (из снимка заказа), а не оператора. Неизвестный
 * язык откатывается на язык платформы, но письмо отдаётся всегда.
 */
export function renderMailTemplate(
  template: MailTemplateId,
  locale: string,
  ctx: MailTemplateContext,
): RenderedMail {
  const s = stringsFor(locale);
  switch (template) {
    case 'gift_certificate':
      return renderGift(s, ctx);
    case 'order_confirmation':
      return renderOrder(s, ctx);
    default:
      return renderDelivery(s, template, ctx);
  }
}
