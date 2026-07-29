/**
 * Типы почтового модуля (lib/mail).
 *
 * Модуль решает давнюю дыру платформы: e-mail не было ВООБЩЕ. Следствие,
 * признанное критичным в аудите (docs/39 §7, docs/40 §6): покупатель, купивший
 * подарочный сертификат — ДЕНЬГИ НА ПРЕДЪЯВИТЕЛЯ — получал код только на
 * эфемерной странице успеха. Закрыл вкладку → потерял деньги.
 *
 * 🔴 СКВОЗНОЕ ПРАВИЛО ТИПОВ: код сертификата живёт ТОЛЬКО в отрендеренном теле
 * письма (MailMessage.html/text), которое никуда не сохраняется. В журнале
 * (MailLogEntry) его нет по построению — там только факт и адресат.
 */

import type { Locale } from '@/lib/i18n/types';

// -----------------------------------------------------------------------------
// Конфигурация.
// -----------------------------------------------------------------------------

/**
 * Разрешённая конфигурация SMTP. `enabled=false` — ЛЕГИТИМНОЕ состояние, а не
 * ошибка: магазин без почты обязан продолжать принимать заказы (на стенде carre
 * SMTP нет вовсе, а платформа мультитенантна).
 */
export interface MailConfig {
  /** Хватает ли настроек, чтобы вообще пытаться отправлять. */
  enabled: boolean;
  host: string | null;
  port: number;
  /** Неявный TLS (SMTPS). false — обычный порт со STARTTLS. */
  secure: boolean;
  user: string | null;
  password: string | null;
  /** Адрес отправителя (envelope from + заголовок From). */
  from: string | null;
  /** Отображаемое имя отправителя (имя магазина); null → голый адрес. */
  fromName: string | null;
  /** Таймаут на соединение/отправку, мс. */
  timeoutMs: number;
}

/** Почему модуль выключен (для лога и подсказки владельцу в админке). */
export type MailDisabledReason = 'smtp_not_configured' | 'from_not_configured';

// -----------------------------------------------------------------------------
// Шаблоны.
// -----------------------------------------------------------------------------

/**
 * Идентификаторы шаблонов писем.
 *
 * Пять `cdek_*` — НЕ новый словарь: это ровно те значения, что уже перечислены в
 * STATUS_TO_CLIENT_TEMPLATE (lib/cdek/services/status-map.ts). Карта была
 * написана при портировании модуля СДЭК и до этой волны не вызывалась НИКЕМ
 * (grep давал только объявление и тест). Совпадение множеств закреплено тестом,
 * чтобы шаблон и карта не разъехались.
 */
export type MailTemplateId =
  | 'gift_certificate'
  | 'order_confirmation'
  | 'cdek_accepted'
  | 'cdek_in_transit'
  | 'cdek_ready_for_pickup'
  | 'cdek_courier_dispatched'
  | 'cdek_delivered';

/** Сертификат в письме: код + номинал. Ровно то, что нужно покупателю. */
export interface MailCertificate {
  code: string;
  /** Номинал как строка-сумма (уже отформатированная либо сырая NUMERIC). */
  amount: string;
  currency: string;
  /** Срок действия, уже отформатированный для показа; null — бессрочно. */
  validUntil: string | null;
}

/** Позиция заказа в письме-подтверждении. */
export interface MailOrderItem {
  name: string;
  qty: number;
  /** Сумма позиции (отформатированная строка). */
  sum: string;
}

/**
 * Данные для рендера. Все поля опциональны: один и тот же контекст скармливается
 * разным шаблонам, и шаблон берёт только то, что ему нужно.
 *
 * 🔴 ВСЁ, ЧТО СЮДА ПОПАДАЕТ, СЧИТАЕТСЯ НЕДОВЕРЕННЫМ и экранируется рендером:
 * имя и адрес пишет покупатель, названия товаров — оператор, имя магазина —
 * владелец. Почтовый клиент рендерит HTML, поэтому неэкранированный ввод — это
 * XSS в чужом ящике.
 */
export interface MailTemplateContext {
  shopName?: string | null;
  customer?: { name?: string | null; email?: string | null } | null;
  orderNumber?: string | null;
  /** Абсолютный адрес страницы заказа (с номером и токеном) либо null. */
  orderUrl?: string | null;
  total?: string | null;
  items?: readonly MailOrderItem[] | null;
  certificates?: readonly MailCertificate[] | null;
  trackNumber?: string | null;
}

/** Результат рендера: тема + обе версии тела. */
export interface RenderedMail {
  subject: string;
  html: string;
  text: string;
}

// -----------------------------------------------------------------------------
// Сообщение и результат отправки.
// -----------------------------------------------------------------------------

/** Готовое к отправке письмо. */
export interface MailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  template: MailTemplateId;
  locale: Locale;
  /** Заказ, к которому относится письмо (для журнала и карточки заказа). */
  orderId?: string | null;
}

/** Почему отправка не выполнялась (это НЕ авария — см. статус 'skipped'). */
export type MailSkipReason = 'mail_disabled' | 'invalid_recipient';

/**
 * Итог попытки отправки. `ok` отвечает на вопрос «нужно ли вмешательство»:
 * skipped — не нужно (почта не настроена/нет адреса), failed — нужно.
 */
export interface MailSendResult {
  ok: boolean;
  status: MailLogStatus;
  attempts: number;
  /** id строки журнала; null, если журнал недоступен (БД лежит). */
  logId: string | null;
  reason?: MailSkipReason;
  error?: string;
}

// -----------------------------------------------------------------------------
// Журнал (таблица mail_log, миграция 0061).
// -----------------------------------------------------------------------------

/**
 * Статус записи журнала:
 *   pending — отправка идёт (краткоживущее);
 *   sent    — релей принял письмо;
 *   failed  — попытки исчерпаны, кандидат на досылку;
 *   skipped — отправки не было ОСОЗНАННО (почта выключена/нет адреса).
 */
export type MailLogStatus = 'pending' | 'sent' | 'failed' | 'skipped';

/** Все статусы (для Zod-enum, фильтров админки и CHECK-паритета с миграцией). */
export const MAIL_LOG_STATUSES: readonly MailLogStatus[] = [
  'pending',
  'sent',
  'failed',
  'skipped',
];

/**
 * Строка журнала отправок.
 *
 * 🔴 ТЕЛА ПИСЬМА И КОДА СЕРТИФИКАТА ЗДЕСЬ НЕТ И НЕ БУДЕТ. Хранить их означало бы
 * держать деньги на предъявителя второй раз, в таблице, доступной любому
 * оператору раздела «Письма», и тащить их в дампы. Тело пересобирается заново из
 * заказа при досылке.
 */
export interface MailLogEntry {
  id: string;
  recipient: string;
  template: string;
  locale: string | null;
  status: MailLogStatus;
  attempts: number;
  error: string | null;
  subject: string | null;
  orderId: string | null;
  sentAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Что нужно, чтобы завести строку журнала. */
export interface MailLogCreateInput {
  recipient: string;
  template: string;
  locale: string | null;
  status: MailLogStatus;
  attempts?: number;
  error?: string | null;
  subject?: string | null;
  orderId?: string | null;
}

/**
 * Порт журнала. Инъецируется в отправитель, чтобы юниты шли без БД (ADR-004) и
 * чтобы падение журнала не могло уронить саму отправку.
 */
export interface MailJournal {
  create(input: MailLogCreateInput): Promise<MailLogEntry>;
  markSent(id: string, attempts: number): Promise<MailLogEntry | null>;
  markFailed(id: string, attempts: number, error: string): Promise<MailLogEntry | null>;
}

/** Порт транспорта (в проде — nodemailer; в тестах — заглушка). */
export interface MailTransport {
  send(payload: {
    from: string;
    to: string;
    subject: string;
    html: string;
    text: string;
  }): Promise<{ messageId: string }>;
}
