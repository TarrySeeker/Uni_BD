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

/**
 * Ключи каталога для подписей статусов — ЕДИНЫЙ источник для серверного бейджа и
 * для клиентской «марки» (GiftStatusStamp в форме карточки). Держим карту здесь,
 * чтобы у клиента не завелась вторая копия подписей: минор аудита №4 возник
 * ровно из-за того, что карточка печатала сырое служебное значение ('depleted')
 * вместо локализованной подписи, хотя бейдж рядом её уже знал.
 */
export const GIFT_STATUS_LABEL_KEYS: Record<GiftCertificateStatus, string> = {
  active: 'common.states.active',
  depleted: 'giftCertificates.giftStatusBadge.depleted',
  disabled: 'common.states.disabled',
  expired: 'giftCertificates.giftStatusBadge.expired',
};

/** Классы бейджа по статусу (фолбэк — нейтральный серый). */
export function giftStatusClasses(status: string): string {
  return (CLASSES as Record<string, string>)[status] ?? 'bg-gray-100 text-gray-600';
}

export async function GiftStatusBadge({ status }: { status: string }) {
  const t = await getTranslations();
  const key = (GIFT_STATUS_LABEL_KEYS as Record<string, string>)[status];
  return (
    <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${giftStatusClasses(status)}`}>
      {key ? t(key) : status}
    </span>
  );
}
