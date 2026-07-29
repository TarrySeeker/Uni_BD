/**
 * GET /api/storefront/v1/settings — публичные настройки магазина (docs/11 §5.4.4).
 *
 * core-always-on: отдаётся независимо от ADMIK_MODULES (runStorefront с
 * options.module=null — гейт по модулю пропускается; auth/rate-limit сохраняются).
 * toPublicSettingsDto скрывает приватные поля (bankDetails, og_image_key,
 * updated_by/updated_at, module_overrides). Деньги — в копейках.
 *
 * 🔴 Аудит major №20: DTO несёт `delivery.methods` — ДОСТУПНЫЕ способы доставки.
 * Считаем их по АВТОРИТЕТНОМУ гейту модулей (env ⊕ module_overrides), тому же,
 * что гейтит роуты /delivery/cdek/*: иначе витрина предлагает СДЭК, а роуты
 * отвечают 404 и покупатель упирается в тупик. Наружу уходит только результат
 * (список способов) — сам набор модулей и module_overrides остаются скрытыми.
 */

import { runStorefront, jsonData, handlePreflight } from '@/lib/storefront/response';
import { getEffectiveSettings, getEffectiveModuleSet } from '@/lib/config/settings';
import { toPublicSettingsDto } from '@/lib/storefront/settings-dto';
import { resolveStorefrontLocale } from '@/lib/storefront/locale';
import { getStorage } from '@/lib/storage';

export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  return runStorefront(
    req,
    async ({ cors }) => {
      const eff = await getEffectiveSettings();
      // Возможности магазина: cdek-способы доставки предлагаем витрине ровно
      // тогда, когда модуль реально включён (иначе /delivery/cdek/* → 404).
      const modules = await getEffectiveModuleSet();
      // Резолв языка запроса (?locale= → Accept-Language → default), fail-safe.
      // Тексты настроек локализуются оверлеем content_i18n; defaultLocale берём из
      // эффективных настроек (единый источник, whitelist уже применён).
      const { locale } = await resolveStorefrontLocale(req);
      // Изображения главной (home.*) отдаём как публичные URL: ключи S3 наружу
      // не раскрываем (инвариант, зеркально каталог-медиа/CMS).
      const storage = getStorage();
      return jsonData(
        toPublicSettingsDto(
          eff,
          (k) => storage.url(k),
          { locale, defaultLocale: eff.i18n.defaultLocale },
          { cdekEnabled: modules.has('cdek') },
        ),
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
