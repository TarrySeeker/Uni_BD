/**
 * Отправка писем (SMTP). Секреты — только из env (SMTP_*). Модуль ИНЕРТЕН, пока
 * не заданы SMTP_HOST и MAIL_FROM: sendMail не шлёт, лишь логирует и возвращает
 * { sent:false, reason:'not_configured' } — вызывающий код не падает, а гейты
 * (напр. верификация email) продолжают работать.
 *
 * nodemailer — ОПЦИОНАЛЬНЫЙ рантайм-пакет: грузится КОСВЕННО (переменный
 * специфаер), поэтому сборка не тянет его в бандл и не падает, если пакет не
 * установлен. Он нужен ТОЛЬКО при настроенном SMTP; тогда его надо поставить
 * (`pnpm add nodemailer`). Без него sendMail остаётся инертным.
 */

import { getEnv } from '@/lib/config/env';
import { logger } from '@/lib/logger';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface MailResult {
  sent: boolean;
  reason?: 'not_configured' | 'no_transport' | 'send_error';
}

/** Минимальный контракт nodemailer (без зависимости от @types/nodemailer). */
interface TransportLike {
  sendMail(opts: {
    from: string;
    to: string;
    subject: string;
    text: string;
    html?: string;
  }): Promise<unknown>;
}
interface NodemailerLike {
  createTransport(opts: unknown): TransportLike;
}

/** SMTP настроен? (минимум host + from). */
export function isMailerConfigured(): boolean {
  const env = getEnv();
  return Boolean(env.SMTP_HOST && env.MAIL_FROM);
}

/** Косвенная загрузка nodemailer — бандлер не трассирует переменный специфаер. */
async function loadNodemailer(): Promise<NodemailerLike | null> {
  try {
    const spec = 'nodemailer';
    const mod = (await import(spec)) as { default?: NodemailerLike } & NodemailerLike;
    return (mod.default ?? mod) as NodemailerLike;
  } catch {
    return null;
  }
}

export async function sendMail(msg: MailMessage): Promise<MailResult> {
  const env = getEnv();
  if (!isMailerConfigured()) {
    logger.warn('mailer: SMTP не настроен — письмо НЕ отправлено (inert)', {
      to: msg.to,
      subject: msg.subject,
    });
    return { sent: false, reason: 'not_configured' };
  }
  const nodemailer = await loadNodemailer();
  if (!nodemailer) {
    logger.error('mailer: SMTP настроен, но пакет nodemailer не установлен — письмо не ушло', {
      to: msg.to,
    });
    return { sent: false, reason: 'no_transport' };
  }
  try {
    const transport = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } : undefined,
    });
    const from = env.MAIL_FROM_NAME
      ? `${env.MAIL_FROM_NAME} <${env.MAIL_FROM}>`
      : (env.MAIL_FROM as string);
    await transport.sendMail({
      from,
      to: msg.to,
      subject: msg.subject,
      text: msg.text,
      html: msg.html,
    });
    return { sent: true };
  } catch (err) {
    logger.error('mailer: ошибка отправки письма', {
      to: msg.to,
      err: err instanceof Error ? err.message : String(err),
    });
    return { sent: false, reason: 'send_error' };
  }
}
