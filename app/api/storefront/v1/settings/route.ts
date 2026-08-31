/**
 * GET /api/storefront/v1/settings — публичные настройки магазина (docs/11 §5.4.4).
 *
 * core-always-on: отдаётся независимо от ADMIK_MODULES (runStorefront с
 * options.module=null — гейт по модулю пропускается; auth/rate-limit сохраняются).
 * toPublicSettingsDto скрывает приватные поля (bankDetails, og_image_key,
 * updated_by/updated_at, module_overrides). Деньги — в копейках.
 */

import { runStorefront, jsonData, handlePreflight } from '@/lib/storefront/response';
import { getEffectiveSettings } from '@/lib/config/settings';
import { toPublicSettingsDto } from '@/lib/storefront/settings-dto';
import { isModuleEffectivelyEnabled } from '@/lib/config/settings';
import { getTbankConfig, resolveTbankMock } from '@/lib/payments/tbank/config';

/**
 * Готов ли магазин принимать оплату на сайте.
 *
 * `getTbankConfig` в production НАМЕРЕННО бросает, если модуль оплаты включён,
 * а боевых ключей нет: mock-оплата на бою помечала бы заказы оплаченными без
 * списания. Для справочного эндпоинта настроек это не ошибка, а ответ «нет»:
 * ронять весь /settings (а с ним подвал, контакты и тексты согласий на витрине)
 * из-за ненастроенного эквайринга нельзя.
 */
async function isOnlinePaymentAvailable(): Promise<boolean> {
  if (!(await isModuleEffectivelyEnabled('payments'))) return false;
  try {
    return !resolveTbankMock(getTbankConfig());
  } catch {
    return false;
  }
}
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
      // Онлайн-оплата считается доступной, только когда модуль включён И
      // ключи терминала заданы. При пустых ключах приём платежей на стороне
      // админки эмулируется — предлагать такой способ покупателю нельзя.
      const onlinePaymentAvailable = await isOnlinePaymentAvailable();

      return jsonData(
        toPublicSettingsDto(eff, (k) => storage.url(k), { onlinePaymentAvailable }),
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
