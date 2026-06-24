import { describe, it, expect } from 'vitest';

import {
  FORM_MODULES,
  initialModuleState,
  buildModuleOverridesPayload,
  modulesBeingTurnedOff,
  type TriState,
} from '@/app/admin/(panel)/settings/_components/modules-form-state';
import { ALL_MODULES, type ModuleName } from '@/lib/config/modules';
import type { ModuleOverrides } from '@/lib/settings/schemas';

/**
 * Тесты чистой логики формы модулей (баг #2 волны 5).
 *
 * До фикса MODULES в форме перечислял только catalog/orders/cdek/cms — payments
 * отсутствовал. initialState/save итерировали лишь по MODULES, поэтому payments не
 * читался из существующего module_overrides и не попадал в отправляемый объект →
 * upsert МОЛЧА затирал payments-оверрайд при каждом сохранении.
 *
 * Эти тесты фиксируют: список формы выводится из ALL_MODULES (включает payments),
 * payment-оверрайд читается и СОХРАНЯЕТСЯ (round-trip без потери).
 */

describe('settings/modules-form-state — список модулей формы', () => {
  it('включает все ALL_MODULES (в т.ч. payments) — нет рассинхрона', () => {
    const names = FORM_MODULES.map((m) => m.name).sort();
    expect(names).toEqual([...ALL_MODULES].sort());
  });

  it('payments присутствует в форме с человекочитаемой меткой', () => {
    const payments = FORM_MODULES.find((m) => m.name === 'payments');
    expect(payments).toBeDefined();
    expect(payments?.label).toBe('Оплата (Т-Банк)');
  });

  it('у каждого модуля непустая метка', () => {
    for (const { label } of FORM_MODULES) {
      expect(label.length).toBeGreaterThan(0);
    }
  });
});

describe('settings/modules-form-state — initialModuleState', () => {
  it('читает существующий payments-оверрайд (раньше игнорировался)', () => {
    const overrides: ModuleOverrides = { payments: false };
    const state = initialModuleState(overrides);
    expect(state.payments).toBe('off');
  });

  it('on/off/inherit маппинг по true/false/undefined', () => {
    const overrides: ModuleOverrides = { catalog: true, orders: false };
    const state = initialModuleState(overrides);
    expect(state.catalog).toBe('on');
    expect(state.orders).toBe('off');
    // не заданные ключи → inherit.
    expect(state.cdek).toBe('inherit');
    expect(state.cms).toBe('inherit');
    expect(state.payments).toBe('inherit');
  });
});

describe('settings/modules-form-state — buildModuleOverridesPayload', () => {
  it('on→true, off→false, inherit опускается', () => {
    const state: Record<ModuleName, TriState> = {
      catalog: 'on',
      orders: 'off',
      cdek: 'inherit',
      cms: 'inherit',
      payments: 'inherit',
    };
    expect(buildModuleOverridesPayload(state)).toEqual({ catalog: true, orders: false });
  });

  it('РЕГРЕСС бага #2: payments-оверрайд НЕ теряется при сохранении', () => {
    // Пользователь ранее выключил payments; открыл форму и сохранил, ничего больше
    // не трогая. До фикса payments отсутствовал в MODULES → выпадал из payload →
    // upsert затирал его. Теперь он сохраняется как был.
    const overrides: ModuleOverrides = { payments: false };
    const state = initialModuleState(overrides);
    const payload = buildModuleOverridesPayload(state);
    expect(payload.payments).toBe(false);
  });

  it('round-trip полного оверрайда сохраняет все модули', () => {
    const overrides: ModuleOverrides = {
      catalog: true,
      orders: false,
      cdek: true,
      cms: false,
      payments: true,
    };
    const payload = buildModuleOverridesPayload(initialModuleState(overrides));
    expect(payload).toEqual(overrides);
  });
});

describe('settings/modules-form-state — modulesBeingTurnedOff', () => {
  it('возвращает метки модулей в состоянии off (для confirm)', () => {
    const state: Record<ModuleName, TriState> = {
      catalog: 'off',
      orders: 'inherit',
      cdek: 'on',
      cms: 'inherit',
      payments: 'off',
    };
    const labels = modulesBeingTurnedOff(state);
    expect(labels).toContain('Каталог');
    expect(labels).toContain('Оплата (Т-Банк)');
    expect(labels).not.toContain('Доставка (СДЭК)');
  });
});
