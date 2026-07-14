import type { GiftCertificateStatus } from '@/lib/gift-certificates';

/**
 * Бейдж статуса сертификата (active/depleted/disabled/expired). Презентационный.
 * Неизвестный статус рисуется нейтрально (фолбэк).
 */
const LABELS: Record<GiftCertificateStatus, string> = {
  active: 'Активен',
  depleted: 'Исчерпан',
  disabled: 'Отключён',
  expired: 'Истёк',
};

const CLASSES: Record<GiftCertificateStatus, string> = {
  active: 'bg-green-100 text-green-800',
  depleted: 'bg-gray-100 text-gray-600',
  disabled: 'bg-red-100 text-red-800',
  expired: 'bg-amber-100 text-amber-800',
};

export function giftStatusLabel(status: string): string {
  return (LABELS as Record<string, string>)[status] ?? status;
}

export function GiftStatusBadge({ status }: { status: string }) {
  const cls = (CLASSES as Record<string, string>)[status] ?? 'bg-gray-100 text-gray-600';
  return (
    <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${cls}`}>
      {giftStatusLabel(status)}
    </span>
  );
}
