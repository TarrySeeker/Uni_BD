'use server';

/**
 * Тонкие серверные обёртки над Server Actions настроек (lib/settings/actions).
 *
 * Дают клиентским формам ('use client') стабильные серверные функции для прямого
 * вызова. Бизнес-логика (guard settings.manage → Zod → upsert → revalidate →
 * audit) — внутри обёрнутых actions; здесь лишь ре-экспорт под 'use server'.
 */

import {
  updateBrandingSettings as _updateBranding,
  updateCurrencyAndUnits as _updateCurrencyUnits,
  updateLegalAndContacts as _updateLegalContacts,
  updateCatalogOrdersSettings as _updateCatalogOrders,
  updateModuleOverrides as _updateModules,
  updateShopSeoSettings as _updateShopSeo,
  updateHomeAction as _updateHome,
  updateNavigationAction as _updateNavigation,
  uploadSettingsImageAction as _uploadSettingsImage,
  uploadStoreImageAction as _uploadStoreImage,
  resetSetting as _resetSetting,
} from '@/lib/settings/actions';
import type { ActionResult } from '@/lib/server/action';

export async function updateBrandingAction(input: unknown): Promise<ActionResult<unknown>> {
  return _updateBranding(input);
}
export async function updateCurrencyUnitsAction(input: unknown): Promise<ActionResult<unknown>> {
  return _updateCurrencyUnits(input);
}
export async function updateLegalContactsAction(input: unknown): Promise<ActionResult<unknown>> {
  return _updateLegalContacts(input);
}
export async function updateCatalogOrdersAction(input: unknown): Promise<ActionResult<unknown>> {
  return _updateCatalogOrders(input);
}
export async function updateModulesAction(input: unknown): Promise<ActionResult<unknown>> {
  return _updateModules(input);
}
export async function updateShopSeoAction(input: unknown): Promise<ActionResult<unknown>> {
  return _updateShopSeo(input);
}
export async function updateHomeContentAction(input: unknown): Promise<ActionResult<unknown>> {
  return _updateHome(input);
}
export async function updateNavigationContentAction(input: unknown): Promise<ActionResult<unknown>> {
  return _updateNavigation(input);
}
export async function uploadSettingsImageAction(
  formData: FormData,
): Promise<ActionResult<unknown>> {
  return _uploadSettingsImage(formData);
}
export async function uploadStoreImageAction(
  formData: FormData,
): Promise<ActionResult<unknown>> {
  return _uploadStoreImage(formData);
}
export async function resetSettingAction(input: unknown): Promise<ActionResult<unknown>> {
  return _resetSetting(input);
}
