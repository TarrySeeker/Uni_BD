/**
 * Фасад модуля СДЭК — CdekManager (docs/08 §2.1, порт carre Manager.php).
 *
 * Точка входа для сервисов: собирает config + token-cache + client, лениво
 * инстанцирует подсистемы. Пакет C+ (Calculator/Pvz/Order/…) получит здесь
 * геттеры сервисов; на этапе пакета B фасад отдаёт config, isMock, client и
 * mock-слой — этого достаточно, чтобы сервисы выбирали источник данных.
 *
 * ВЫБОР MOCK vs REAL ДЛЯ ПАКЕТА C (контракт).
 *
 *   const m = getCdekManager();
 *   if (m.isMock) {
 *     // боевых ключей нет → детерминированные mock-функции:
 *     const tariffs = m.mock.calculateAvailable(packages);   // formula §5.3
 *     const offices = m.mock.getOffices({ cityCode });        // фикстуры §6
 *   } else {
 *     // реальный транспорт:
 *     const res = await m.client.request('POST', '/v2/calculator/tariff', { json });
 *   }
 *
 * Т.е. источник правды — `manager.isMock` (эквивалент isCdekMock()/!config.account).
 * client В MOCK-РЕЖИМЕ НЕ ИНСТАНЦИРУЕТСЯ: обращение к m.client при isMock кидает
 * CdekError (это ошибка вызывающего — он обязан был свериться с isMock). Так
 * транспорт остаётся чистым (без веток «если mock» внутри client), а mock-данные
 * живут отдельным слоем lib/cdek/mock/* (см. client.ts §«АРХИТЕКТУРНОЕ РЕШЕНИЕ»).
 */

import { getCdekConfig, type CdekConfig } from './config';
import { CdekClient, type ICdekClient } from './client';
import { CdekError } from './errors';
import {
  createMockTokenCache,
  type TokenCache,
  type TokenStore,
} from './token-cache';
import * as mock from './mock';

/** Mock-слой, доступный через manager (детерминированные операции СДЭК). */
export type CdekMock = typeof mock;

/** Опции конструктора менеджера (для тестов: подмена fetch/store/cache). */
export interface CdekManagerOptions {
  config?: CdekConfig;
  fetchImpl?: typeof fetch;
  tokenStore?: TokenStore;
  tokenCache?: TokenCache;
}

/**
 * Фасад СДЭК. Ленивые синглтоны клиента. `isMock` — единственный флаг выбора
 * mock-vs-real для всех сервисов.
 */
export class CdekManager {
  readonly config: CdekConfig;
  readonly mock: CdekMock = mock;

  private readonly fetchImpl?: typeof fetch;
  private readonly tokenStore?: TokenStore;
  private readonly tokenCache?: TokenCache;
  private _client: ICdekClient | null = null;

  constructor(opts: CdekManagerOptions = {}) {
    this.config = opts.config ?? getCdekConfig();
    this.fetchImpl = opts.fetchImpl;
    this.tokenStore = opts.tokenStore;
    this.tokenCache = opts.tokenCache;
  }

  /** true при пустых CDEK_ACCOUNT/CDEK_SECRET (mock-режим, docs/08 §11). */
  get isMock(): boolean {
    return !this.config.account || !this.config.secret;
  }

  /**
   * Реальный HTTP-клиент. В mock-режиме недоступен (кидает CdekError) — сервисы
   * обязаны свериться с isMock и взять mock-слой. Ленивый синглтон.
   */
  get client(): ICdekClient {
    if (this.isMock) {
      throw new CdekError(
        'cdek_client_unavailable_in_mock',
        'CdekClient недоступен в mock-режиме. Используйте manager.isMock + manager.mock.*',
      );
    }
    if (!this._client) {
      this._client = new CdekClient({
        config: this.config,
        fetchImpl: this.fetchImpl,
        tokenStore: this.tokenStore,
        tokenCache: this.tokenCache,
      });
    }
    return this._client;
  }
}

// ---------------------------------------------------------------------------
// Ленивый синглтон на процесс (как getStorage / getDefaultLimiter).
// ---------------------------------------------------------------------------

let cached: CdekManager | undefined;
let mockWarned = false;

function warnMockOnce(isMock: boolean): void {
  if (isMock && !mockWarned) {
    mockWarned = true;
    console.warn('[cdek] mock-режим: боевые ключи не заданы (CDEK_ACCOUNT/CDEK_SECRET).');
  }
}

/**
 * Дефолтный менеджер на процесс. Конфиг — из env (getCdekConfig). Один warn при
 * инициализации в mock-режиме (паттерн rate-limit.ts / storefront/auth.ts).
 */
export function getCdekManager(): CdekManager {
  if (!cached) {
    cached = new CdekManager();
    warnMockOnce(cached.isMock);
  }
  return cached;
}

/** Сбрасывает кешированный менеджер (используется в тестах). */
export function resetCdekManager(): void {
  cached = undefined;
  mockWarned = false;
}
