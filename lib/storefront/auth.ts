/**
 * Аутентификация витрины для Storefront API (docs/06 §6, ADR-008).
 *
 * Доступ предоставляется если выполнено ХОТЯ БЫ ОДНО из условий:
 *  1) заголовок API-ключа (X-Storefront-Key / X-Api-Key) совпал с настроенным
 *     STOREFRONT_API_KEYS;
 *  2) Origin запроса входит в STOREFRONT_ALLOWED_ORIGINS.
 *
 * MOCK-режим (универсальность/demo, docs/02): если НЕ настроены ни ключи, ни
 * домены — доступ разрешается всем (с одноразовым warn). Это позволяет поднять
 * demo-витрину без секретов; боевой магазин задаёт ключи/домены и получает
 * строгую проверку.
 *
 * Функция чистая в смысле тестируемости: принимает абстракцию заголовков
 * (HeadersLike) и источник конфигурации, не зависит от Next/Request напрямую.
 */

import { timingSafeEqual } from 'node:crypto';

import { getStorefrontConfig, normalizeOrigin } from './env';
import type { StorefrontConfig } from './env';

/**
 * Сравнение API-ключей за КОНСТАНТНОЕ время (m9): `===`/`includes` сравнивают строку
 * посимвольно с ранним выходом на первом расхождении → тайминг-сайдканал, по которому
 * ключ можно подбирать побайтно. timingSafeEqual не зависит от позиции расхождения.
 * Разная длина → сразу false (длина не секрет; стандартный компромисс).
 */
function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Минимальный интерфейс заголовков (Headers / Request.headers совместимы). */
export interface HeadersLike {
  get(name: string): string | null;
}

/** Заголовки, в которых витрина может передать API-ключ. */
export const API_KEY_HEADERS = ['x-storefront-key', 'x-api-key'] as const;

export interface AuthorizeResult {
  /** Доступ разрешён. */
  ok: boolean;
  /** Нормализованный Origin запроса (если был и распознан) — для CORS-ответа. */
  origin?: string;
  /** Сработал mock-режим (конфигурация пуста). */
  mock?: boolean;
  /** Как авторизовались: ключ, origin или mock (для диагностики/логов). */
  via?: 'key' | 'origin' | 'mock';
}

/** Извлекает API-ключ из любого из поддерживаемых заголовков. */
export function extractApiKey(headers: HeadersLike): string | null {
  for (const name of API_KEY_HEADERS) {
    const v = headers.get(name);
    if (v && v.trim()) {
      return v.trim();
    }
  }
  return null;
}

let mockWarned = false;

function warnMockOnce(): void {
  if (!mockWarned) {
    mockWarned = true;
    console.warn(
      '[admik] Storefront API в mock-режиме: не настроены ни STOREFRONT_API_KEYS, ' +
        'ни STOREFRONT_ALLOWED_ORIGINS — доступ открыт всем (demo). ' +
        'Для боевого магазина задайте ключи и/или разрешённые домены.',
    );
  }
}

/** Сбрасывает флаг одноразового warn (для тестов). */
export function resetStorefrontAuthWarn(): void {
  mockWarned = false;
}

/**
 * Проверяет доступ витрины по заголовкам запроса.
 *
 * @param headers заголовки запроса (Request.headers или Headers)
 * @param config  конфигурация (по умолчанию читается из process.env)
 */
export function authorizeStorefront(
  headers: HeadersLike,
  config: StorefrontConfig = getStorefrontConfig(),
): AuthorizeResult {
  const origin = normalizeOrigin(headers.get('origin')) ?? undefined;

  const { apiKeys, allowedOrigins } = config;

  // MOCK-режим: ничего не настроено → разрешаем (demo).
  if (apiKeys.length === 0 && allowedOrigins.length === 0) {
    warnMockOnce();
    return { ok: true, origin, mock: true, via: 'mock' };
  }

  // 1) Проверка API-ключа (constant-time, m9). Перебираем ВСЕ ключи без раннего
  // выхода — чтобы тайминг не зависел ни от позиции совпавшего ключа, ни от первого
  // расхождения внутри ключа (иначе побайтный/попозиционный подбор).
  if (apiKeys.length > 0) {
    const provided = extractApiKey(headers);
    if (provided) {
      let matched = false;
      for (const k of apiKeys) {
        if (constantTimeEqual(k.key, provided)) matched = true;
      }
      if (matched) {
        return { ok: true, origin, via: 'key' };
      }
    }
  }

  // 2) Проверка Origin.
  if (origin && allowedOrigins.length > 0 && allowedOrigins.includes(origin)) {
    return { ok: true, origin, via: 'origin' };
  }

  return { ok: false, origin };
}
