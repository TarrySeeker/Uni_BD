/**
 * Конфигурация почтового модуля.
 *
 * 🔴 ГДЕ ЖИВУТ СЕКРЕТЫ И ПОЧЕМУ ИМЕННО ТАМ — ТОЛЬКО env, НЕ БАЗА.
 * Пароль SMTP — это полный доступ к отправке от имени магазина: им рассылают
 * фишинг с домена владельца, и он же часто совпадает с паролем почтового ящика.
 * Положить его в shop_settings означало бы:
 *   • отдать его КАЖДОМУ оператору с правом settings.manage (а раздел настроек в
 *     Admik один на всё) — тогда как ключи эквайеров, СДЭК и S3 в этой платформе
 *     уже живут в .env именно по этой причине;
 *   • протащить его в дампы БД, которые ежесуточно уезжают в бэкап-контейнер и
 *     оффсайт (docker-compose, сервис backup) — то есть размножить секрет;
 *   • получить его в jsonb, который правится формой: любая ошибка валидации
 *     оверрайда превращается в «письма молча не уходят».
 * Поэтому здесь ровно тот же контракт, что у CDEK_/TBANK_/S3_-переменных: секреты — в
 * .env инстанса, а админка их только ПОКАЗЫВАЕТ как состояние (настроено/нет) и
 * никогда не редактирует и не отдаёт наружу. Настраиваемое БЕЗ секретов (имя
 * магазина в подписи письма) берётся из настроек — см. lib/mail/notifications.
 *
 * Второе правило модуля: НЕПОЛНАЯ конфигурация НЕ БРОСАЕТ. Магазин без SMTP
 * обязан продолжать работать, поэтому резолв всегда возвращает объект, и всё
 * решение сводится к флагу `enabled`.
 */

import type { MailConfig, MailDisabledReason } from './types';

/** Порт submission по умолчанию (RFC 6409) — STARTTLS. */
export const MAIL_DEFAULT_PORT = 587;

/** Таймаут соединения/отправки по умолчанию: письмо не должно висеть вечно. */
export const MAIL_DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Сколько раз пытаемся отдать письмо релею в пределах ОДНОГО вызова.
 * Больше трёх смысла нет: затяжной отказ релея добирает крон-досылка
 * (/api/cron/mail/retry-failed), а не бесконечный цикл в денежном пути.
 */
export const MAIL_MAX_ATTEMPTS = 3;

/** Базовая пауза backoff между попытками, мс (растёт умножением на номер попытки). */
export const MAIL_RETRY_BASE_DELAY_MS = 500;

/** Источник переменных окружения. */
export type MailEnvSource = Record<string, string | undefined>;

function str(raw: string | undefined): string | null {
  const value = raw?.trim();
  return value ? value : null;
}

function bool(raw: string | undefined): boolean {
  const value = raw?.trim().toLowerCase();
  return value === 'true' || value === '1';
}

/** Целое из env в допустимом диапазоне; мусор/выход за границы → fallback. */
function int(raw: string | undefined, fallback: number, min: number, max: number): number {
  const value = Number(raw?.trim());
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < min || value > max) {
    return fallback;
  }
  return value;
}

/**
 * Минимальная проверка адреса: непустая локальная часть, `@`, домен с точкой,
 * без пробелов и переводов строки. Полноценная RFC-валидация здесь не нужна и
 * вредна (она отвергает валидные экзотические адреса) — задача проверки в том,
 * чтобы нераскрытый плейсхолдер из .env и `CRLF`-инъекция не уехали в релей.
 */
export function isPlausibleEmail(raw: string | null | undefined): boolean {
  const value = raw?.trim();
  if (!value || value.length > 254) return false;
  if (/[\s\r\n]/.test(value)) return false;
  return /^[^@]+@[^@.]+(\.[^@.]+)+$/.test(value);
}

/**
 * Резолвит конфигурацию почты из окружения. НЕ бросает НИКОГДА: любая нехватка
 * данных даёт `enabled:false`, то есть выключенный модуль, а не аварию.
 *
 * Логин/пароль НЕ обязательны: релей внутри периметра (mailhog в dev, локальный
 * postfix) часто принимает без аутентификации. Обязательны ровно две вещи —
 * хост релея и правдоподобный адрес отправителя.
 */
export function resolveMailConfig(env: MailEnvSource = process.env): MailConfig {
  const host = str(env.SMTP_HOST);
  const from = str(env.MAIL_FROM);

  return {
    enabled: Boolean(host) && isPlausibleEmail(from),
    host,
    // Порт 465 сам по себе НЕ включает secure: некоторые релеи слушают на нём
    // STARTTLS. Режим TLS — только явный SMTP_SECURE (догадки здесь дороже).
    port: int(env.SMTP_PORT, MAIL_DEFAULT_PORT, 1, 65535),
    secure: bool(env.SMTP_SECURE),
    user: str(env.SMTP_USER),
    password: str(env.SMTP_PASSWORD),
    from,
    fromName: str(env.MAIL_FROM_NAME),
    timeoutMs: int(env.MAIL_TIMEOUT_MS, MAIL_DEFAULT_TIMEOUT_MS, 1_000, 120_000),
  };
}

/** Готов ли модуль отправлять письма. */
export function isMailConfigured(config: MailConfig): boolean {
  return config.enabled;
}

/**
 * Почему модуль выключен — для строки лога и подсказки в админке. null, когда
 * всё настроено. Хост проверяется первым: без него остальное неважно.
 */
export function mailDisabledReason(config: MailConfig): MailDisabledReason | null {
  if (config.enabled) return null;
  if (!config.host) return 'smtp_not_configured';
  return 'from_not_configured';
}

/** Кешированная на процесс конфигурация (env не меняется в рантайме). */
let cached: MailConfig | undefined;

/** Прод-конфигурация из process.env (мемоизирована). */
export function getMailConfig(): MailConfig {
  if (!cached) cached = resolveMailConfig();
  return cached;
}

/** Сброс кеша — только для тестов. */
export function resetMailConfigCache(): void {
  cached = undefined;
}
