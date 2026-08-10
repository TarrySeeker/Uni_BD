/**
 * Фасад модуля Т-Банк — TbankManager (docs/15 §2 «manager.ts», порт CdekManager).
 *
 * Точка входа для сервиса: собирает config + client + mock, лениво инстанцирует
 * клиент. `isMock` — единственный флаг выбора mock-vs-real.
 *
 * ВЫБОР MOCK vs REAL (контракт, docs/15 §2.1):
 *
 *   const m = getTbankManager();
 *   if (m.isMock) {
 *     const res = m.mock.mockInitPayment({ orderId, amountKop });  // фейк PaymentId + URL
 *   } else {
 *     const res = await m.client.call('Init', signedBody);          // реальный транспорт
 *   }
 *
 * Источник правды — manager.isMock (эквивалент isTbankMock()/пустой TBANK_PASSWORD).
 * client В MOCK-РЕЖИМЕ НЕ ИНСТАНЦИРУЕТСЯ: обращение к m.client при isMock кидает
 * TbankError (баг вызывающего). Транспорт остаётся чистым (без веток «если mock»),
 * mock-данные живут отдельным слоем lib/payments/tbank/mock/*.
 */

import { getTbankConfig, resolveTbankMock, type TbankConfig } from './config';
import { TbankClient, type ITbankClient } from './client';
import { TbankError } from './errors';
import * as mock from './mock';

/** Mock-слой, доступный через manager (детерминированные операции Т-Банка). */
export type TbankMock = typeof mock;

/** Опции конструктора менеджера (для тестов: подмена config/fetch). */
export interface TbankManagerOptions {
  config?: TbankConfig;
  fetchImpl?: typeof fetch;
}

/**
 * Фасад Т-Банк. Ленивый синглтон клиента. `isMock` — единственный флаг выбора
 * mock-vs-real для сервиса.
 */
export class TbankManager {
  readonly config: TbankConfig;
  readonly mock: TbankMock = mock;

  private readonly fetchImpl?: typeof fetch;
  private _client: ITbankClient | null = null;

  constructor(opts: TbankManagerOptions = {}) {
    this.config = opts.config ?? getTbankConfig();
    this.fetchImpl = opts.fetchImpl;
  }

  /**
   * true при пустых TBANK_TERMINAL_KEY/TBANK_PASSWORD (mock-режим, docs/15 §2.1).
   *
   * Считается ЧЕРЕЗ resolveTbankMock, а не собственной формулой: именно этот
   * геттер спрашивает боевой путь оплаты, и пока он вычислял признак сам,
   * fail-closed-защита в isTbankMock() на нём не срабатывала вовсе. В production
   * без ключей бросает (см. TBANK_MOCK_IN_PRODUCTION_ERROR).
   */
  get isMock(): boolean {
    return resolveTbankMock(this.config);
  }

  /**
   * Реальный HTTP-клиент. В mock-режиме недоступен (кидает TbankError) — сервис
   * обязан свериться с isMock и взять mock-слой. Ленивый синглтон.
   */
  get client(): ITbankClient {
    if (this.isMock) {
      throw new TbankError(
        'tbank_client_unavailable_in_mock',
        'TbankClient недоступен в mock-режиме. Используйте manager.isMock + manager.mock.*',
      );
    }
    if (!this._client) {
      this._client = new TbankClient({ config: this.config, fetchImpl: this.fetchImpl });
    }
    return this._client;
  }
}

// ---------------------------------------------------------------------------
// Ленивый синглтон на процесс (как getCdekManager).
// ---------------------------------------------------------------------------

let cached: TbankManager | undefined;
let mockWarned = false;

function warnMockOnce(isMock: boolean): void {
  if (isMock && !mockWarned) {
    mockWarned = true;
    console.warn('[tbank] mock-режим: боевые ключи не заданы (TBANK_TERMINAL_KEY/TBANK_PASSWORD).');
  }
}

/**
 * Дефолтный менеджер на процесс. Конфиг — из env (getTbankConfig). Один warn при
 * инициализации в mock-режиме (порт warnMockOnce СДЭК).
 */
export function getTbankManager(): TbankManager {
  if (!cached) {
    cached = new TbankManager();
    warnMockOnce(cached.isMock);
  }
  return cached;
}

/** Сбрасывает кешированный менеджер (используется в тестах). */
export function resetTbankManager(): void {
  cached = undefined;
  mockWarned = false;
}
