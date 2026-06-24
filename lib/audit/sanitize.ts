/**
 * Санитизация чувствительных полей — единый allow/deny-list (docs/04 §2.4/§7).
 *
 * Вырезает пароли/хеши/токены/секреты из произвольных снимков/контекстов перед
 * записью в журнал аудита или структурный лог. Вынесено в отдельный модуль (а не
 * в audit/log.ts), чтобы переиспользоваться логгером (lib/logger.ts) БЕЗ связности
 * с тяжёлым модулем аудита (audit/log.ts тянет БД) и без поломки при его мокинге
 * в тестах. ADR-015 §6.3: «логгер применяет тот же allow/deny-list, что и аудит».
 */

/**
 * Список чувствительных ключей, которые НИКОГДА не пишутся в журнал/лог.
 * Сравнение — без учёта регистра и по вхождению подстроки (`sessionToken`,
 * `refresh_token`, `API_SECRET`, `authorization` и т.п. тоже отсекаются).
 */
const SENSITIVE_KEYS: readonly string[] = [
  'password',
  'password_hash',
  'passwordhash',
  'token',
  'secret',
  'credentials',
  'apikey',
  'api_key',
  'private_key',
  'privatekey',
  'authorization',
];

/** true, если имя ключа содержит любой из чувствительных маркеров (регистронезависимо). */
export function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  return SENSITIVE_KEYS.some((marker) => lower.includes(marker));
}

/**
 * Маскирование учётных данных в userinfo URL внутри произвольной строки
 * (бэклог Этапа 6, пункт b). Закрывает риск: секрет, попавший в ЗНАЧЕНИЕ под
 * НЕсекретным ключом (например connection string `postgres://user:pass@host`
 * под ключом `url`/`note`), не вырезается маскированием по имени ключа.
 *
 * Маскируется ТОЛЬКО пароль в userinfo (`scheme://[user]:PASSWORD@host` → `:***@`),
 * имя пользователя и остальной URL сохраняются. Консервативно: трогаем лишь
 * строки с `scheme://…:…@` — обычные URL с портом (`host:5432`), email и
 * SSH-строки (`git@host`) не затрагиваются (нет ложных срабатываний).
 */
const URL_USERINFO_RE = /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/\s:@]*:)[^/\s@]+(@)/g;

export function scrubSecretsInString(value: string): string {
  return value.replace(URL_USERINFO_RE, '$1***$2');
}

/**
 * Рекурсивно санитизирует произвольное значение (объект/массив/скаляр).
 * Не мутирует вход; вырезает ключи, помеченные isSensitiveKey.
 */
export function sanitizeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitizeValue);
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveKey(key)) {
        continue;
      }
      out[key] = sanitizeValue(val);
    }
    return out;
  }
  // Строка-значение: маскируем учётные данные, вшитые в userinfo URL (пункт b).
  if (typeof value === 'string') {
    return scrubSecretsInString(value);
  }
  return value;
}

/**
 * Чистая функция санитизации снимка состояния.
 * Вырезает чувствительные ключи рекурсивно, не мутируя вход.
 * @returns очищенную копию или `null`, если на входе null/undefined.
 */
export function sanitize(
  data?: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (data === null || data === undefined) {
    return null;
  }
  return sanitizeValue(data) as Record<string, unknown>;
}
