import { isIP } from 'node:net';

/**
 * Нормализация клиентского IP из заголовков прокси — dependency-free.
 *
 * НАЗНАЧЕНИЕ (фикс major-бага reliability): IP, извлечённый из заголовков
 * `X-Forwarded-For` / `X-Real-IP`, попадает в колонки типа `inet`
 * (`sessions.ip`, `audit_log.ip`). Эти заголовки подконтрольны клиенту/прокси:
 * подделать или прислать мусор тривиально. Если записать сырую строку в `inet`,
 * Postgres падает на касте — а это ломает INSERT сессии и, как следствие, ВЕСЬ
 * вход в систему (createSession бросает на любом кривом X-Forwarded-For).
 *
 * Поэтому кандидат на IP ВАЛИДИРУЕТСЯ через `node:net` `isIP()` ДО любого
 * inet-INSERT. Невалидное значение НЕ доверяется и отбрасывается (→ undefined),
 * после чего слой БД пишет `null` (колонки `inet` nullable). Диагностический
 * IP не критичен для корректности — лучше потерять его, чем сломать логин/аудит.
 *
 * Функция чистая (без next/headers, БД, I/O) → тестируется в любом окружении.
 *
 * @param forwarded значение заголовка `X-Forwarded-For` (может быть списком
 *   «client, proxy1, proxy2» — берётся ПЕРВЫЙ сегмент, реальный клиент);
 * @param realIp    значение запасного заголовка `X-Real-IP`;
 * @returns валидный IPv4/IPv6 либо `undefined`, если ни один кандидат не валиден.
 */
export function normalizeClientIp(
  forwarded: string | null | undefined,
  realIp: string | null | undefined,
): string | undefined {
  // X-Forwarded-For: «client, proxy1, proxy2» → реальный клиент — первый сегмент.
  const xffCandidate = forwarded?.split(',')[0]?.trim();
  if (xffCandidate && isIP(xffCandidate) !== 0) {
    return xffCandidate;
  }

  // Fallback на X-Real-IP, если XFF отсутствует или невалиден.
  const realCandidate = realIp?.trim();
  if (realCandidate && isIP(realCandidate) !== 0) {
    return realCandidate;
  }

  // Ни один кандидат не валиден → не доверяем мусору, отдаём undefined.
  return undefined;
}
