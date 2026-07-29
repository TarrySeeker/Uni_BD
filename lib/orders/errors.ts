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
  /**
   * `params` — необязательные ICU-параметры, если `message` является КЛЮЧОМ
   * каталога (пайплайн зовёт t(message, params)). Нужны сообщениям, в которые
   * подставляется подпись статуса: см. conflictParams в lib/orders/actions.ts.
   * Аргумент опционален — существующие вызовы с одним лишь текстом не меняются.
   */
  constructor(code: string, message: string, params?: Record<string, string | number>) {
    super(message, params);
    this.code = code;
    this.name = 'OrderError';
    Object.setPrototypeOf(this, OrderError.prototype);
  }
}

/**
 * РЕАЛЬНО НУЖНЫЙ расчёт стоимости доставки не состоялся. Две причины:
 *   • расчёт УПАЛ (сеть/ошибка СДЭК);
 *   • считать НЕЧЕМ — нет назначения (город/индекс/ПВЗ), аудит major №3.
 *
 * Anti-undercharge: при создании заказа нулевая доставка из-за несостоявшегося
 * расчёта НЕДОПУСТИМА — клиент недоплатил бы за доставку (магазин теряет деньги).
 * Раньше computeDeliveryCost молча деградировал оба случая к stub 0.00; теперь он
 * БРОСАЕТ эту ошибку, блокируя создание заказа с понятным сообщением. Для №3 это
 * ещё и защита от повисшего заказа: без города накладную СДЭК не создать никогда.
 *
 * By-design нулевая доставка (самовывоз / cdek выключен / зона с ценой 0 / порог
 * бесплатной доставки) сюда НЕ попадает — она разводится ДО расчёта
 * (canResolveDeliveryCost + needsCdekProvider) и остаётся resolved:true.
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

/**
 * Покупатель прислал zoneId, которого НЕТ в зонах магазина (ТЗ_1 п.9).
 *
 * WHY: раньше такой id молча проваливался в общую ветку расчёта и при
 * выключенном СДЭК/без назначения давал доставку 0.00 — недоплата (владелец
 * задал 500 ₽ по МКАД, а заказ приходил с бесплатной доставкой). Теперь это
 * ЯВНАЯ доменная ошибка: quote помечает доставку нерассчитанной, createOrder
 * отказывает (code='invalid_zone').
 */
export class UnknownDeliveryZoneError extends PublicActionError {
  readonly code = 'invalid_zone';
  readonly zoneId: string;
  constructor(zoneId: string, message = 'Выбранная зона доставки недоступна. Обновите страницу и выберите зону заново.') {
    super(message);
    this.zoneId = zoneId;
    this.name = 'UnknownDeliveryZoneError';
    Object.setPrototypeOf(this, UnknownDeliveryZoneError.prototype);
  }
}
