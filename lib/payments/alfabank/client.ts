/**
 * Низкоуровневый HTTP-клиент REST-API Альфа-Банка (RBS, порт paykeeper/client.ts +
 * tbank/client.ts на REST-эквайринг с параметрами userName/password).
 *
 * Зона ответственности — транспорт:
 *   • аутентификация — userName/password в form-параметрах КАЖДОГО запроса (у RBS
 *     нет долгоживущего токена; проще, чем подпись Token Т-Банка) — секреты в код/
 *     фронт/логи не идут (только из config);
 *   • registerOrder()   — POST application/x-www-form-urlencoded
 *     /payment/rest/register.do → { orderId, formUrl } (или { errorCode, errorMessage });
 *   • getOrderStatus()  — POST /payment/rest/getOrderStatusExtended.do → { orderStatus };
 *   • refund()          — POST /payment/rest/refund.do → { errorCode };
 *   • суммы register/refund — В КОПЕЙКАХ (передаёт вызывающий; клиент не считает деньги);
 *   • таймаут на запрос (AbortController), ретраи на сеть/5xx.
 *
 * АРХИТЕКТУРНОЕ РЕШЕНИЕ (как tbank/paykeeper/СДЭК): AlfabankClient — ВСЕГДА реальный.
 * Mock-данные живут в lib/payments/alfabank/mock/* и НЕ проходят через client.
 * В mock-режиме client НЕ инстанцируется (см. manager.ts).
 */

import type { AlfabankConfig } from './config';
import { AlfabankError } from './errors';
import type {
  AlfabankParams,
  OrderStatusResult,
  RefundResult,
  RegisterOrderInput,
  RegisterOrderResult,
} from './types';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_NETWORK_RETRIES = 2;
/** Задержки между сетевыми ретраями (мс), по индексу попытки. */
const RETRY_DELAYS_MS = [250, 500] as const;

const REGISTER_URI = '/payment/rest/register.do';
const STATUS_URI = '/payment/rest/getOrderStatusExtended.do';
const REFUND_URI = '/payment/rest/refund.do';

/** Опции одного запроса. */
export interface AlfabankRequestOptions {
  timeoutMs?: number;
  maxNetworkRetries?: number;
}

/** Публичный интерфейс клиента. */
export interface IAlfabankClient {
  /** POST /payment/rest/register.do — регистрация заказа, вернуть orderId/formUrl. */
  registerOrder(
    input: RegisterOrderInput,
    opts?: AlfabankRequestOptions,
  ): Promise<RegisterOrderResult>;
  /** POST getOrderStatusExtended.do — числовой orderStatus заказа. */
  getOrderStatus(
    orderId: string,
    opts?: AlfabankRequestOptions,
  ): Promise<OrderStatusResult>;
  /** POST refund.do — возврат по заказу (сумма — копейки). */
  refund(
    orderId: string,
    amountKop: number,
    opts?: AlfabankRequestOptions,
  ): Promise<RefundResult>;
}

/** Параметры конструктора клиента. */
export interface AlfabankClientOptions {
  config: AlfabankConfig;
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
 * Реальный HTTP-клиент Альфа-Банка. Ходит в сеть через fetch; в mock-режиме НЕ
 * используется (см. шапку и manager.ts).
 */
export class AlfabankClient implements IAlfabankClient {
  private readonly gateway: string;
  private readonly username: string;
  private readonly password: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: AlfabankClientOptions) {
    const { config } = opts;
    if (!config.username || !config.password) {
      throw new AlfabankError(
        'alfabank_client_no_credentials',
        'AlfabankClient требует ALFABANK_USERNAME/ALFABANK_PASSWORD (в mock-режиме клиент не используется).',
      );
    }
    this.gateway = config.gateway.replace(/\/$/, '');
    this.username = config.username;
    this.password = config.password;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** Базовые auth-параметры, добавляемые к каждому запросу. */
  private authParams(): AlfabankParams {
    return { userName: this.username, password: this.password };
  }

  async registerOrder(
    input: RegisterOrderInput,
    opts: AlfabankRequestOptions = {},
  ): Promise<RegisterOrderResult> {
    const params: AlfabankParams = {
      ...this.authParams(),
      orderNumber: input.orderNumber,
      amount: String(input.amountKop),
      returnUrl: input.returnUrl,
    };
    if (input.failUrl) params.failUrl = input.failUrl;
    if (input.description) params.description = input.description;

    const decoded = await this.request<{
      orderId?: string;
      formUrl?: string;
      errorCode?: string | number;
      errorMessage?: string;
    }>(REGISTER_URI, params, opts);

    // RBS сигналит бизнес-ошибку через errorCode != 0 в теле 200-ответа.
    const errorCode = decoded?.errorCode !== undefined ? String(decoded.errorCode) : null;
    if (errorCode !== null && errorCode !== '0') {
      throw new AlfabankError(
        'alfabank_register_failed',
        `register.do не удался: ${decoded?.errorMessage ?? errorCode}`,
        { alfabankErrorCode: errorCode },
      );
    }
    if (!decoded?.orderId || !decoded?.formUrl) {
      throw new AlfabankError(
        'alfabank_register_failed',
        `register.do не вернул orderId/formUrl (тело: ${JSON.stringify(decoded).slice(0, 300)}).`,
      );
    }
    return { orderId: String(decoded.orderId), formUrl: decoded.formUrl };
  }

  async getOrderStatus(
    orderId: string,
    opts: AlfabankRequestOptions = {},
  ): Promise<OrderStatusResult> {
    const params: AlfabankParams = { ...this.authParams(), orderId };
    const decoded = await this.request<{ orderStatus?: number | string }>(
      STATUS_URI,
      params,
      opts,
    );
    const raw = decoded?.orderStatus;
    if (raw === undefined || raw === null) return { orderStatus: null };
    const n = Number(raw);
    return { orderStatus: Number.isInteger(n) ? n : null };
  }

  async refund(
    orderId: string,
    amountKop: number,
    opts: AlfabankRequestOptions = {},
  ): Promise<RefundResult> {
    const params: AlfabankParams = {
      ...this.authParams(),
      orderId,
      amount: String(amountKop),
    };
    const decoded = await this.request<{ errorCode?: string | number }>(
      REFUND_URI,
      params,
      opts,
    );
    const errorCode = decoded?.errorCode !== undefined ? String(decoded.errorCode) : '0';
    return { errorCode };
  }

  private buildUrl(uri: string): string {
    const u = uri.startsWith('/') ? uri : `/${uri}`;
    return `${this.gateway}${u}`;
  }

  private async request<T>(
    uri: string,
    params: AlfabankParams,
    opts: AlfabankRequestOptions,
  ): Promise<T> {
    const form = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) form.set(k, v);
    return this.doRequest<T>(uri, form, opts, 0);
  }

  private async doRequest<T>(
    uri: string,
    form: URLSearchParams,
    opts: AlfabankRequestOptions,
    attempt: number,
  ): Promise<T> {
    const url = this.buildUrl(uri);
    const maxRetries = opts.maxNetworkRetries ?? DEFAULT_MAX_NETWORK_RETRIES;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: form.toString(),
        signal: controller.signal,
      });
    } catch (err) {
      if (isNetworkError(err) && attempt < maxRetries) {
        await sleep(RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)]);
        return this.doRequest<T>(uri, form, opts, attempt + 1);
      }
      throw new AlfabankError(
        'alfabank_network_error',
        `Alfabank network error on ${uri}: ${(err as Error).message}`,
      );
    } finally {
      clearTimeout(timer);
    }

    // 5xx — ретрай как сетевую ошибку (до maxRetries).
    if (res.status >= 500 && attempt < maxRetries) {
      await sleep(RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)]);
      return this.doRequest<T>(uri, form, opts, attempt + 1);
    }

    const text = await res.text();

    if (res.status >= 400) {
      throw new AlfabankError('alfabank_http_error', `Alfabank HTTP ${res.status} on ${uri}`, {
        httpStatus: res.status,
      });
    }

    let decoded: unknown = {};
    if (text) {
      try {
        decoded = JSON.parse(text);
      } catch {
        throw new AlfabankError(
          'alfabank_invalid_json',
          `Alfabank invalid JSON on ${uri}: ${text.slice(0, 500)}`,
          { httpStatus: res.status },
        );
      }
    }
    return decoded as T;
  }
}
