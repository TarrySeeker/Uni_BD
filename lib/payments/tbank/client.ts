/**
 * Низкоуровневый HTTP-клиент T-API Т-Банка (docs/15 §2 «client.ts», порт
 * lib/cdek/client.ts).
 *
 * Зона ответственности — транспорт: один подписанный запрос к /v2/*.
 *   • Базовый URL — из конфигурации (TbankConfig.baseUrl).
 *   • POST application/json; тело подписывается полем Token (token.ts) перед
 *     отправкой — у Т-Банка НЕТ долгоживущего токена (docs/15 §2.2), подпись на
 *     каждом запросе, поэтому token-cache/Redis НЕ нужны (упрощает клиент).
 *   • Суммы — в КОПЕЙКАХ (передаёт вызывающий; клиент не считает деньги).
 *   • Таймаут на запрос (AbortController), ретраи на сеть/5xx.
 *   • Бизнес-ошибки (Success:false / ErrorCode≠'0') НЕ ретраятся — это не
 *     транспортная ошибка (вызывающий разбирает ErrorCode).
 *
 * АРХИТЕКТУРНОЕ РЕШЕНИЕ (как СДЭК): TbankClient — ВСЕГДА реальный (ходит в сеть).
 * Mock-данные живут в lib/payments/tbank/mock/* и НЕ проходят через client.
 * В mock-режиме client НЕ инстанцируется (manager.client кидает TbankError при
 * обращении — баг вызывающего). См. manager.ts.
 */

import type { TbankConfig } from './config';
import { TbankError } from './errors';
import { signToken } from './token';
import type { TbankPayload } from './types';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_NETWORK_RETRIES = 2;
/** Задержки между сетевыми ретраями (мс), по индексу попытки. */
const RETRY_DELAYS_MS = [250, 500] as const;

/** Опции одного запроса. */
export interface TbankRequestOptions {
  /** Таймаут запроса, мс (дефолт 30000). */
  timeoutMs?: number;
  /** Сетевых ретраев (дефолт 2; задержки 250/500мс). */
  maxNetworkRetries?: number;
}

/** Публичный интерфейс клиента. */
export interface ITbankClient {
  /**
   * Подписывает тело (Token) и шлёт POST на /v2/<method>. TerminalKey должен уже
   * присутствовать в body. Возвращает декодированный JSON-ответ T-API.
   */
  call<T = unknown>(method: string, body: TbankPayload, opts?: TbankRequestOptions): Promise<T>;
}

/** Параметры конструктора клиента. */
export interface TbankClientOptions {
  config: TbankConfig;
  /** fetch для тестов (vi.fn). По умолчанию глобальный fetch. */
  fetchImpl?: typeof fetch;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Признак сетевой ошибки fetch (включая abort по таймауту). */
function isNetworkError(err: unknown): boolean {
  return err instanceof TypeError || (err instanceof Error && err.name === 'AbortError');
}

/**
 * Реальный HTTP-клиент Т-Банка. Ходит в сеть через fetch; в mock-режиме НЕ
 * используется (см. шапку и manager.ts).
 */
export class TbankClient implements ITbankClient {
  private readonly baseUrl: string;
  private readonly password: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: TbankClientOptions) {
    const { config } = opts;
    if (!config.terminalKey || !config.password) {
      throw new TbankError(
        'tbank_client_no_credentials',
        'TbankClient требует TBANK_TERMINAL_KEY/TBANK_PASSWORD (в mock-режиме клиент не используется).',
      );
    }
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.password = config.password;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private buildUrl(method: string): string {
    const m = method.startsWith('/') ? method.slice(1) : method;
    return `${this.baseUrl}/${m}`;
  }

  async call<T = unknown>(
    method: string,
    body: TbankPayload,
    opts: TbankRequestOptions = {},
  ): Promise<T> {
    // Подпись Token проставляется поверх корневых полей тела (token.ts исключает
    // вложенные Receipt/DATA автоматически).
    const signed: TbankPayload = { ...body, Token: signToken(body, this.password) };
    return this.doRequest<T>(method, signed, opts, 0);
  }

  private async doRequest<T>(
    method: string,
    signedBody: TbankPayload,
    opts: TbankRequestOptions,
    attempt: number,
  ): Promise<T> {
    const url = this.buildUrl(method);
    const maxRetries = opts.maxNetworkRetries ?? DEFAULT_MAX_NETWORK_RETRIES;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(signedBody),
        signal: controller.signal,
      });
    } catch (err) {
      if (isNetworkError(err) && attempt < maxRetries) {
        await sleep(RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)]);
        return this.doRequest<T>(method, signedBody, opts, attempt + 1);
      }
      throw new TbankError(
        'tbank_network_error',
        `Tbank network error on ${method}: ${(err as Error).message}`,
      );
    } finally {
      clearTimeout(timer);
    }

    // 5xx — ретрай как сетевую ошибку (до maxRetries).
    if (res.status >= 500 && attempt < maxRetries) {
      await sleep(RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)]);
      return this.doRequest<T>(method, signedBody, opts, attempt + 1);
    }

    const text = await res.text();
    let decoded: unknown = {};
    if (text) {
      try {
        decoded = JSON.parse(text);
      } catch {
        throw new TbankError(
          'tbank_invalid_json',
          `Tbank invalid JSON on ${method}: ${text.slice(0, 500)}`,
          { httpStatus: res.status },
        );
      }
    }

    if (res.status >= 400) {
      throw new TbankError('tbank_http_error', `Tbank HTTP ${res.status} on ${method}`, {
        httpStatus: res.status,
        tbankErrorCode: extractErrorCode(decoded),
      });
    }

    return decoded as T;
  }
}

/** Достаёт ErrorCode из тела ответа Т-Банка (для диагностики транспортных ошибок). */
function extractErrorCode(decoded: unknown): string | null {
  if (decoded && typeof decoded === 'object' && 'ErrorCode' in decoded) {
    const code = (decoded as { ErrorCode: unknown }).ErrorCode;
    return typeof code === 'string' ? code : null;
  }
  return null;
}
