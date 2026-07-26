/**
 * Низкоуровневый HTTP-клиент серверного API PayKeeper (docs/24 §2, порт
 * tbank/client.ts на инвойсную модель).
 *
 * Зона ответственности — транспорт:
 *   • Basic-Auth (login/password) на каждом запросе (у PayKeeper нет боевого
 *     токена доступа — только короткоживущий token под конкретный POST инвойса,
 *     который клиент сам получает через getToken());
 *   • getToken()        — GET /info/settings/token/ → { token } (анти-CSRF токен
 *     под POST инвойса);
 *   • createInvoice()   — POST application/x-www-form-urlencoded
 *     /change/invoice/preview/ → { invoice_id, invoice_url };
 *   • getInvoiceStatus()— GET /info/invoice/byid/?id= → { status };
 *   • суммы — В РУБЛЯХ (десятичная строка; клиент не считает деньги);
 *   • таймаут на запрос (AbortController), ретраи на сеть/5xx.
 *
 * АРХИТЕКТУРНОЕ РЕШЕНИЕ (как tbank/СДЭК): PaykeeperClient — ВСЕГДА реальный.
 * Mock-данные живут в lib/payments/paykeeper/mock/* и НЕ проходят через client.
 * В mock-режиме client НЕ инстанцируется (см. manager.ts).
 */

import type { PaykeeperConfig } from './config';
import { PaykeeperError } from './errors';
import { basicAuthHeader } from './token';
import type { CreateInvoiceInput, CreateInvoiceResult, InvoiceStatusResult } from './types';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_NETWORK_RETRIES = 2;
/** Задержки между сетевыми ретраями (мс), по индексу попытки. */
const RETRY_DELAYS_MS = [250, 500] as const;

const TOKEN_URI = '/info/settings/token/';
const INVOICE_URI = '/change/invoice/preview/';
const INVOICE_STATUS_URI = '/info/invoice/byid/';

/** Опции одного запроса. */
export interface PaykeeperRequestOptions {
  timeoutMs?: number;
  maxNetworkRetries?: number;
}

/** Публичный интерфейс клиента. */
export interface IPaykeeperClient {
  /** GET /info/settings/token/ — токен под конкретный POST инвойса. */
  getToken(opts?: PaykeeperRequestOptions): Promise<string>;
  /** POST /change/invoice/preview/ — выставить счёт, вернуть invoice_id/url. */
  createInvoice(
    input: CreateInvoiceInput,
    opts?: PaykeeperRequestOptions,
  ): Promise<CreateInvoiceResult>;
  /** GET /info/invoice/byid/?id= — текущий статус счёта. */
  getInvoiceStatus(
    invoiceId: string,
    opts?: PaykeeperRequestOptions,
  ): Promise<InvoiceStatusResult>;
}

/** Параметры конструктора клиента. */
export interface PaykeeperClientOptions {
  config: PaykeeperConfig;
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
 * service_name счёта — JSON { cart, lang, service_name } (сверено с carre
 * PayKeeper::createOrder). PayKeeper кодирует его как значение form-поля.
 */
function buildServiceName(
  input: CreateInvoiceInput,
  serviceName: string,
  lang: string,
): string {
  return JSON.stringify({ cart: input.cart, lang, service_name: serviceName });
}

/**
 * Реальный HTTP-клиент PayKeeper. Ходит в сеть через fetch; в mock-режиме НЕ
 * используется (см. шапку и manager.ts).
 */
export class PaykeeperClient implements IPaykeeperClient {
  private readonly baseUrl: string;
  private readonly authHeader: string;
  private readonly serviceName: string;
  private readonly lang: string;
  private readonly returnParam: string | null;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: PaykeeperClientOptions) {
    const { config } = opts;
    if (!config.login || !config.password) {
      throw new PaykeeperError(
        'paykeeper_client_no_credentials',
        'PaykeeperClient требует PAYKEEPER_LOGIN/PAYKEEPER_PASSWORD (в mock-режиме клиент не используется).',
      );
    }
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.authHeader = basicAuthHeader(config.login, config.password);
    this.serviceName = config.serviceName;
    this.lang = config.lang;
    this.returnParam = config.returnParam;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async getToken(opts: PaykeeperRequestOptions = {}): Promise<string> {
    const decoded = await this.request<{ token?: string }>('GET', TOKEN_URI, undefined, opts);
    const token = decoded?.token;
    if (typeof token !== 'string' || token.length === 0) {
      throw new PaykeeperError('paykeeper_no_token', 'PayKeeper не вернул token для инвойса.');
    }
    return token;
  }

  async createInvoice(
    input: CreateInvoiceInput,
    opts: PaykeeperRequestOptions = {},
  ): Promise<CreateInvoiceResult> {
    const token = await this.getToken(opts);
    const form = new URLSearchParams();
    form.set('pay_amount', input.payAmount);
    form.set('clientid', input.clientId);
    form.set('orderid', input.orderId);
    form.set('service_name', buildServiceName(input, this.serviceName, this.lang));
    if (input.clientPhone) form.set('client_phone', input.clientPhone);
    if (input.clientEmail) form.set('client_email', input.clientEmail);
    // Адрес возврата покупателя (с number/token) — без него PayKeeper вернёт его на
    // статический адрес из ЛК и страница успеха не сможет показать ни заказ, ни код
    // подарочного сертификата. Поле НЕ логируется (несёт токен доступа к заказу).
    if (input.returnUrl && this.returnParam) form.set(this.returnParam, input.returnUrl);
    form.set('token', token);

    const decoded = await this.request<{ invoice_id?: string | number; invoice_url?: string }>(
      'POST',
      INVOICE_URI,
      form,
      opts,
    );
    const invoiceId = decoded?.invoice_id;
    const invoiceUrl = decoded?.invoice_url;
    if (invoiceId === undefined || invoiceId === null || !invoiceUrl) {
      throw new PaykeeperError(
        'paykeeper_invoice_failed',
        `PayKeeper не вернул invoice_id/invoice_url (тело: ${JSON.stringify(decoded).slice(0, 300)}).`,
      );
    }
    return { invoiceId: String(invoiceId), invoiceUrl };
  }

  async getInvoiceStatus(
    invoiceId: string,
    opts: PaykeeperRequestOptions = {},
  ): Promise<InvoiceStatusResult> {
    const uri = `${INVOICE_STATUS_URI}?id=${encodeURIComponent(invoiceId)}`;
    const decoded = await this.request<{ status?: string }>('GET', uri, undefined, opts);
    const status = decoded?.status;
    return { status: typeof status === 'string' && status.length > 0 ? status : null };
  }

  private buildUrl(uri: string): string {
    const u = uri.startsWith('/') ? uri : `/${uri}`;
    return `${this.baseUrl}${u}`;
  }

  private async request<T>(
    method: 'GET' | 'POST',
    uri: string,
    body: URLSearchParams | undefined,
    opts: PaykeeperRequestOptions,
  ): Promise<T> {
    return this.doRequest<T>(method, uri, body, opts, 0);
  }

  private async doRequest<T>(
    method: 'GET' | 'POST',
    uri: string,
    body: URLSearchParams | undefined,
    opts: PaykeeperRequestOptions,
    attempt: number,
  ): Promise<T> {
    const url = this.buildUrl(uri);
    const maxRetries = opts.maxNetworkRetries ?? DEFAULT_MAX_NETWORK_RETRIES;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const headers: Record<string, string> = {
      Authorization: this.authHeader,
      Accept: 'application/json',
    };
    if (method === 'POST') {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers,
        body: method === 'POST' ? (body?.toString() ?? '') : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      if (isNetworkError(err) && attempt < maxRetries) {
        await sleep(RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)]);
        return this.doRequest<T>(method, uri, body, opts, attempt + 1);
      }
      throw new PaykeeperError(
        'paykeeper_network_error',
        `PayKeeper network error on ${uri}: ${(err as Error).message}`,
      );
    } finally {
      clearTimeout(timer);
    }

    // 5xx — ретрай как сетевую ошибку (до maxRetries).
    if (res.status >= 500 && attempt < maxRetries) {
      await sleep(RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)]);
      return this.doRequest<T>(method, uri, body, opts, attempt + 1);
    }

    const text = await res.text();

    if (res.status >= 400) {
      throw new PaykeeperError('paykeeper_http_error', `PayKeeper HTTP ${res.status} on ${uri}`, {
        httpStatus: res.status,
      });
    }

    let decoded: unknown = {};
    if (text) {
      try {
        decoded = JSON.parse(text);
      } catch {
        throw new PaykeeperError(
          'paykeeper_invalid_json',
          `PayKeeper invalid JSON on ${uri}: ${text.slice(0, 500)}`,
          { httpStatus: res.status },
        );
      }
    }
    return decoded as T;
  }
}
