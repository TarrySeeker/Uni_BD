/**
 * Доменные типы личного кабинета покупателя.
 *
 * Разделение на два типа покупателя намеренное: наружу отдаётся `CustomerAuth`
 * (без хеша пароля и без служебных признаков), внутри слоя аутентификации живёт
 * `CustomerAuthRow`. Так секрет физически не может «просочиться» в JSON: чтобы
 * его отдать, пришлось бы поменять тип ответа.
 */

/** Состояние учётной записи покупателя. */
export type CustomerStatus =
  /** Контакт от гостевого заказа: пароля нет, войти нельзя. */
  | 'guest'
  /** Рабочий аккаунт. */
  | 'active'
  /** Заблокирован из админки. */
  | 'disabled';

/** Аутентифицированный покупатель — то, что видит вызывающий код после проверки сессии. */
export interface CustomerAuth {
  id: string;
  email: string;
  name: string;
  phone: string | null;
  /**
   * Подтверждён ли адрес почты.
   *
   * Это не косметика, а гейт доступа: пока адрес не подтверждён, заказы,
   * оформленные гостем на тот же email, покупателю НЕ показываются. Иначе
   * регистрация на чужой адрес отдавала бы чужие заказы вместе с адресами
   * доставки и телефонами.
   */
  emailVerified: boolean;
}

/** Внутреннее представление для входа/регистрации/смены пароля. Наружу не отдаётся. */
export interface CustomerAuthRow {
  id: string;
  email: string;
  name: string;
  phone: string | null;
  /** PHC-строка argon2id; null — гость без пароля. */
  passwordHash: string | null;
  status: CustomerStatus;
  emailVerified: boolean;
}

/** Адрес доставки в адресной книге покупателя. */
export interface CustomerAddress {
  id: string;
  /** Как покупатель назвал адрес: «Дом», «Работа». */
  label: string;
  recipientName: string;
  phone: string;
  city: string;
  /**
   * Код города в справочнике службы доставки. По названию доставку не
   * рассчитать — городов-тёзок много, нужен именно код. null у магазина без
   * подключённой службы доставки.
   */
  deliveryCityCode: string | null;
  addressLine: string;
  postalCode: string;
  /** Код пункта выдачи при самовывозе; null — курьерская доставка. */
  pickupPointCode: string | null;
  isDefault: boolean;
}

/** Краткая карточка заказа для списка «Мои заказы». */
export interface CustomerOrderSummary {
  number: string;
  status: string;
  paymentStatus: string;
  deliveryStatus: string;
  grandTotal: string;
  currency: string;
  itemsCount: number;
  createdAt: string;
}

/** Назначение одноразового токена. Совпадает с CHECK в миграции 0037. */
export type CustomerTokenPurpose = 'password_reset' | 'email_verify';
