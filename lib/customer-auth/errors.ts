/**
 * Ошибки контура customer-auth (ЛК покупателя, docs/24 §6).
 *
 * ВАЖНО (anti-enumeration): наружу (в storefront-роуты) эти ошибки НЕ раскрывают
 * «есть ли email». `InvalidCredentialsError` и «email занят» ветки логина/сброса
 * маппятся сервисом в generic-ответ. Классы нужны внутри сервиса для управления
 * потоком, а не для дифференцированных сообщений пользователю.
 */

/** Базовый класс ошибок домена customer-auth. */
export class CustomerAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Неверная пара email/пароль ИЛИ несуществующий аккаунт (наружу — единый 401). */
export class InvalidCredentialsError extends CustomerAuthError {
  constructor() {
    super('Неверный email или пароль.');
  }
}

/** Превышен лимит попыток (login/register/reset). */
export class RateLimitedError extends CustomerAuthError {
  constructor(public readonly retryAfterSec: number) {
    super('Слишком много попыток. Повторите позже.');
  }
}

/** Токен сброса недействителен (не найден / истёк / уже использован). */
export class InvalidTokenError extends CustomerAuthError {
  constructor() {
    super('Ссылка недействительна или срок её действия истёк.');
  }
}
