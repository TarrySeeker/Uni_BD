/**
 * Общие помощники роутов кабинета.
 *
 * Вынесены сюда, чтобы полтора десятка роутов не повторяли одну и ту же ветку
 * «нет сессии → 401» и разбор адреса запроса. Повторение здесь опасно не
 * многословностью: стоит одному роуту разобрать заголовки по-своему — и защита
 * начинает расходиться между точками входа. Этот класс дефекта на платформе уже
 * стрелял, поэтому единая точка важнее экономии строк.
 */

import type { NextResponse } from 'next/server';

import { jsonError } from '@/lib/storefront/response';
import { normalizeClientIp } from '@/lib/server/request-ip';

import { getCustomerFromHeaders } from './require-customer';
import type { CustomerAuth } from './types';

/**
 * Методы, которые обслуживают роуты кабинета.
 *
 * Помимо чтения и создания нужны изменение и удаление: профиль правится
 * частично, адреса удаляются.
 */
export const ACCOUNT_METHODS = 'GET, POST, PATCH, DELETE, OPTIONS';

/**
 * Метаданные для записи сессии.
 *
 * ⚠️ Адрес обязательно проходит нормализацию: он пишется в колонку типа `inet`,
 * и сырой заголовок уронил бы вставку, а вместе с ней вход в кабинет. Заодно
 * нормализация выбирает заголовок, которому можно верить, — подделать адрес
 * ради обхода ограничения попыток не выйдет.
 */
export function sessionMeta(req: Request): { ip: string | null; userAgent: string | null } {
  return {
    ip:
      normalizeClientIp(
        req.headers.get('x-forwarded-for'),
        req.headers.get('x-real-ip'),
      ) ?? null,
    userAgent: req.headers.get('user-agent'),
  };
}

/**
 * Покупатель из сессии — либо готовый ответ «не авторизован» для раннего выхода:
 *
 *   const who = await requireCustomer(req, cors);
 *   if (who instanceof Response) return who;   // дальше who — покупатель
 */
export async function requireCustomer(
  req: Request,
  cors: Record<string, string>,
): Promise<CustomerAuth | NextResponse> {
  const customer = await getCustomerFromHeaders(req.headers);
  if (!customer) {
    return jsonError('unauthorized', 'Требуется вход в личный кабинет.', cors);
  }
  return customer;
}
