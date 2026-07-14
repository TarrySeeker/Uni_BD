/**
 * Фасад модуля PayKeeper — PaykeeperManager (docs/24 §2, порт tbank/manager.ts).
 *
 * Точка входа для сервиса: собирает config + client + mock, лениво инстанцирует
 * клиент. `isMock` — единственный флаг выбора mock-vs-real.
 *
 * ВЫБОР MOCK vs REAL (контракт, docs/24 §2):
 *
 *   const m = getPaykeeperManager();
 *   if (m.isMock) {
 *     const res = m.mock.mockCreateInvoice({ orderId, payAmount });  // фейк invoice + URL
 *   } else {
 *     const res = await m.client.createInvoice(body);                // реальный транспорт
 *   }
 *
 * Источник правды — manager.isMock (эквивалент isPaykeeperMock()/пустой LOGIN|PASSWORD).
 * client В MOCK-РЕЖИМЕ НЕ ИНСТАНЦИРУЕТСЯ: обращение к m.client при isMock кидает
 * PaykeeperError (баг вызывающего). Транспорт остаётся чистым (без веток «если mock»),
 * mock-данные живут отдельным слоем lib/payments/paykeeper/mock/*.
 */

import { getPaykeeperConfig, type PaykeeperConfig } from './config';
import { PaykeeperClient, type IPaykeeperClient } from './client';
import { PaykeeperError } from './errors';
import * as mock from './mock';

/** Mock-слой, доступный через manager (детерминированные операции PayKeeper). */
export type PaykeeperMock = typeof mock;

/** Опции конструктора менеджера (для тестов: подмена config/fetch). */
export interface PaykeeperManagerOptions {
  config?: PaykeeperConfig;
  fetchImpl?: typeof fetch;
}

/**
 * Фасад PayKeeper. Ленивый синглтон клиента. `isMock` — единственный флаг выбора
 * mock-vs-real для сервиса.
 */
export class PaykeeperManager {
  readonly config: PaykeeperConfig;
  readonly mock: PaykeeperMock = mock;

  private readonly fetchImpl?: typeof fetch;
  private _client: IPaykeeperClient | null = null;

  constructor(opts: PaykeeperManagerOptions = {}) {
    this.config = opts.config ?? getPaykeeperConfig();
    this.fetchImpl = opts.fetchImpl;
  }

  /** true при пустых PAYKEEPER_LOGIN/PAYKEEPER_PASSWORD (mock-режим, docs/24 §2). */
  get isMock(): boolean {
    return !this.config.login || !this.config.password;
  }

  /**
   * Реальный HTTP-клиент. В mock-режиме недоступен (кидает PaykeeperError) — сервис
   * обязан свериться с isMock и взять mock-слой. Ленивый синглтон.
   */
  get client(): IPaykeeperClient {
    if (this.isMock) {
      throw new PaykeeperError(
        'paykeeper_client_unavailable_in_mock',
        'PaykeeperClient недоступен в mock-режиме. Используйте manager.isMock + manager.mock.*',
      );
    }
    if (!this._client) {
      this._client = new PaykeeperClient({ config: this.config, fetchImpl: this.fetchImpl });
    }
    return this._client;
  }
}

// ---------------------------------------------------------------------------
// Ленивый синглтон на процесс (как getTbankManager).
// ---------------------------------------------------------------------------

let cached: PaykeeperManager | undefined;
let mockWarned = false;

function warnMockOnce(isMock: boolean): void {
  if (isMock && !mockWarned) {
    mockWarned = true;
    console.warn('[paykeeper] mock-режим: боевые ключи не заданы (PAYKEEPER_LOGIN/PAYKEEPER_PASSWORD).');
  }
}

/**
 * Дефолтный менеджер на процесс. Конфиг — из env (getPaykeeperConfig). Один warn
 * при инициализации в mock-режиме (порт warnMockOnce tbank).
 */
export function getPaykeeperManager(): PaykeeperManager {
  if (!cached) {
    cached = new PaykeeperManager();
    warnMockOnce(cached.isMock);
  }
  return cached;
}

/** Сбрасывает кешированный менеджер (используется в тестах). */
export function resetPaykeeperManager(): void {
  cached = undefined;
  mockWarned = false;
}
