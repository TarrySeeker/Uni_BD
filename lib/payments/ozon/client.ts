/**
 * HTTP-клиент Ozon Acquiring (по образцу lib/payments/tbank/client.ts).
 *
 * Все методы — POST JSON на {baseUrl}/v1/{method}. Подпись передаётся В ТЕЛЕ
 * (поле requestSign), заголовков авторизации нет.
 *
 * ⚠️ Ошибки Ozon приходят с кодом в ТЕЛЕ, а HTTP-статус может вводить в
 * заблуждение: неверная подпись — это code 16 при HTTP 400, то есть выглядит
 * как ошибка валидации. Поэтому разбираем тело, а не полагаемся на статус.
 */

import { logger } from "@/lib/logger";
import { OzonError } from "./errors";

const log = logger.child({ module: "payments/ozon" });

/** Таймаут запроса к банку. */
const REQUEST_TIMEOUT_MS = 20_000;

interface OzonErrorBody {
  code?: number;
  message?: string;
  details?: { requestId?: string }[];
}

/** Достаёт requestId из тела ошибки — его просит поддержка Ozon. */
function extractRequestId(body: OzonErrorBody | null): string | null {
  const d = body?.details;
  if (!Array.isArray(d)) return null;
  for (const item of d) {
    const rid = (item as { requestId?: string } | null)?.requestId;
    if (typeof rid === "string" && rid.length > 0) return rid;
  }
  return null;
}

/**
 * Выполняет подписанный POST к Ozon Acquiring.
 * Секреты НИКОГДА не логируются: пишем только имя метода, статус и requestId.
 */
export async function ozonPost<T>(
  baseUrl: string,
  method: string,
  // object, а не Record<string, unknown>: типизированные тела запросов
  // (OzonCreateOrderRequest и др.) — интерфейсы без индексной сигнатуры,
  // под Record они не подходят, а ослаблять их типизацию ради клиента незачем.
  body: object,
): Promise<T> {
  const url = `${baseUrl.replace(/\/+$/, "")}/v1/${method}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
      cache: "no-store",
    });
  } catch (e) {
    clearTimeout(timer);
    const reason = e instanceof Error && e.name === "AbortError" ? "таймаут" : "сетевая ошибка";
    log.error("ozon: запрос не выполнен", { method, reason });
    throw new OzonError(`Ozon недоступен (${reason}).`, { httpStatus: null });
  }
  clearTimeout(timer);

  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }

  if (!res.ok) {
    const errBody = parsed as OzonErrorBody | null;
    const code = typeof errBody?.code === "number" ? errBody.code : null;
    const requestId = extractRequestId(errBody);
    const err = new OzonError(errBody?.message ?? `HTTP ${res.status}`, {
      code,
      httpStatus: res.status,
      requestId,
    });
    // Неверная подпись — самая частая и самая непонятная по HTTP-статусу
    // ошибка интеграции. Логируем её отдельной строкой, чтобы не искать причину.
    if (err.isAuthError) {
      log.error("ozon: НЕВЕРНАЯ ПОДПИСЬ запроса (code 16) — проверьте порядок полей и ключи", {
        method, httpStatus: res.status, requestId,
      });
    } else {
      log.warn("ozon: ошибка API", { method, code, httpStatus: res.status, requestId });
    }
    throw err;
  }

  if (parsed === null) {
    // Часть методов штатно отвечает пустым объектом {} — это не ошибка.
    return {} as T;
  }
  return parsed as T;
}
