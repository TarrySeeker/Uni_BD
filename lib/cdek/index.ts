/**
 * Публичный API модуля СДЭК (docs/08 §2 «index.ts»).
 *
 * Точка входа для остального приложения. Основной потребитель — getCdekManager()
 * (фасад: client/mock/config + isMock-выбор). Реэкспорт ключевых типов/ошибок
 * для удобства сервисов и роутов.
 */

export { getCdekManager, resetCdekManager, CdekManager } from './manager';
export type { CdekManagerOptions, CdekMock } from './manager';

export { CdekClient } from './client';
export type { ICdekClient, HttpMethod, RequestOptions } from './client';

export { CDEK_MOCK_TOKEN } from './token-cache';

export { getCdekConfig, isCdekMock } from './config';
export type { CdekConfig } from './config';

export { CdekError } from './errors';
export type { CdekApiError } from './errors';
