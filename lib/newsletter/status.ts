/**
 * Статусы подписчика рассылки (G-12) как ДАННЫЕ + чистые функции локализации.
 *
 * Образец — lib/leads/status.ts. У подписчика нет статус-машины переходов (только
 * необратимое active→unsubscribed выполняет репозиторий), поэтому здесь лишь
 * человекочитаемые подписи для бейджа в админке: UI весь русскоязычный, а в БД
 * хранятся технические 'active'/'unsubscribed' (CHECK в 0031_newsletter_subscribers).
 *
 * Все функции чистые и тестируемые без БД/Next.
 */

/** Полный набор статусов подписчика (= CHECK в БД). Единый источник истины. */
export const SUBSCRIBER_STATUSES = ['active', 'unsubscribed'] as const;

export type SubscriberStatus = (typeof SUBSCRIBER_STATUSES)[number];

/** Человекочитаемые подписи статусов (для бейджей админки). */
export const SUBSCRIBER_STATUS_LABELS: Readonly<Record<SubscriberStatus, string>> = {
  active: 'Активен',
  unsubscribed: 'Отписан',
};

/** True, если строка — известный статус подписчика. */
export function isSubscriberStatus(value: unknown): value is SubscriberStatus {
  return (
    typeof value === 'string' &&
    (SUBSCRIBER_STATUSES as readonly string[]).includes(value)
  );
}

/** Подпись статуса (фолбэк — сама строка, если статус неизвестен). */
export function subscriberStatusLabel(status: string): string {
  return isSubscriberStatus(status) ? SUBSCRIBER_STATUS_LABELS[status] : status;
}
