'use server';

/**
 * Server Action раздела «Настройки → Подарочные сертификаты» (ТЗ владельца п.11).
 *
 * Пайплайн тот же, что у остальных настроек: defineAction → право settings.manage
 * → Zod (giftSettingsSchema, анти-tamper: телу формы не верим) → upsert
 * shop_settings → инвалидация кеша настроек → revalidate → audit.
 *
 * Живёт рядом со своим экраном, а не в общей фабрике настроек: раздел добавлен
 * отдельной волной, а параллельные треки правят lib/settings/* — так изменение
 * не конфликтует. Контракт хранения общий (ключ `gift` в SETTING_KEYS), поэтому
 * сброс к умолчаниям работает штатной кнопкой ResetSettingButton.
 */

import { z } from 'zod';

import { defineAction, type ActionCtx } from '@/lib/server/action';
import { giftSettingsSchema } from '@/lib/settings/schemas';
import { getSetting, upsertSetting } from '@/lib/settings/repository';
import { invalidateSettingsCache } from '@/lib/config/settings';
import type { ActionResult } from '@/lib/server/action';

const GiftInputSchema = z.object({ gift: giftSettingsSchema });

const updateGiftSettings = defineAction({
  permission: 'settings.manage',
  input: GiftInputSchema,
  handler: async (data, ctx: ActionCtx) => {
    const before = await getSetting('gift');
    const row = await upsertSetting('gift', data.gift, ctx.user.id);
    invalidateSettingsCache();
    return {
      result: { key: 'gift' as const },
      // Политика влияет на выпуск кодов и на их показ в заказах админки.
      revalidate: ['/admin/settings', '/admin/settings/gift'],
      audit: {
        action: 'settings.gift.update',
        entityType: 'shop_settings',
        entityId: 'gift',
        before: before?.value,
        after: row.value,
      },
    };
  },
});

export async function updateGiftSettingsAction(raw: unknown): Promise<ActionResult<unknown>> {
  return updateGiftSettings(raw);
}
