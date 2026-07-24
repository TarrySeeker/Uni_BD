import { getTranslations } from 'next-intl/server';

import type { GiftCertificateStatus } from '@/lib/gift-certificates';

/**
 * Бейдж статуса сертификата (active/depleted/disabled/expired). Презентационный.
 * Неизвестный статус рисуется нейтрально (фолбэк).
 */
const CLASSES: Record<GiftCertificateStatus, string> = {
  active: 'bg-green-100 text-green-800',
  depleted: 'bg-gray-100 text-gray-600',
  disabled: 'bg-red-100 text-red-800',
  expired: 'bg-amber-100 text-amber-800',
};

export async function GiftStatusBadge({ status }: { status: string }) {
  const t = await getTranslations();
  const labels: Record<string, string> = {
    active: t('common.states.active'),
    depleted: t('giftCertificates.giftStatusBadge.depleted'),
    disabled: t('common.states.disabled'),
    expired: t('giftCertificates.giftStatusBadge.expired'),
  };
  const cls = (CLASSES as Record<string, string>)[status] ?? 'bg-gray-100 text-gray-600';
  return (
    <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${cls}`}>
      {labels[status] ?? status}
    </span>
  );
}
