/**
 * HTTP-клиент АТОЛ Pay Ecom (по образцу lib/payments/ozon/client.ts).
 *
 * 🔴 ГЛАВНАЯ ДЕТАЛЬ, СТОИВШАЯ ОТЛАДКИ: заголовок авторизации.
 * Документация АТОЛа (стр. 14) предписывает `Authorization: <access_token>` —
 * и ровно так боевой API отвечает 403 AUTH_ERROR. Работает только
 * `Authorization: Bearer <token>`. Проверено живыми запросами 15.09.2026:
 * выдуманный токен → NO_AUTH_DATA (412), боевой без «Bearer» → AUTH_ERROR (403),
 * с «Bearer» → осмысленный ответ. Писать по документу = искать ошибку не там.
 *
 * Ошибки приходят кодом в ТЕЛЕ (`errorCode`), поэтому разбираем тело, а не
 * полагаемся на HTTP-статус.
 */

import { logger } from '@/lib/logger';
import { AtolError } from './errors';

const log = logger.child({ module: 'payments/atol' });

/** Таймаут запроса к эквайеру. */
const REQUEST_TIMEOUT_MS = 20_000;

interface AtolErrorBody {
  errorCode?: string;
  errorMessage?: string;
  status?: string;
}

/** Собирает адрес метода, не теряя и не удваивая слэши. */
function buildUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

/**
 * Выполняет запрос к АТОЛ Pay.
 *
 * Секреты НИКОГДА не логируются: пишем только метод, путь и HTTP-статус.
 * Токен не попадает ни в сообщение об ошибке, ни в лог.
 */
export async function atolRequest<T>(
  baseUrl: string,
  token: string,
  method: 'GET' | 'POST',
  path: string,
  // object, а не Record<string, unknown>: типизированные тела запросов —
  // интерфейсы без индексной сигнатуры, и структурно они под Record не подходят.
  body?: object,
): Promise<T> {
  const url = buildUrl(baseUrl, path);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        // 🔴 Именно «Bearer», вопреки документации. См. шапку файла.
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
      signal: controller.signal,
    });
  } catch (err) {
    const reason = err instanceof Error && err.name === 'AbortError' ? 'таймаут' : 'сеть';
    log.error('atol: запрос не выполнен', { path, method, reason });
    throw new AtolError(`АТОЛ Pay недоступен (${reason}).`);
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let parsed: unknown = null;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      // Нечитаемое тело при неуспешном статусе — всё равно ошибка, но описать
      // её можно только статусом.
      if (!res.ok) {
        log.error('atol: неразбираемый ответ', { path, httpStatus: res.status });
        throw new AtolError(`АТОЛ Pay вернул неразбираемый ответ (HTTP ${res.status}).`, {
          httpStatus: res.status,
        });
      }
      return {} as T;
    }
  }

  const errBody = (parsed ?? {}) as AtolErrorBody;
  const errorCode = typeof errBody.errorCode === 'string' ? errBody.errorCode : null;

  // Ошибка распознаётся по errorCode в теле: у АТОЛа она может прийти и с
  // «успешным» HTTP-статусом, и наоборот.
  if (errorCode || !res.ok) {
    const message = errBody.errorMessage ?? `Ошибка АТОЛ Pay (HTTP ${res.status}).`;
    const error = new AtolError(message, { code: errorCode, httpStatus: res.status });

    if (error.isAuthError) {
      // Отдельная строка: самая частая причина — заголовок без «Bearer».
      log.error('atol: отказ авторизации — проверьте токен и формат заголовка (нужен Bearer)', {
        path,
        httpStatus: res.status,
        errorCode,
      });
    } else {
      log.warn('atol: ошибка API', { path, httpStatus: res.status, errorCode });
    }
    throw error;
  }

  return (parsed ?? {}) as T;
}
