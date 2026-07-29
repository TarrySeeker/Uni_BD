import { useTranslations } from 'next-intl';

import { MAIL_LOG_STATUSES, type MailLogStatus } from '@/lib/mail/types';

/**
 * Бейдж статуса письма. Презентационный компонент — образец
 * SubscriberStatusBadge/LeadStatusBadge.
 *
 * ЦВЕТА НЕСУТ СМЫСЛ, а не украшают:
 *   sent    — зелёный: письмо у релея, вмешательства не нужно;
 *   failed  — красный: НУЖНО вмешательство (кнопка «отправить повторно»);
 *   skipped — СЕРЫЙ, а НЕ красный: отправки не было осознанно (почта магазина не
 *             настроена либо у заказа нет адреса). Покрасив это в красный, мы
 *             заставили бы владельца магазина без SMTP видеть «аварию» в каждой
 *             строке журнала;
 *   pending — синий: отправка идёт прямо сейчас.
 *
 * Текст ошибки показывается подсказкой (title): в таблице он ломал бы вёрстку, а
 * оператору нужен именно он, когда письмо не ушло.
 */
const CLASSES: Record<MailLogStatus, string> = {
  pending: 'bg-blue-100 text-blue-800',
  sent: 'bg-green-100 text-green-800',
  failed: 'bg-red-100 text-red-800',
  skipped: 'bg-gray-100 text-gray-600',
};

function isMailStatus(value: string): value is MailLogStatus {
  return (MAIL_LOG_STATUSES as readonly string[]).includes(value);
}

export function MailStatusBadge({
  status,
  error,
}: {
  status: string;
  error?: string | null;
}) {
  const t = useTranslations();
  const known = isMailStatus(status);
  const cls = known ? CLASSES[status] : 'bg-gray-100 text-gray-600';
  const label = known ? t(`mail.status.${status}`) : status;

  return (
    <span
      className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${cls}`}
      title={error ?? undefined}
    >
      {label}
    </span>
  );
}
