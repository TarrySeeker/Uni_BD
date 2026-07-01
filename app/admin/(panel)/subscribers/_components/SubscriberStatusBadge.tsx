import {
  isSubscriberStatus,
  subscriberStatusLabel,
  type SubscriberStatus,
} from '@/lib/newsletter/status';

/**
 * Бейдж статуса подписчика (active/unsubscribed). Презентационный компонент —
 * образец LeadStatusBadge. Раньше статус печатался сырым английским словом
 * (находка #8). Неизвестный статус рисуется нейтрально (фолбэк-строка).
 */
const CLASSES: Record<SubscriberStatus, string> = {
  active: 'bg-green-100 text-green-800',
  unsubscribed: 'bg-gray-100 text-gray-600',
};

export function SubscriberStatusBadge({ status }: { status: string }) {
  const cls = isSubscriberStatus(status) ? CLASSES[status] : 'bg-gray-100 text-gray-600';
  return (
    <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${cls}`}>
      {subscriberStatusLabel(status)}
    </span>
  );
}
