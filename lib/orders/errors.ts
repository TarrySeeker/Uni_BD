/**
 * Ошибки домена orders.
 *
 * Вынесено в отдельный модуль (а не в actions.ts), потому что actions.ts помечен
 * директивой `'use server'`, а такой модуль может экспортировать ТОЛЬКО async-функции
 * (ограничение Next.js Server Actions). Класс ошибки — не функция, поэтому живёт здесь
 * (как lib/catalog/errors.ts).
 */

import { PublicActionError } from '@/lib/server/action';

/**
 * Ошибка домена заказов/промокодов.
 *
 * НАСЛЕДУЕТ PublicActionError (lib/server/action.ts), чтобы её человекочитаемый
 * `message` доходил до UI: пайплайн defineAction маппит `instanceof
 * PublicActionError` в `{ ok:false, error:'validation', message }`. Обычные
 * исключения handler'а превратились бы в `error:'internal'` без текста — и
 * пользователь видел бы «внутреннюю ошибку» вместо доменной причины («Заказ не
 * найден», «Недопустимый переход статуса», «Промокод уже существует» и т.п.).
 *
 * Поле `code` сохраняет машиночитаемый код домена (not_found / invalid_transition
 * / duplicate_code / conflict / out_of_stock / ...), доступный в логах/тестах,
 * не утекающий в UI отдельно от текста сообщения.
 */
export class OrderError extends PublicActionError {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'OrderError';
    Object.setPrototypeOf(this, OrderError.prototype);
  }
}

/**
 * Сбой РЕАЛЬНО НУЖНОГО расчёта стоимости доставки (сеть/ошибка СДЭК).
 *
 * Anti-undercharge: при создании заказа нулевая доставка из-за сбоя расчёта
 * НЕДОПУСТИМА — клиент недоплатил бы за доставку (магазин теряет деньги). Раньше
 * computeDeliveryCost молча деградировал такой сбой к stub 0.00; теперь он
 * БРОСАЕТ эту ошибку, блокируя создание заказа с понятным сообщением. По-design
 * нулевая доставка (самовывоз / cdek выключен / нет назначения / порог бесплатной
 * доставки) сюда НЕ попадает — она обрабатывается до расчёта (needsCdekProvider).
 *
 * Наследует PublicActionError → message доходит до UI как доменная ошибка
 * (`error:'validation'`), а не «внутренняя ошибка». code='delivery_calc_failed'.
 */
export class DeliveryCalculationError extends PublicActionError {
  readonly code = 'delivery_calc_failed';
  /** Исходная причина (для логов/диагностики), не утекает в UI отдельно. */
  readonly cause?: unknown;
  constructor(
    message = 'Не удалось рассчитать стоимость доставки. Попробуйте позже.',
    cause?: unknown,
  ) {
    super(message);
    this.cause = cause;
    this.name = 'DeliveryCalculationError';
    Object.setPrototypeOf(this, DeliveryCalculationError.prototype);
  }
}
