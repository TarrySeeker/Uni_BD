/**
 * Фасад модуля Альфа-Банк — AlfabankManager (порт tbank/manager.ts + paykeeper/manager.ts).
 *
 * Точка входа для сервиса: собирает config + client + mock, лениво инстанцирует
 * клиент. `isMock` — единственный флаг выбора mock-vs-real.
 *
 * ВЫБОР MOCK vs REAL (контракт):
 *
 *   const m = getAlfabankManager();
 *   if (m.isMock) {
 *     const res = m.mock.mockRegisterOrder({ orderNumber, amountKop });  // фейк orderId + formUrl
 *   } else {
 *     const res = await m.client.registerOrder(body);                    // реальный транспорт
 *   }
 *
 * Источник правды — manager.isMock (эквивалент isAlfabankMock()/пустой USERNAME|PASSWORD).
 * client В MOCK-РЕЖИМЕ НЕ ИНСТАНЦИРУЕТСЯ: обращение к m.client при isMock кидает
 * AlfabankError (баг вызывающего). Транспорт остаётся чистым (без веток «если mock»),
 * mock-данные живут отдельным слоем lib/payments/alfabank/mock/*.
 */

import { getAlfabankConfig, type AlfabankConfig } from './config';
import { AlfabankClient, type IAlfabankClient } from './client';
import { AlfabankError } from './errors';
import * as mock from './mock';

/** Mock-слой, доступный через manager (детерминированные операции Альфа-Банка). */
export type AlfabankMock = typeof mock;

/** Опции конструктора менеджера (для тестов: подмена config/fetch). */
export interface AlfabankManagerOptions {
  config?: AlfabankConfig;
  fetchImpl?: typeof fetch;
}

/**
 * Фасад Альфа-Банк. Ленивый синглтон клиента. `isMock` — единственный флаг выбора
 * mock-vs-real для сервиса.
 */
export class AlfabankManager {
  readonly config: AlfabankConfig;
  readonly mock: AlfabankMock = mock;

  private readonly fetchImpl?: typeof fetch;
  private _client: IAlfabankClient | null = null;

  constructor(opts: AlfabankManagerOptions = {}) {
    this.config = opts.config ?? getAlfabankConfig();
    this.fetchImpl = opts.fetchImpl;
  }

  /** true при пустых ALFABANK_USERNAME/ALFABANK_PASSWORD (mock-режим). */
  get isMock(): boolean {
    return !this.config.username || !this.config.password;
  }

  /**
   * Реальный HTTP-клиент. В mock-режиме недоступен (кидает AlfabankError) — сервис
   * обязан свериться с isMock и взять mock-слой. Ленивый синглтон.
   */
  get client(): IAlfabankClient {
    if (this.isMock) {
      throw new AlfabankError(
        'alfabank_client_unavailable_in_mock',
        'AlfabankClient недоступен в mock-режиме. Используйте manager.isMock + manager.mock.*',
      );
    }
    if (!this._client) {
      this._client = new AlfabankClient({ config: this.config, fetchImpl: this.fetchImpl });
    }
    return this._client;
  }
}

// ---------------------------------------------------------------------------
// Ленивый синглтон на процесс (как getTbankManager/getPaykeeperManager).
// ---------------------------------------------------------------------------

let cached: AlfabankManager | undefined;
let mockWarned = false;

function warnMockOnce(isMock: boolean): void {
  if (isMock && !mockWarned) {
    mockWarned = true;
    console.warn('[alfabank] mock-режим: боевые ключи не заданы (ALFABANK_USERNAME/ALFABANK_PASSWORD).');
  }
}

/**
 * Дефолтный менеджер на процесс. Конфиг — из env (getAlfabankConfig). Один warn при
 * инициализации в mock-режиме (порт warnMockOnce).
 */
export function getAlfabankManager(): AlfabankManager {
  if (!cached) {
    cached = new AlfabankManager();
    warnMockOnce(cached.isMock);
  }
  return cached;
}

/** Сбрасывает кешированный менеджер (используется в тестах). */
export function resetAlfabankManager(): void {
  cached = undefined;
  mockWarned = false;
}
