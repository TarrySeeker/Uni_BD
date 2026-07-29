/**
 * ПОВТОРНАЯ ОТПРАВКА письма по записи журнала — общая точка для кнопки в админке
 * и для крон-досылки.
 *
 * 🔴 ПОЧЕМУ ПИСЬМО ПЕРЕСОБИРАЕТСЯ, А НЕ ДОСТАЁТСЯ ИЗ ХРАНИЛИЩА. Тела писем в
 * журнале нет сознательно (см. шапку миграции 0061): хранить отрендеренное
 * письмо значило бы держать код подарочного сертификата — деньги на
 * предъявителя — вторым экземпляром в таблице, доступной любому оператору
 * раздела «Письма», и тащить его во все дампы БД. Поэтому досылка рендерит
 * письмо ЗАНОВО из заказа: тот же шаблон, тот же язык, актуальные данные.
 *
 * ПОБОЧНОЕ СЛЕДСТВИЕ, КОТОРОЕ ЯВЛЯЕТСЯ ПРЕИМУЩЕСТВОМ: если сертификат за это
 * время отключили или он истёк, повторное письмо его уже не назовёт — мы не
 * рассылаем недействительные коды.
 *
 * ОГРАНИЧЕНИЕ: досылать можно только письма, привязанные к ЗАКАЗУ. Письмо без
 * order_id пересобрать не из чего — такая запись отдаёт понятный отказ, а не
 * пустое письмо.
 */

import { STATUS_TO_CLIENT_TEMPLATE } from '@/lib/cdek/services/status-map';
import { logger as appLogger } from '@/lib/logger';

import { getMailLogById } from './repository';
import { createMailNotifier, productionMailNotifierDeps } from './notifications';
import type { MailSendResult, MailTemplateId } from './types';
import { MAIL_TEMPLATE_IDS } from './templates';

const log = appLogger.child({ module: 'mail-resend' });

/** Известен ли платформе такой шаблон (защита от мусора в старой строке журнала). */
function isKnownTemplate(value: string): value is MailTemplateId {
  return (MAIL_TEMPLATE_IDS as readonly string[]).includes(value);
}

/** Результат «отправлять нечего» — единый вид отказа без исключения. */
function skipped(logId: string | null, error: string): MailSendResult {
  return { ok: false, status: 'failed', attempts: 0, logId, error };
}

/**
 * Пересобирает и отправляет письмо по id записи журнала. НЕ бросает.
 *
 * Возвращает результат НОВОЙ отправки: у неё своя строка журнала. Старая
 * остаётся как есть — история отправок не переписывается задним числом, иначе
 * по журналу нельзя было бы понять, сколько раз мы пытались достучаться.
 */
export async function resendMailById(logId: string): Promise<MailSendResult> {
  const entry = await getMailLogById(logId);
  if (!entry) {
    return skipped(null, 'mail_log_entry_not_found');
  }
  if (!entry.orderId) {
    // Письмо не привязано к заказу — пересобрать не из чего.
    return skipped(logId, 'resend_requires_order');
  }
  if (!isKnownTemplate(entry.template)) {
    log.warn('досылка: неизвестный шаблон письма', { logId, template: entry.template });
    return skipped(logId, 'unknown_template');
  }

  const notifier = createMailNotifier(productionMailNotifierDeps());

  // Письма о сертификате и о заказе пересобирает конвейер «заказ оплачен»: он
  // сам решит, есть ли действующие коды, и отправит то, что уместно сейчас.
  if (entry.template === 'gift_certificate' || entry.template === 'order_confirmation') {
    const report = await notifier.notifyOrderPaid(entry.orderId);
    return {
      ok: report.ok,
      status: report.sent > 0 ? 'sent' : report.failed > 0 ? 'failed' : 'skipped',
      attempts: 1,
      logId,
    };
  }

  // Письма о доставке: восстанавливаем статус по шаблону. Карта STATUS →
  // TEMPLATE не инъективна (несколько кодов ведут на один шаблон), поэтому
  // берём любой код, дающий нужный шаблон, — текст письма от кода не зависит.
  const statusCode = statusCodeForTemplate(entry.template);
  if (!statusCode) {
    return skipped(logId, 'unknown_template');
  }
  const report = await notifier.notifyDeliveryStatus(entry.orderId, statusCode);
  return {
    ok: report.ok,
    status: report.sent > 0 ? 'sent' : report.failed > 0 ? 'failed' : 'skipped',
    attempts: 1,
    logId,
  };
}

/**
 * Обратный поиск: шаблон → любой код статуса СДЭК, дающий этот шаблон.
 *
 * Источник правды — та же карта STATUS_TO_CLIENT_TEMPLATE, что и в прямом
 * направлении: своего словаря здесь нет, чтобы направления не разъехались.
 */
export function statusCodeForTemplate(template: MailTemplateId): string | null {
  for (const [code, tpl] of Object.entries(STATUS_TO_CLIENT_TEMPLATE)) {
    if (tpl === template) return code;
  }
  return null;
}
