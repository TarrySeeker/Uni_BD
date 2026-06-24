/**
 * Локальное чтение переменных окружения Storefront API (docs/06 §6, ADR-008).
 *
 * РЕШЕНИЕ: эти переменные читаются ЛОКАЛЬНО здесь, а НЕ добавляются в общий
 * lib/config/env.ts. Storefront API — отдельная (опциональная) точка входа;
 * держать её конфигурацию рядом с кодом снижает связность общего env-схемы и
 * позволяет mock-режим (пустая конфигурация → demo-доступ, docs/02).
 *
 * Переменные:
 *  - STOREFRONT_API_KEYS       — список ключей через запятую. Допустимы две формы:
 *                                 «ключ» либо «домен:ключ» (домен — только подсказка,
 *                                 проверяется именно ключ). Пусто → mock-режим.
 *  - STOREFRONT_ALLOWED_ORIGINS — список разрешённых Origin (схема+хост[:порт]) через
 *                                 запятую. Пусто → mock-режим (любой Origin разрешён).
 *
 * Чистые парсеры (без побочных эффектов) — тестируемы без процесса.
 */

/** Разобранный ключ витрины: сам секрет и опциональный домен-подсказка. */
export interface StorefrontKey {
  /** Секретный ключ (то, что сравнивается с заголовком). */
  key: string;
  /** Домен-подсказка из формы «домен:ключ» (необязателен). */
  domain?: string;
}

/** Парсит STOREFRONT_API_KEYS в список ключей. Пустой ввод → []. */
export function parseApiKeys(raw: string | undefined): StorefrontKey[] {
  if (!raw || !raw.trim()) {
    return [];
  }
  const out: StorefrontKey[] = [];
  for (const part of raw.split(',')) {
    const item = part.trim();
    if (!item) {
      continue;
    }
    // Форма «домен:ключ»: разбиваем по ПЕРВОМУ двоеточию (ключ может содержать ':').
    const idx = item.indexOf(':');
    if (idx > 0) {
      const domain = item.slice(0, idx).trim().toLowerCase();
      const key = item.slice(idx + 1).trim();
      if (key) {
        out.push({ key, domain: domain || undefined });
        continue;
      }
    }
    out.push({ key: item });
  }
  return out;
}

/** Нормализует Origin к виду «scheme://host[:port]» в нижнем регистре. */
export function normalizeOrigin(origin: string | null | undefined): string | null {
  if (!origin || !origin.trim()) {
    return null;
  }
  const raw = origin.trim();
  try {
    const u = new URL(raw);
    const port = u.port ? `:${u.port}` : '';
    return `${u.protocol}//${u.hostname}${port}`.toLowerCase();
  } catch {
    // Не валидный URL — вернём как есть в нижнем регистре (на случай «*»).
    return raw.toLowerCase();
  }
}

/** Парсит STOREFRONT_ALLOWED_ORIGINS в нормализованный список. Пусто → []. */
export function parseAllowedOrigins(raw: string | undefined): string[] {
  if (!raw || !raw.trim()) {
    return [];
  }
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const norm = normalizeOrigin(part);
    if (norm) {
      out.push(norm);
    }
  }
  return out;
}

/** Снимок конфигурации Storefront из произвольного источника env. */
export interface StorefrontConfig {
  apiKeys: StorefrontKey[];
  allowedOrigins: string[];
}

/** Читает конфигурацию из переданного источника (по умолчанию process.env). */
export function getStorefrontConfig(
  env: Record<string, string | undefined> = process.env,
): StorefrontConfig {
  return {
    apiKeys: parseApiKeys(env.STOREFRONT_API_KEYS),
    allowedOrigins: parseAllowedOrigins(env.STOREFRONT_ALLOWED_ORIGINS),
  };
}
