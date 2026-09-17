/**
 * GET /api/storefront/v1/settings — публичные настройки магазина (docs/11 §5.4.4).
 *
 * core-always-on: отдаётся независимо от ADMIK_MODULES (runStorefront с
 * options.module=null — гейт по модулю пропускается; auth/rate-limit сохраняются).
 * toPublicSettingsDto скрывает приватные поля (bankDetails, og_image_key,
 * updated_by/updated_at, module_overrides). Деньги — в копейках.
 */

import { runStorefront, jsonData, handlePreflight } from '@/lib/storefront/response';
import { getEffectiveSettings, isModuleEffectivelyEnabled } from '@/lib/config/settings';
import { toPublicSettingsDto } from '@/lib/storefront/settings-dto';
import { getStorage } from '@/lib/storage';

export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  return runStorefront(
    req,
    async ({ cors }) => {
      const eff = await getEffectiveSettings();
      // Изображения главной (home.*) отдаём как публичные URL: ключи S3 наружу
      // не раскрываем (инвариант, зеркально каталог-медиа/CMS).
      const storage = getStorage();
      // 🔴 Онлайн-оплата честна для витрины ТОЛЬКО с учётом модуля payments:
      // бизнес-тумблер checkout.onlinePaymentEnabled сам по себе ничего не
      // значит, если модуль выключен — createOrder отклонит заказ с
      // payments_disabled. Отдаём наружу ЭФФЕКТИВНЫЙ флаг, иначе витрина
      // покажет кнопку оплаты, а оформление упадёт.
      const paymentsModuleEnabled = await isModuleEffectivelyEnabled('payments');
      return jsonData(
        toPublicSettingsDto(eff, (k) => storage.url(k), paymentsModuleEnabled),
        {},
        cors,
      );
    },
    { module: null },
  );
}

export async function OPTIONS(req: Request): Promise<Response> {
  return handlePreflight(req);
}
