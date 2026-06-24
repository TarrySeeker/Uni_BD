/**
 * Чистая логика формы модулей (docs/11 §5.4.5) — вынесена из ModulesForm.tsx,
 * чтобы тестироваться без DOM/Next (vitest env=node, как остальной слой настроек).
 *
 * Список переключаемых модулей выводится из ALL_MODULES (единственный источник
 * правды о составе платформы). Раньше форма перечисляла модули вручную и забыла
 * `payments` → его существующий оверрайд НЕ читался (initialState) и НЕ попадал в
 * отправляемый объект (save) → каждое сохранение МОЛЧА затирало module_overrides.payments.
 * Деривация из ALL_MODULES устраняет рассинхрон и делает payments управляемым из UI.
 *
 * CORE_MODULES — ключи ядра (always-on), которые нельзя переключать (self-lock guard).
 * Сейчас пуст: все ключи ALL_MODULES переключаемы.
 */

import { ALL_MODULES, type ModuleName } from '@/lib/config/modules';
import type { ModuleOverrides } from '@/lib/settings/schemas';

/** Три состояния переключателя модуля. */
export type TriState = 'inherit' | 'on' | 'off';

/** Человекочитаемые метки модулей формы. */
export const MODULE_LABELS: Record<ModuleName, string> = {
  catalog: 'Каталог',
  orders: 'Заказы и промокоды',
  cdek: 'Доставка (СДЭК)',
  cms: 'Контент (CMS)',
  payments: 'Оплата (Т-Банк)',
};

/** Ключи ядра, исключаемые из формы (always-on). Сейчас пуст. */
export const CORE_MODULES = new Set<string>();

/** Список модулей формы (имя + метка), производный от ALL_MODULES без core-ключей. */
export const FORM_MODULES: { name: ModuleName; label: string }[] = ALL_MODULES.filter(
  (name) => !CORE_MODULES.has(name),
).map((name) => ({ name, label: MODULE_LABELS[name] }));

/**
 * Начальное состояние переключателей из существующего module_overrides.
 * Читает КАЖДЫЙ модуль формы (включая payments) — отсутствие ключа = inherit,
 * true = on, false = off.
 */
export function initialModuleState(overrides: ModuleOverrides): Record<ModuleName, TriState> {
  const map = {} as Record<ModuleName, TriState>;
  for (const { name } of FORM_MODULES) {
    const v = overrides[name];
    map[name] = v === undefined ? 'inherit' : v ? 'on' : 'off';
  }
  return map;
}

/**
 * Собирает объект module_overrides для отправки в action из состояния формы.
 * inherit → ключ опускается (берётся env); on → true; off → false. Включает ВСЕ
 * модули формы, поэтому ранее установленный оверрайд (напр. payments) не теряется.
 */
export function buildModuleOverridesPayload(
  state: Record<ModuleName, TriState>,
): Record<string, boolean> {
  const moduleOverrides: Record<string, boolean> = {};
  for (const { name } of FORM_MODULES) {
    const s = state[name];
    if (s === 'on') moduleOverrides[name] = true;
    else if (s === 'off') moduleOverrides[name] = false;
    // inherit → поле отсутствует.
  }
  return moduleOverrides;
}

/** Метки модулей, которые форма собирается ВЫКЛЮЧИТЬ (для confirm-диалога). */
export function modulesBeingTurnedOff(state: Record<ModuleName, TriState>): string[] {
  return FORM_MODULES.filter(({ name }) => state[name] === 'off').map((m) => m.label);
}
