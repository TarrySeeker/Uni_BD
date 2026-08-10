/**
 * Определение покупателя по заголовкам запроса.
 *
 * Токен сессии приходит в отдельном заголовке, который проставляет серверная
 * часть витрины, доставая его из httpOnly-cookie на своём домене. Клиентский JS
 * токена не видит никогда — поэтому межсайтовый скриптинг на витрине не уводит
 * сессию покупателя.
 *
 * API про cookie ничего не знает и знать не должен: он принимает заголовок. Это
 * позволяет статической витрине работать так же, как рендерящейся на сервере,
 * и не привязывает кабинет к одному домену.
 *
 * Модуль чистый относительно фреймворка: принимает абстракцию заголовков,
 * поэтому тестируется без запроса.
 */

import { validateCustomerSession } from './session';
import { CUSTOMER_SESSION_HEADER } from './constants';
import type { CustomerAuth } from './types';

/** Минимальный контракт источника заголовков (совместим с Headers и Request.headers). */
export interface HeadersLike {
  get(name: string): string | null;
}

/** Достаёт токен сессии из заголовка. Пустая строка считается отсутствием. */
export function extractCustomerSessionToken(headers: HeadersLike): string | null {
  const value = headers.get(CUSTOMER_SESSION_HEADER);
  return value && value.trim() ? value.trim() : null;
}

/**
 * Покупатель по заголовку сессии.
 *
 * `null` во всех случаях: токена нет, токен неизвестен, сессия истекла, аккаунт
 * заблокирован. Различать их наружу не нужно — для вызывающего это одно и то же
 * «вход не выполнен».
 */
export async function getCustomerFromHeaders(
  headers: HeadersLike,
): Promise<CustomerAuth | null> {
  const token = extractCustomerSessionToken(headers);
  if (!token) return null;
  return validateCustomerSession(token);
}
