/**
 * Система включения/выключения модулей платформы.
 *
 * Каждый интернет-магазин может работать с разным набором модулей.
 * Набор задаётся переменной окружения ADMIK_MODULES (csv).
 * Если переменная не задана — включены все модули по умолчанию.
 *
 * Пример: ADMIK_MODULES=catalog,orders,cdek
 */

export type ModuleName = 'catalog' | 'orders' | 'cdek' | 'cms' | 'payments';

/** Все известные платформе модули. */
export const ALL_MODULES: readonly ModuleName[] = [
  'catalog',
  'orders',
  'cdek',
  'cms',
  'payments',
] as const;

function isModuleName(value: string): value is ModuleName {
  return (ALL_MODULES as readonly string[]).includes(value);
}

/**
 * Возвращает список включённых модулей на основе переменной окружения.
 * Неизвестные имена модулей игнорируются.
 */
export function getEnabledModules(
  env: Record<string, string | undefined> = process.env,
): ModuleName[] {
  const raw = env.ADMIK_MODULES?.trim();

  // По умолчанию (переменная не задана или пуста) — все модули.
  if (!raw) {
    return [...ALL_MODULES];
  }

  const requested = raw
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name.length > 0);

  // Сохраняем уникальность и только известные модули.
  const enabled = new Set<ModuleName>();
  for (const name of requested) {
    if (isModuleName(name)) {
      enabled.add(name);
    }
  }

  return [...enabled];
}

/**
 * Проверяет, включён ли модуль.
 */
export function isModuleEnabled(
  name: ModuleName,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return getEnabledModules(env).includes(name);
}
