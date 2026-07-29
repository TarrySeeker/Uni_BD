/**
 * Слой отправки: транспорт + журнал + ретраи.
 *
 * 🔴 ДВА ИНВАРИАНТА, РАДИ КОТОРЫХ НАПИСАН ВЕСЬ ФАЙЛ.
 *
 * 1. sendMail НЕ БРОСАЕТ НИКОГДА. Он вызывается ПОСЛЕ фиксации оплаты — из
 *    вебхука эквайера и из автовыпуска сертификатов. Прецедент уже описан в
 *    lib/gift-certificates/auto-issue.ts: исключение в этой точке откатило бы
 *    САМ ФАКТ ОПЛАТЫ, а повторная доставка вебхука была бы отсечена уникальным
 *    ключом лога — деньги приняты, заказ навсегда pending. Поэтому любой сбой
 *    почты — это failed-запись в журнале и отчёт, а не throw.
 *
 * 2. НЕ НАСТРОЕННАЯ ПОЧТА — ЭТО РАБОЧЕЕ СОСТОЯНИЕ, А НЕ АВАРИЯ. Платформа
 *    мультитенантна, и SMTP есть не у каждого магазина (на стенде carre его нет
 *    вовсе). Без конфигурации модуль отвечает status='skipped', пишет строку в
 *    журнал и предупреждение в лог — и НЕ мешает продавать.
 *
 * 🔴 БЕЗОПАСНОСТЬ. Тело письма (html/text) не попадает НИ в журнал, НИ в логи.
 * В нём живёт код подарочного сертификата — деньги на предъявителя, — а логи
 * уезжают в docker json-file и в бэкапы. В журнал идут только факт, адресат,
 * тип шаблона и текст ошибки транспорта.
 */

import { logger as appLogger, type Logger } from '@/lib/logger';

import {
  MAIL_MAX_ATTEMPTS,
  MAIL_RETRY_BASE_DELAY_MS,
  getMailConfig,
  isPlausibleEmail,
  mailDisabledReason,
} from './config';
import { createSmtpTransport, formatFrom } from './transport';
import { createMailJournal } from './repository';
import type {
  MailConfig,
  MailJournal,
  MailMessage,
  MailSendResult,
  MailTransport,
} from './types';

/** Зависимости отправителя (инъекция — юниты без сети и без БД, ADR-004). */
export interface MailSenderDeps {
  config: MailConfig;
  transport: MailTransport;
  journal: MailJournal;
  logger: Logger;
  /** Пауза между попытками (в тестах — no-op, чтобы прогон был мгновенным). */
  sleep: (ms: number) => Promise<void>;
}

/** Прод-зависимости: env-конфигурация, SMTP, журнал в БД. */
export function productionMailSenderDeps(): MailSenderDeps {
  const config = getMailConfig();
  return {
    config,
    transport: createSmtpTransport(config),
    journal: createMailJournal(),
    logger: appLogger.child({ module: 'mail' }),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

/**
 * Убирает CR/LF из строки заголовка.
 *
 * 🔴 Тема письма содержит номер заказа и имя магазина, то есть ДАННЫЕ. `\r\n` в
 * заголовке SMTP добавляет новый заголовок — например `Bcc: attacker@…`. Шаблоны
 * уже чистят тему, но отправитель принимает MailMessage и от других вызывающих,
 * поэтому проверка повторяется на самой границе сети (пояс и подтяжки).
 */
function headerSafe(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

/** Текст ошибки для журнала: без стека и без тела письма. */
function errorText(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  // Потолок длины: сообщение уезжает в колонку журнала и в UI админки.
  return message.slice(0, 500);
}

export function createMailSender(deps: MailSenderDeps) {
  /**
   * Заводит строку журнала, НЕ роняя отправку, если журнал недоступен.
   *
   * Журнал — наблюдаемость, а не денежный путь: если БД лежит, письмо с кодом
   * сертификата обязано уйти покупателю ВСЁ РАВНО. Потеря записи громко
   * логируется — владельцу важно знать, что след отправки не сохранился.
   */
  async function openLog(
    message: MailMessage,
    status: 'pending' | 'skipped',
    error?: string,
  ): Promise<string | null> {
    try {
      const entry = await deps.journal.create({
        recipient: message.to,
        template: message.template,
        locale: message.locale,
        status,
        attempts: 0,
        error: error ?? null,
        subject: headerSafe(message.subject),
        orderId: message.orderId ?? null,
      });
      return entry.id;
    } catch (err) {
      deps.logger.error('журнал писем недоступен — запись об отправке не сохранена', {
        template: message.template,
        error: errorText(err),
      });
      return null;
    }
  }

  /** Проставляет финальный статус журнала; сбой журнала не влияет на результат. */
  async function closeLog(
    logId: string | null,
    outcome: 'sent' | 'failed',
    attempts: number,
    error?: string,
  ): Promise<void> {
    if (!logId) return;
    try {
      if (outcome === 'sent') {
        await deps.journal.markSent(logId, attempts);
      } else {
        await deps.journal.markFailed(logId, attempts, error ?? 'unknown_error');
      }
    } catch (err) {
      deps.logger.warn('не удалось обновить статус письма в журнале', {
        logId,
        error: errorText(err),
      });
    }
  }

  /**
   * Отправляет письмо. НЕ бросает (см. шапку модуля).
   *
   * Порядок проверок важен: сначала «есть ли кому слать» (дешёвая проверка без
   * записи в журнал pending), затем «настроена ли почта». Обе ветки дают
   * status='skipped' и ok=true — вызывающему вмешиваться не нужно.
   */
  async function sendMail(message: MailMessage): Promise<MailSendResult> {
    const to = message.to?.trim() ?? '';

    // Адресат: пустой (заказ мог быть оформлен без email) либо с CRLF-инъекцией.
    if (!isPlausibleEmail(to)) {
      const logId = await openLog({ ...message, to }, 'skipped', 'invalid_recipient');
      deps.logger.warn('письмо не отправлено: у получателя нет пригодного адреса', {
        template: message.template,
        orderId: message.orderId ?? null,
      });
      return { ok: true, status: 'skipped', attempts: 0, logId, reason: 'invalid_recipient' };
    }

    // Почта магазина не настроена — штатный режим «выключено».
    if (!deps.config.enabled) {
      const reason = mailDisabledReason(deps.config) ?? 'smtp_not_configured';
      const logId = await openLog(message, 'skipped', reason);
      deps.logger.warn('письмо не отправлено: почта магазина не настроена', {
        template: message.template,
        orderId: message.orderId ?? null,
        reason,
      });
      return { ok: true, status: 'skipped', attempts: 0, logId, reason: 'mail_disabled' };
    }

    const logId = await openLog(message, 'pending');
    const payload = {
      from: formatFrom(deps.config),
      to,
      subject: headerSafe(message.subject),
      html: message.html,
      text: message.text,
    };

    let lastError = '';
    for (let attempt = 1; attempt <= MAIL_MAX_ATTEMPTS; attempt += 1) {
      try {
        await deps.transport.send(payload);
        await closeLog(logId, 'sent', attempt);
        // 🔴 В контексте лога — только метаданные: тела письма здесь нет.
        deps.logger.info('письмо отправлено', {
          template: message.template,
          orderId: message.orderId ?? null,
          attempts: attempt,
        });
        return { ok: true, status: 'sent', attempts: attempt, logId };
      } catch (err) {
        lastError = errorText(err);
        if (attempt < MAIL_MAX_ATTEMPTS) {
          // Линейный backoff: релей, отказавший мгновенно (сеть моргнула), чаще
          // всего принимает со второй попытки; долгий отказ добирает крон.
          await deps.sleep(MAIL_RETRY_BASE_DELAY_MS * attempt);
        }
      }
    }

    await closeLog(logId, 'failed', MAIL_MAX_ATTEMPTS, lastError);
    deps.logger.error('письмо не доставлено релею — досылку подхватит крон', {
      template: message.template,
      orderId: message.orderId ?? null,
      attempts: MAIL_MAX_ATTEMPTS,
      error: lastError,
    });
    return {
      ok: false,
      status: 'failed',
      attempts: MAIL_MAX_ATTEMPTS,
      logId,
      error: lastError,
    };
  }

  return { sendMail };
}

/** Прод-обёртка: вызывается из уведомлений, крона и админки. */
export function sendMail(message: MailMessage): Promise<MailSendResult> {
  return createMailSender(productionMailSenderDeps()).sendMail(message);
}
