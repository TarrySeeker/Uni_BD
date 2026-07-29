'use client';

import { useTranslations } from 'next-intl';

import { GIFT_STATUS_LABEL_KEYS, giftStatusClasses } from './GiftStatusBadge';

/**
 * КЛИЕНТСКИЙ близнец GiftStatusBadge (минор аудита №4).
 *
 * Зачем отдельный компонент: GiftStatusBadge — серверный (async, getTranslations)
 * и в клиентскую форму карточки его не вставить. Раньше карточка обходила это
 * печатью СЫРОГО служебного значения (`{cert.status}` → «depleted») рядом с
 * локализованной подписью поля.
 *
 * 🔴 Второй копии подписей здесь нет: ключи каталога и классы импортируются из
 * GiftStatusBadge — иначе бейдж в списке и марка в карточке разъехались бы при
 * добавлении статуса.
 */
export function GiftStatusStamp({ status }: { status: string }) {
  const t = useTranslations();
  const key = (GIFT_STATUS_LABEL_KEYS as Record<string, string>)[status];
  return (
    <span
      className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${giftStatusClasses(status)}`}
    >
      {key ? t(key) : status}
    </span>
  );
}
