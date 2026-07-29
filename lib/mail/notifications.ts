/**
 * ТОЧКИ ВЫЗОВА ПОЧТЫ: «заказ оплачен» и «сменился статус доставки».
 *
 * 🔴 ГЛАВНОЕ ОГРАНИЧЕНИЕ — НИКОГДА НЕ БРОСАТЬ НАРУЖУ. Тот же контракт, что у
 * автовыпуска сертификатов (lib/gift-certificates/auto-issue.ts), и по той же
 * причине: обе функции вызываются ПОСЛЕ коммита оплаты/статуса, из вебхуков
 * эквайеров и СДЭК. Исключение отсюда либо откатило бы факт оплаты, либо
 * заставило бы провайдера ретраить событие, которое мы уже обработали. Поэтому
 * функции ловят всё и возвращают отчёт; исключений не выпускают вообще.
 *
 * 🔴 ЯЗЫК — ПОКУПАТЕЛЬСКИЙ, А НЕ ОПЕРАТОРСКИЙ. Оператор админки может сидеть на
 * fr, покупатель — заказать на ru. Язык берётся из карточки покупателя
 * (customers.preferred_locale), а при её отсутствии — язык магазина по
 * умолчанию. Язык интерфейса админки (users.ui_locale) сюда не попадает НИКОГДА.
 *
 * 🔴 КОД СЕРТИФИКАТА НЕ ПОПАДАЕТ НИ В ОТЧЁТ, НИ В ЛОГИ — он уезжает только в
 * тело письма. Ровно то же правило, что в шапке auto-issue.ts: логи уходят в
 * docker json-file, а код — деньги на предъявителя.
 *
 * ПОЧЕМУ ОТДЕЛЬНОЕ ПИСЬМО НА СЕРТИФИКАТ, А НЕ БЛОК В ПОДТВЕРЖДЕНИИ ЗАКАЗА:
 * подтверждение заказа покупатель пересылает (бухгалтерии, получателю подарка),
 * а письмо с кодом — предъявительский документ. Смешав их, мы заставили бы
 * покупателя пересылать деньги вместе с чеком. Разные письма — разные судьбы, и
 * провал одного не отменяет второго.
 */

import { clientEmailTemplate } from '@/lib/cdek/services/status-map';
import { logger as appLogger, type Logger } from '@/lib/logger';

import { renderMailTemplate } from './templates';
import type {
  MailCertificate,
  MailOrderItem,
  MailSendResult,
  MailTemplateId,
} from './types';

/** Снимок заказа, которого хватает для любого письма покупателю. */
export interface OrderMailSnapshot {
  orderId: string;
  orderNumber: string;
  customerName: string;
  customerEmail: string;
  /** Язык ПОКУПАТЕЛЯ; null → язык магазина по умолчанию. */
  locale: string | null;
  grandTotal: string;
  currency: string;
  trackNumber: string | null;
  items: readonly MailOrderItem[];
}

/** Почему по заказу не отправлено ничего (все причины — штатные, не аварии). */
export type MailSkipCause =
  | 'order_not_found'
  | 'no_recipient'
  | 'no_template'
  | 'error';

/** Итог работы по заказу. Никогда не заменяет собой исключение — их нет. */
export interface MailNotifyReport {
  orderId: string;
  /** false — что-то не доехало; досылку подхватит крон. */
  ok: boolean;
  sent: number;
  failed: number;
  skipped: number;
  reason?: MailSkipCause;
}

function emptyReport(orderId: string, reason: MailSkipCause, ok = true): MailNotifyReport {
  return { orderId, ok, sent: 0, failed: 0, skipped: 0, reason };
}

/** Зависимости (инъекция — юниты без БД, сети и Next; ADR-004). */
export interface MailNotifierDeps {
  getOrderSnapshot: (orderId: string) => Promise<OrderMailSnapshot | null>;
  /** Сертификаты, выпущенные ПО ЭТОМУ заказу (пусто — обычный заказ). */
  getIssuedCertificates: (orderId: string) => Promise<readonly MailCertificate[]>;
  /** Название магазина из настроек (мультитенантность — без хардкода). */
  getShopName: () => Promise<string>;
  /** Язык магазина по умолчанию (fallback языка покупателя). */
  getDefaultLocale: () => Promise<string>;
  /** Абсолютный адрес страницы заказа (номер + токен) либо null. */
  buildOrderUrl: (snapshot: OrderMailSnapshot) => Promise<string | null>;
  sendMail: (message: {
    to: string;
    subject: string;
    html: string;
    text: string;
    template: MailTemplateId;
    locale: string;
    orderId: string;
  }) => Promise<MailSendResult>;
  logger: Logger;
}

export function createMailNotifier(deps: MailNotifierDeps) {
  /**
   * Отправляет одно письмо, переводя ЛЮБОЙ сбой в счётчик отчёта.
   * Возвращает 'sent' | 'failed' | 'skipped'.
   */
  async function deliver(
    template: MailTemplateId,
    locale: string,
    order: OrderMailSnapshot,
    ctx: Parameters<typeof renderMailTemplate>[2],
  ): Promise<'sent' | 'failed' | 'skipped'> {
    try {
      const rendered = renderMailTemplate(template, locale, ctx);
      const result = await deps.sendMail({
        to: order.customerEmail,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        template,
        locale,
        orderId: order.orderId,
      });
      if (result.status === 'sent') return 'sent';
      if (result.status === 'skipped') return 'skipped';
      return 'failed';
    } catch (err) {
      // 🔴 В контекст лога попадает ТОЛЬКО тип письма — не его тело.
      deps.logger.error('письмо не отправлено', {
        orderId: order.orderId,
        template,
        error: err instanceof Error ? err.message : String(err),
      });
      return 'failed';
    }
  }

  /** Собирает общую часть контекста рендера (одна на все письма заказа). */
  async function baseContext(order: OrderMailSnapshot) {
    return {
      shopName: await deps.getShopName(),
      customer: { name: order.customerName, email: order.customerEmail },
      orderNumber: order.orderNumber,
      orderUrl: await deps.buildOrderUrl(order),
      trackNumber: order.trackNumber,
    };
  }

  /** Язык покупателя с откатом на язык магазина. */
  async function localeFor(order: OrderMailSnapshot): Promise<string> {
    const own = order.locale?.trim();
    if (own) return own;
    return deps.getDefaultLocale();
  }

  /**
   * Письма по ОПЛАЧЕННОМУ заказу: подтверждение + (если выпущены) коды
   * сертификатов. Не бросает.
   */
  async function notifyOrderPaid(orderId: string): Promise<MailNotifyReport> {
    try {
      const order = await deps.getOrderSnapshot(orderId);
      if (!order) return emptyReport(orderId, 'order_not_found');
      if (!order.customerEmail?.trim()) return emptyReport(orderId, 'no_recipient');

      const locale = await localeFor(order);
      const base = await baseContext(order);
      const report: MailNotifyReport = { orderId, ok: true, sent: 0, failed: 0, skipped: 0 };

      const tally = (outcome: 'sent' | 'failed' | 'skipped') => {
        if (outcome === 'sent') report.sent += 1;
        else if (outcome === 'failed') report.failed += 1;
        else report.skipped += 1;
      };

      // Сертификаты — ПЕРВЫМИ: если релей вот-вот отвалится, деньги важнее чека.
      // Чтение отдельно обёрнуто: отсутствие сертификатов не должно отменять
      // подтверждение заказа (обычный заказ — самый частый случай).
      let certificates: readonly MailCertificate[] = [];
      try {
        certificates = await deps.getIssuedCertificates(orderId);
      } catch (err) {
        report.ok = false;
        deps.logger.error('не удалось прочитать выпущенные сертификаты для письма', {
          orderId,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      if (certificates.length > 0) {
        tally(await deliver('gift_certificate', locale, order, { ...base, certificates }));
      }

      tally(
        await deliver('order_confirmation', locale, order, {
          ...base,
          items: order.items,
          total: `${order.grandTotal} ${order.currency}`,
        }),
      );

      if (report.failed > 0) report.ok = false;
      return report;
    } catch (err) {
      // Наружу не выпускаем НИЧЕГО: вызывающий — путь фиксации оплаты.
      deps.logger.error('письма по оплаченному заказу сорвались', {
        orderId,
        error: err instanceof Error ? err.message : String(err),
      });
      return emptyReport(orderId, 'error', false);
    }
  }

  /**
   * Письмо о смене статуса доставки.
   *
   * Шаблон выбирает УЖЕ СУЩЕСТВУЮЩАЯ карта STATUS_TO_CLIENT_TEMPLATE
   * (lib/cdek/services/status-map.ts): она была написана при портировании модуля
   * СДЭК и до этой волны не вызывалась НИКЕМ — grep давал только объявление и
   * тест. Заводить рядом второй словарь значило бы гарантировать расхождение.
   * Коды без шаблона (CREATED и прочие технические) писем не порождают.
   */
  async function notifyDeliveryStatus(
    orderId: string,
    statusCode: string,
  ): Promise<MailNotifyReport> {
    try {
      const template = clientEmailTemplate(statusCode);
      if (!template) return emptyReport(orderId, 'no_template');

      const order = await deps.getOrderSnapshot(orderId);
      if (!order) return emptyReport(orderId, 'order_not_found');
      if (!order.customerEmail?.trim()) return emptyReport(orderId, 'no_recipient');

      const locale = await localeFor(order);
      const base = await baseContext(order);
      const outcome = await deliver(template as MailTemplateId, locale, order, base);

      return {
        orderId,
        ok: outcome !== 'failed',
        sent: outcome === 'sent' ? 1 : 0,
        failed: outcome === 'failed' ? 1 : 0,
        skipped: outcome === 'skipped' ? 1 : 0,
      };
    } catch (err) {
      deps.logger.error('письмо о статусе доставки сорвалось', {
        orderId,
        statusCode,
        error: err instanceof Error ? err.message : String(err),
      });
      return emptyReport(orderId, 'error', false);
    }
  }

  return { notifyOrderPaid, notifyDeliveryStatus };
}

/**
 * Прод-зависимости. Импорты ЛЕНИВЫЕ (`await import`) сознательно: этот модуль
 * тянут вебхуки и крон, а тащить за собой весь слой заказов/сертификатов/
 * настроек на этапе импорта незачем — и незачем ронять юнит-окружение без БД.
 */
export function productionMailNotifierDeps(): MailNotifierDeps {
  const logger = appLogger.child({ module: 'mail-notify' });

  return {
    getOrderSnapshot: async (orderId) => {
      const { getOrderMailSnapshot } = await import('./order-snapshot');
      return getOrderMailSnapshot(orderId);
    },
    getIssuedCertificates: async (orderId) => {
      const { getIssuedCertificatesForMail } = await import('./order-snapshot');
      return getIssuedCertificatesForMail(orderId);
    },
    getShopName: async () => {
      const { getEffectiveSettings } = await import('@/lib/config/settings');
      const settings = await getEffectiveSettings();
      return settings.branding.shopName ?? '';
    },
    getDefaultLocale: async () => {
      const { getLocaleConfig } = await import('@/lib/i18n/config');
      return (await getLocaleConfig()).defaultLocale;
    },
    buildOrderUrl: async (snapshot) => {
      const { buildOrderMailUrl } = await import('./order-snapshot');
      return buildOrderMailUrl(snapshot);
    },
    sendMail: async (message) => {
      const { sendMail } = await import('./sender');
      return sendMail(message);
    },
    logger,
  };
}

/** Прод-обёртка: вызывается после фиксации оплаты. */
export function notifyOrderPaid(orderId: string): Promise<MailNotifyReport> {
  return createMailNotifier(productionMailNotifierDeps()).notifyOrderPaid(orderId);
}

/** Прод-обёртка: вызывается при смене статуса доставки (вебхук/сверка СДЭК). */
export function notifyDeliveryStatus(
  orderId: string,
  statusCode: string,
): Promise<MailNotifyReport> {
  return createMailNotifier(productionMailNotifierDeps()).notifyDeliveryStatus(
    orderId,
    statusCode,
  );
}
