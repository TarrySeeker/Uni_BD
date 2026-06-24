'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import type { ActionResult } from '@/lib/server/action';
import { type ModuleName } from '@/lib/config/modules';
import type { ModuleOverrides } from '@/lib/settings/schemas';

import { updateModulesAction } from './form-actions';
import { errorMessage } from './action-result';
import {
  FORM_MODULES as MODULES,
  initialModuleState as initialState,
  buildModuleOverridesPayload,
  modulesBeingTurnedOff,
  type TriState,
} from './modules-form-state';

/**
 * Форма оверрайда модулей (docs/11 §5.4.5). Три состояния на модуль:
 *   inherit — наследовать env (поле отсутствует в module_overrides);
 *   on      — принудительно включить;
 *   off     — принудительно выключить.
 * Показывает env-значение (включён ли модуль env-набором). «Настройки» — core,
 * в список НЕ входит (self-lock guard, §5.4.5).
 *
 * Список модулей/начальное состояние/payload — из modules-form-state.ts (чистая
 * логика, тестируемая без DOM). Список выводится из ALL_MODULES (включая payments),
 * поэтому существующий оверрайд читается и сохраняется целиком — затирания нет.
 */
type Fail = Extract<ActionResult<unknown>, { ok: false }>;

export function ModulesForm({
  overrides,
  envEnabled,
}: {
  overrides: ModuleOverrides;
  /** Какие модули включены БАЗОВЫМ env-набором (для подсказки «env: вкл/выкл»). */
  envEnabled: ModuleName[];
}) {
  const router = useRouter();
  const [error, setError] = useState<Fail | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [success, setSuccess] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [state, setState] = useState<Record<ModuleName, TriState>>(() => initialState(overrides));

  const envSet = new Set(envEnabled);

  async function save() {
    // Подтверждение при выключении модулей: выключение «Каталога»/«Заказов» и т.п.
    // скрывает разделы и может «сломать» витрину — предупреждаем заранее.
    const turningOff = modulesBeingTurnedOff(state);
    if (turningOff.length > 0) {
      const ok = window.confirm(
        `Выключить модули: ${turningOff.join(', ')}? Соответствующие разделы админки и функции на сайте станут недоступны. Продолжить?`,
      );
      if (!ok) return;
    }
    setPending(true);
    setError(null);
    setWarnings([]);
    setSuccess(null);
    // Включает ВСЕ модули формы (в т.ч. payments) → ранее заданный оверрайд не теряется.
    const moduleOverrides = buildModuleOverridesPayload(state);
    const result = await updateModulesAction({ moduleOverrides });
    setPending(false);
    if (result.ok) {
      setSuccess('Состав модулей обновлён.');
      const data = result.data as { warnings?: string[] };
      if (data?.warnings?.length) setWarnings(data.warnings);
      router.refresh();
    } else {
      setError(result);
    }
  }

  const warningLabel = (code: string): string =>
    code === 'cms_has_published_pages'
      ? 'У модуля «Контент» есть опубликованные страницы. Они не удалены — лишь скрыты до повторного включения.'
      : code;

  return (
    <div>
      {error ? (
        <div role="alert" className="mb-4 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {errorMessage(error)}
        </div>
      ) : null}
      {success ? (
        <div role="status" className="mb-4 rounded border border-green-200 bg-green-50 p-3 text-sm text-green-700">
          {success}
        </div>
      ) : null}
      {warnings.length > 0 ? (
        <div role="status" className="mb-4 rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          <ul className="list-disc pl-5">
            {warnings.map((w) => (
              <li key={w}>{warningLabel(w)}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <p className="mb-3 text-sm text-gray-500">
        «Настройки» — системный раздел и всегда доступен (его нельзя отключить).
      </p>

      <div className="space-y-3">
        {MODULES.map(({ name, label }) => (
          <div key={name} className="flex items-center justify-between rounded border border-gray-200 p-3">
            <div>
              <div className="text-sm font-medium text-gray-800">{label}</div>
              <div className="text-xs text-gray-500">
                по умолчанию: {envSet.has(name) ? 'включён' : 'выключен'}
              </div>
            </div>
            <select
              aria-label={`Состояние модуля ${label}`}
              value={state[name]}
              onChange={(e) => setState((s) => ({ ...s, [name]: e.target.value as TriState }))}
              className="rounded border border-gray-300 px-3 py-2 text-sm"
            >
              <option value="inherit">Как по умолчанию</option>
              <option value="on">Включить</option>
              <option value="off">Выключить</option>
            </select>
          </div>
        ))}
      </div>

      <div className="mt-6 flex items-center gap-3 border-t border-gray-200 pt-4">
        <button type="button" onClick={save} disabled={pending}
          className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50">
          {pending ? 'Сохранение…' : 'Сохранить состав модулей'}
        </button>
      </div>
    </div>
  );
}
