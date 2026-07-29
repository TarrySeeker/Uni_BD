/**
 * Zod-схемы входа модуля orders (docs/07 §4) — единый источник правды о форме
 * входных данных. Переиспользуются в Server Actions админки (пакет 3.C) и в
 * Storefront API (пакет 3.D): quote/создание заказа/смена статуса/CRUD промокодов.
 *
 * Правила контракта (docs/07 §2, §3):
 *  - деньги — строка NUMERIC ≥ 0 (точность не теряем, валидируем формат);
 *  - qty (количество) — целое ≥ 1;
 *  - id — uuid; статусы/типы — литералы из CHECK-ограничений БД (см. types.ts).
 *
 * Anti-tamper (ADR-010): витрине доверяем только variantId/productId + qty +
 *  выборы (доставка/промокод). Цены/итог считает сервер — поэтому в схемах
 *  создания заказа/quote НЕТ полей цены: они игнорируются по дизайну.
 */

import { z } from 'zod';

import {
  DELIVERY_STATUSES,
  DELIVERY_TYPES,
  ORDER_STATUSES,
  PAYMENT_METHODS,
  PAYMENT_STATUSES,
  PROMO_APPLY_SCOPES,
  PROMO_KINDS,
  PROMO_TARGET_TYPES,
} from './types';
import type { PromoApplyScope, PromoTargetType } from './types';
import { MIN_PHONE_DIGITS, looksLikePhone } from './phone';

// -----------------------------------------------------------------------------
// Переиспользуемые примитивы.
// -----------------------------------------------------------------------------

/** UUID-идентификатор. */
export const uuidSchema = z.string().uuid();

/**
 * Денежная сумма NUMERIC(14,2) ≥ 0 как строка (как в каталоге).
 * Принимает целое/дробное (до 2 знаков), без минуса; целая часть ≤ 12 цифр.
 */
export const moneySchema = z
  .string()
  .trim()
  .regex(
    /^\d{1,12}(?:\.\d{1,2})?$/,
    'сумма: неотрицательное число с не более чем 2 знаками после точки',
  );

/**
 * Количество единиц позиции: целое 1..10000.
 *
 * Верхняя граница (.max) — защита корректности (Fix 2): lineTotalMinor =
 * toMinor(unitPrice) × qty считается в number; при огромном qty (напр. 1e9)
 * произведение могло бы превысить Number.MAX_SAFE_INTEGER и потерять точность.
 * 10000 единиц одной позиции — заведомо выше любого реального заказа ИМ и при
 * этом удерживает арифметику в безопасном целочисленном диапазоне.
 */
export const quantitySchema = z.number().int().min(1).max(10000);

/** Максимум различных позиций в корзине/заказе (защита от DoS-нагрузки и переполнений). */
export const MAX_CART_ITEMS = 200;

/**
 * Код валюты ОТОБРАЖЕНИЯ (ISO-4217, 3 буквы) — то, в чём покупатель смотрел цены.
 *
 * Регистр НЕ навязываем схемой: канон (trim + upper) и сверку со списком валют
 * магазина делает резолвер снимка (lib/orders/display-currency). Здесь — лишь
 * дешёвая отсечка мусора/переполнения тела запроса; смысловая валидация ниже по
 * потоку, и её отказ означает «снимка нет», а не «заказ не создан»: справочное
 * поле не имеет права ронять оформление.
 */
export const displayCurrencyCodeSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{3}$/, 'валюта отображения: 3-буквенный код ISO 4217');

/** Промокод (citext в БД): непустой, без пробелов по краям, до 64 символов. */
export const promoCodeSchema = z.string().trim().min(1).max(64);

/**
 * Код подарочного сертификата (§5). Стекается ОТДЕЛЬНО от promoCode (промокод →
 * gift к остатку). Форма совпадает с giftCodeSchema (lib/gift-certificates), но
 * задаётся здесь локально во избежание циклического импорта orders↔gift-certificates
 * (gift-certificates/schemas импортирует moneySchema из этого модуля).
 */
export const giftCertificateCodeSchema = z.string().trim().min(1).max(64);

/**
 * Телефон покупателя.
 *
 * Проверка НАМЕРЕННО мягкая (см. lib/orders/phone): требуем лишь достаточное
 * число цифр. Российский формат (+7XXXXXXXXXX) здесь НЕ навязывается — магазин
 * трёхъязычный, и заказ с французским номером на самовывоз/зону обязан пройти.
 * Жёсткий гейт нужен только накладной СДЭК, и он живёт там же — плюс админка
 * предупреждает о непригодном для СДЭК номере ДО отгрузки и даёт его исправить
 * (updateOrderContact), чтобы оплаченный заказ не превращался в тупик (#8).
 */
export const phoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .refine(looksLikePhone, `телефон: нужно не менее ${MIN_PHONE_DIGITS} цифр`);

/** Контакты покупателя (гостевой чекаут — хранятся в заказе). */
export const customerContactSchema = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().email(),
  phone: phoneSchema,
});

/**
 * Выбор доставки на входе (anti-tamper: стоимость считает сервер, её здесь нет).
 * pvzCode обязателен только для type='pvz' (проверяется .superRefine ниже).
 */
export const deliverySelectionSchema = z
  .object({
    type: z.enum(DELIVERY_TYPES),
    city: z.string().trim().max(200).optional(),
    /**
     * Код города СДЭК (необязателен). Когда витрина знает числовой код города
     * (из автокомплита /cities), он пробрасывается в расчёт точнее, чем имя.
     * Если не задан — расчёт идёт по строковому `city` (geocoding в real СДЭК,
     * по весу в mock). Из тела доверяем (это не цена): итог всё равно считает
     * сервер из каталога, тариф — из whitelist (anti-tamper, ADR-010).
     */
    cityCode: z.number().int().positive().optional(),
    address: z.string().trim().max(500).optional(),
    pvzCode: z.string().trim().max(64).optional(),
    /**
     * Зона доставки (ТЗ_1): id зоны из настроек магазина. Из тела доверяем ТОЛЬКО
     * идентификатору — цену зоны сервер берёт из настроек по этому id (anti-tamper,
     * ADR-010). Опционален (обратная совместимость: витрина без зон его не шлёт).
     */
    zoneId: z.string().trim().min(1).optional(),
    /**
     * Постамат (§9): подвид ПВЗ с автоматической выдачей. Отдельным типом не
     * моделируется (CHECK delivery_type не трогаем) — флаг поверх type='pvz'.
     * Опционален (обратная совместимость: старая витрина его не шлёт → false).
     */
    isPostamat: z.boolean().optional(),
  })
  .superRefine((val, ctx) => {
    if (val.type === 'pvz' && !val.pvzCode) {
      ctx.addIssue({
        code: 'custom',
        path: ['pvzCode'],
        message: 'Для доставки в ПВЗ требуется код пункта выдачи (pvzCode).',
      });
    }
  });

/**
 * Позиция корзины на входе. Должен быть указан хотя бы один из variantId/productId
 * (variantId приоритетен). Цена НЕ принимается — сервер берёт её из каталога.
 */
export const cartLineSchema = z
  .object({
    variantId: uuidSchema.optional(),
    productId: uuidSchema.optional(),
    qty: quantitySchema,
  })
  .refine((v) => Boolean(v.variantId) || Boolean(v.productId), {
    message: 'Нужен variantId или productId.',
    path: ['variantId'],
  });

// -----------------------------------------------------------------------------
// quote — серверный расчёт корзины (POST /cart/quote, §4.2). Ничего не создаёт.
// -----------------------------------------------------------------------------

export const CartQuoteSchema = z.object({
  items: z
    .array(cartLineSchema)
    .min(1, 'Корзина пуста.')
    .max(MAX_CART_ITEMS, `Слишком много позиций (максимум ${MAX_CART_ITEMS}).`),
  promoCode: promoCodeSchema.optional(),
  /** Код подарочного сертификата — стекается поверх промокода к остатку (§5). */
  giftCertificateCode: giftCertificateCodeSchema.optional(),
  delivery: deliverySelectionSchema.optional(),
});
export type CartQuoteInput = z.infer<typeof CartQuoteSchema>;

// -----------------------------------------------------------------------------
// Создание заказа (POST /orders, §4.2). Идемпотентность — Idempotency-Key (header).
// -----------------------------------------------------------------------------

/**
 * Общая форма создания заказа (storefront + ручной заказ админки). Вынесена в
 * объект-shape, чтобы ManualOrderSchema собирался как НОВЫЙ z.object (а не
 * .extend поверх ZodEffects) — .superRefine ниже превращает схему в effects, у
 * которой нет .extend.
 */
const createOrderShape = {
  items: z
    .array(cartLineSchema)
    .min(1, 'Корзина пуста.')
    .max(MAX_CART_ITEMS, `Слишком много позиций (максимум ${MAX_CART_ITEMS}).`),
  customer: customerContactSchema,
  delivery: deliverySelectionSchema,
  paymentMethod: z.enum(PAYMENT_METHODS),
  promoCode: promoCodeSchema.optional(),
  /** Код подарочного сертификата — списывается атомарно в транзакции заказа (§5). */
  giftCertificateCode: giftCertificateCodeSchema.optional(),
  comment: z.string().trim().max(2000).optional(),
  /** Ключ идемпотентности (обычно из заголовка Idempotency-Key). */
  idempotencyKey: z.string().trim().min(1).max(200).optional(),
  /**
   * ИТОГ, КОТОРЫЙ ВИДИТ ПОКУПАТЕЛЬ на момент нажатия «Оплатить» (аудит 2026-07-26,
   * находки №2 и №9). Сервер СВЕРЯЕТ его со своим пересчитанным итогом и при
   * расхождении отказывает (`total_mismatch`) вместо тихого создания заказа.
   *
   * 🔴 Это НЕ отмена anti-tamper (ADR-010): поле никогда не становится ценой.
   * Сумма по-прежнему считается ТОЛЬКО сервером из каталога; присланное значение
   * используется исключительно как ОЖИДАНИЕ для сравнения. Подделка значения может
   * лишь отменить собственный заказ покупателя, но не удешевить его.
   *
   * ОПЦИОНАЛЬНО (аддитивность контракта): клиент, который поле не шлёт, работает
   * ровно как раньше — сверка просто не выполняется.
   */
  expectedGrandTotal: moneySchema.optional(),
  /**
   * ВАЛЮТА ОТОБРАЖЕНИЯ, в которой покупатель смотрел цены на витрине (снимок
   * 0059, ЭТАП 2 мультивалюты). Эквайринг рублёвый: платят в БАЗОВОЙ валюте, а
   * это поле фиксирует, что именно было на экране, — иначе спорный заказ через
   * неделю не разобрать (курс ЦБ меняется ежедневно, настройки перезаписываются
   * кроном).
   *
   * 🔴 ЭТО НЕ ДЕНЬГИ И НЕ КУРС. Клиент присылает ТОЛЬКО КОД валюты; курс сервер
   * читает из настроек магазина, а `display_total` считает сам от собственного
   * рублёвого итога (lib/orders/display-currency). Подделка кода может лишь
   * убрать/подменить СПРАВОЧНУЮ подпись в карточке заказа — на сумму к оплате,
   * платёжный путь и сверку с эквайером она не влияет (ADR-010 не ослаблен).
   *
   * ОПЦИОНАЛЬНО (аддитивность контракта): клиент, который поле не шлёт, работает
   * ровно как раньше — снимка просто не будет (NULL = «оформлен в базовой»).
   */
  displayCurrency: displayCurrencyCodeSchema.optional(),
};

/**
 * Требует ли ВЫБРАННЫЙ способ доставки НАЗНАЧЕНИЯ (города) для расчёта и отгрузки.
 *
 * 🔴 МУЛЬТИТЕНАНТНОСТЬ (аудит major №3): «город обязателен» — НЕ глобальное правило
 * платформы, а свойство КОНКРЕТНОГО способа доставки. Город нужен ровно там, где
 * без него доставку физически нельзя ни посчитать, ни отгрузить, — у службы
 * доставки (СДЭК: курьер и ПВЗ). НЕ нужен:
 *   • pickup — самовывоз со склада магазина;
 *   • зональная доставка (zoneId) — цену задал магазин в настройках, СДЭК не
 *     зовётся; инстанс платформы может возить сам по своим зонам без городов.
 *
 * Числовой cityCode (код города СДЭК из автокомплита) — полноценная замена
 * строковому имени: он ТОЧНЕЕ, и расчёт/накладная предпочитают именно его.
 */
function deliveryNeedsCity(delivery: {
  type?: string;
  city?: string;
  cityCode?: number;
  zoneId?: string;
}): boolean {
  if (delivery.type !== 'courier' && delivery.type !== 'pvz') return false;
  // Зональный курьер: назначение задано зоной магазина, город не требуется.
  if (delivery.zoneId?.trim()) return false;
  return true;
}

/**
 * Баг #32 (аудит тупиков): курьерская доставка ТРЕБУЕТ непустой адрес при
 * СОЗДАНИИ заказа — иначе заказ нельзя отгрузить (СДЭК/курьеру некуда везти).
 *
 * АУДИТ major №3 (+ остаток №18): вместе с адресом требуется и ГОРОД. Раньше
 * `city` оставался `.optional()` на всех уровнях, и заказ без города проходил:
 * расчёт СДЭК не находил назначения, отдавал stub `0.00` с `resolved:true`
 * («посчитали, бесплатно» вместо «посчитать нечем»), анти-андерчардж-защита не
 * срабатывала — магазин вёз бесплатно, а крон создания накладной вечно падал
 * (нет города) и заказ повисал в производстве. Дыру закрываем в трёх местах;
 * это — серверный рубеж, клиент защитой не считается.
 *
 * Проверка живёт на уровне создания заказа, а НЕ в общей deliverySelectionSchema:
 * на quote (CartQuoteSchema) ни адрес, ни город ещё не нужны (это лишь оценка
 * стоимости, и превью корзины обязано считаться до их ввода — нерассчитанность
 * там сигналится флагом resolved:false, см. lib/orders/delivery-cost). Для pvz
 * обязательность pvzCode уже в deliverySelectionSchema.superRefine.
 */
function refineCourierAddress(
  val: {
    delivery?: { type?: string; address?: string; city?: string; cityCode?: number; zoneId?: string };
  },
  ctx: z.RefinementCtx,
): void {
  const delivery = val.delivery;
  if (!delivery) return;
  if (delivery.type === 'courier' && !delivery.address?.trim()) {
    ctx.addIssue({
      code: 'custom',
      path: ['delivery', 'address'],
      message: 'Для курьерской доставки требуется адрес доставки.',
    });
  }
  if (deliveryNeedsCity(delivery) && !delivery.city?.trim() && delivery.cityCode === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['delivery', 'city'],
      message: 'Для доставки службой доставки требуется город получателя.',
    });
  }
}

export const CreateOrderSchema = z.object(createOrderShape).superRefine(refineCourierAddress);
export type CreateOrderInput = z.infer<typeof CreateOrderSchema>;

/** Ручное создание заказа в админке (source='admin'): та же форма + признак. */
export const ManualOrderSchema = z
  .object({ ...createOrderShape, source: z.literal('admin').optional() })
  .superRefine(refineCourierAddress);
export type ManualOrderInput = z.infer<typeof ManualOrderSchema>;

// -----------------------------------------------------------------------------
// Смена статусов (Server Actions §4.1; каждая пишет историю + audit).
// -----------------------------------------------------------------------------

export const ChangeOrderStatusSchema = z
  .object({
    id: uuidSchema,
    to: z.enum(ORDER_STATUSES),
    comment: z.string().trim().max(2000).optional(),
    /**
     * АДДИТИВНОЕ поле (по умолчанию false — поведение прежнее): разрешить переход
     * в «Отгружен», даже если списать резерв остатка не удалось (аудит-находка
     * #9: удалённый вариант унёс строку inventory каскадом, и commitReservation
     * возвращает false ВЕЧНО — заказ навсегда застревал в «Собран»).
     *
     * Это не «выключатель проверок»: обычный путь по-прежнему обязан списать
     * остаток, форс применяется ТОЛЬКО к позициям, по которым списание не
     * прошло, требует комментария-обоснования и попадает в историю заказа и в
     * аудит поимённо (какие SKU остались несписанными).
     */
    forceStockCommit: z.boolean().optional(),
  })
  .superRefine((val, ctx) => {
    if (val.forceStockCommit && !val.comment) {
      ctx.addIssue({
        code: 'custom',
        path: ['comment'],
        message: 'Отгрузка без списания остатка требует комментария-обоснования.',
      });
    }
  });
export type ChangeOrderStatusInput = z.infer<typeof ChangeOrderStatusSchema>;

/**
 * Правка КОНТАКТОВ и адреса доставки уже созданного заказа (аудит-находка #8).
 *
 * До этого в модуле не было НИ ОДНОГО экшена правки полей заказа: покупатель с
 * городским номером «2223344» оплачивал заказ, накладная СДЭК падала на
 * нормализации телефона, и отгрузить его было нельзя никогда — оставалось
 * возвращать деньги или править БД руками.
 *
 * Правятся только операционные контакты и адрес. Позиции, цены, суммы и статусы
 * НЕ трогаются: они снимок сделки (ADR-010) и меняются своими путями.
 */
export const UpdateOrderContactSchema = z.object({
  id: uuidSchema,
  customerName: z.string().trim().min(1).max(200),
  customerEmail: z.string().trim().email().max(200),
  customerPhone: phoneSchema,
  /** Пустая строка = очистить поле (для самовывоза/ПВЗ адрес не обязателен). */
  deliveryCity: z.string().trim().max(200).optional(),
  deliveryAddress: z.string().trim().max(500).optional(),
  /** Обоснование правки — уходит в историю заказа и в аудит. */
  reason: z.string().trim().max(2000).optional(),
});
export type UpdateOrderContactInput = z.infer<typeof UpdateOrderContactSchema>;

export const SetPaymentStatusSchema = z.object({
  id: uuidSchema,
  to: z.enum(PAYMENT_STATUSES),
  comment: z.string().trim().max(2000).optional(),
  /**
   * Подтверждение оператора «деньги возвращены вне системы» — только для to='refunded'
   * (этот переход делегируется единому денежному пути performRefund, который
   * обращается к платёжному шлюзу). Поле АДДИТИВНОЕ и опциональное: старые вызовы
   * работают как раньше, но возврат без подтверждения там, где шлюз деньги не
   * вернёт, будет отклонён (аудит 2026-07-26, критичное №7).
   */
  manualRefundAcknowledged: z.boolean().optional(),
});
export type SetPaymentStatusInput = z.infer<typeof SetPaymentStatusSchema>;

export const SetDeliveryStatusSchema = z.object({
  id: uuidSchema,
  to: z.enum(DELIVERY_STATUSES),
  comment: z.string().trim().max(2000).optional(),
});
export type SetDeliveryStatusInput = z.infer<typeof SetDeliveryStatusSchema>;

// -----------------------------------------------------------------------------
// Промокоды — CRUD (Server Actions §4.1, право orders.write).
// -----------------------------------------------------------------------------

/**
 * Таргет акции (promo_targets, §5.2.1): ровно один *_id соответствует targetType.
 * Используется при scope ≠ cart (category/brand/set).
 */
export const promoTargetSchema = z
  .object({
    targetType: z.enum(PROMO_TARGET_TYPES),
    categoryId: uuidSchema.optional(),
    brandId: uuidSchema.optional(),
    productId: uuidSchema.optional(),
    variantId: uuidSchema.optional(),
  })
  .superRefine((val, ctx) => {
    const expected: Record<(typeof PROMO_TARGET_TYPES)[number], 'categoryId' | 'brandId' | 'productId' | 'variantId'> =
      {
        category: 'categoryId',
        brand: 'brandId',
        product: 'productId',
        variant: 'variantId',
      };
    const requiredField = expected[val.targetType];
    const fields = ['categoryId', 'brandId', 'productId', 'variantId'] as const;
    for (const field of fields) {
      if (field === requiredField) {
        if (!val[field]) {
          ctx.addIssue({
            code: 'custom',
            path: [field],
            message: 'errors.orders.targetFieldRequired',
          });
        }
      } else if (val[field]) {
        ctx.addIssue({
          code: 'custom',
          path: [field],
          message: 'errors.orders.targetFieldMustBeEmpty',
        });
      }
    }
  });
export type PromoTargetInput = z.infer<typeof promoTargetSchema>;

/**
 * Допустимые типы таргета для области применения (scope), §5.2.3.
 *
 * Баг #5 (аудит тупиков): раньше scope (category/brand/set) НЕ ограничивал тип
 * таргета — подпись «Категория»/«Бренд» обещала поведение, которого не было
 * (lineInScope матчил по любому таргету). Теперь scope строго задаёт допустимые
 * типы; единый источник правды для формы (PromoForm) и серверной валидации
 * (refinePromo), чтобы UI и схема не расходились.
 *  - category → только category-таргеты;
 *  - brand    → только brand-таргеты;
 *  - set      → произвольный набор (категория/бренд/товар/вариант);
 *  - cart     → таргеты не нужны (скидка на всю корзину).
 */
export function allowedTargetTypesForScope(
  scope: PromoApplyScope,
): readonly PromoTargetType[] {
  switch (scope) {
    case 'category':
      return ['category'];
    case 'brand':
      return ['brand'];
    case 'set':
      return PROMO_TARGET_TYPES;
    case 'cart':
    default:
      return [];
  }
}

/**
 * Дата окончания промокода. Поле формы — <input type="date">, которое отдаёт
 * чистую дату «YYYY-MM-DD». z.coerce.date() трактует её как ПОЛНОЧЬ UTC, из-за
 * чего «действует по 30 июня» истекал в самом начале 30 июня (а в МСК — вечером
 * 29-го). Приводим date-only к ВКЛЮЧИТЕЛЬНОМУ концу дня (как фильтр заказов в
 * app/admin/(panel)/orders/page.tsx), чтобы код работал весь последний день.
 * Полноценный ISO со временем (если придёт) — оставляем как есть.
 */
const inclusiveEndDate = z.preprocess(
  (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T23:59:59.999Z` : v),
  z.coerce.date(),
);

const promoBaseShape = {
  code: promoCodeSchema,
  kind: z.enum(PROMO_KINDS),
  value: moneySchema.optional().default('0'),
  minOrderTotal: moneySchema.optional().default('0'),
  maxDiscount: moneySchema.nullish(),
  usageLimit: z.number().int().min(0).nullish(),
  perCustomerLimit: z.number().int().min(0).nullish(),
  startsAt: z.coerce.date().nullish(),
  endsAt: inclusiveEndDate.nullish(),
  isActive: z.boolean().optional().default(true),
  bogoBuyQty: z.number().int().min(1).nullish(),
  bogoPayQty: z.number().int().min(1).nullish(),
  // ---- N×M промо-механики (Пакет 5.P-1) ----
  applyScope: z.enum(PROMO_APPLY_SCOPES).optional().default('cart'),
  priority: z.number().int().min(0).optional().default(100),
  stackable: z.boolean().optional().default(false),
  minQty: z.number().int().min(1).nullish(),
  giftProductId: uuidSchema.nullish(),
  giftVariantId: uuidSchema.nullish(),
  giftQty: z.number().int().min(1).nullish(),
  targets: z.array(promoTargetSchema).optional().default([]),
  comment: z.string().trim().max(2000).optional().default(''),
};

/**
 * Форма для ЧАСТИЧНОГО обновления промокода (баги #17/#18, data-integrity).
 *
 * Критично: здесь у полей НЕТ `.default(...)`, в отличие от promoBaseShape.
 * Если строить update-схему как `.partial()` поверх схемы с дефолтами, Zod при
 * ОТСУТСТВИИ ключа всё равно подставляет DEFAULT (value→'0', minOrderTotal→'0',
 * isActive→true, comment→'', applyScope→'cart', priority→100, stackable→false,
 * targets→[]) — `.partial()` снимает «обязательность», но НЕ отменяет default.
 * Тогда handler через COALESCE(${default}, col) затирал бы реальные значения в
 * БД, а applyScope='cart' включал manageTargets и стирал promo_targets.
 *
 * Здесь каждое поле — `.optional()` БЕЗ default: опущенный ключ остаётся
 * `undefined`, и handler различает «ключ не передан» (не трогаем колонку/таргеты)
 * от «явный null» (очищаем колонку). nullish-поля (maxDiscount, usageLimit,
 * starts_at и т.п.) и так без default — переносятся как есть.
 */
const promoUpdateShape = {
  code: promoCodeSchema.optional(),
  kind: z.enum(PROMO_KINDS).optional(),
  value: moneySchema.optional(),
  minOrderTotal: moneySchema.optional(),
  maxDiscount: moneySchema.nullish(),
  usageLimit: z.number().int().min(0).nullish(),
  perCustomerLimit: z.number().int().min(0).nullish(),
  startsAt: z.coerce.date().nullish(),
  endsAt: inclusiveEndDate.nullish(),
  isActive: z.boolean().optional(),
  bogoBuyQty: z.number().int().min(1).nullish(),
  bogoPayQty: z.number().int().min(1).nullish(),
  // ---- N×M промо-механики (Пакет 5.P-1) ----
  applyScope: z.enum(PROMO_APPLY_SCOPES).optional(),
  priority: z.number().int().min(0).optional(),
  stackable: z.boolean().optional(),
  minQty: z.number().int().min(1).nullish(),
  giftProductId: uuidSchema.nullish(),
  giftVariantId: uuidSchema.nullish(),
  giftQty: z.number().int().min(1).nullish(),
  targets: z.array(promoTargetSchema).optional(),
  comment: z.string().trim().max(2000).optional(),
};

/**
 * Общая семантическая проверка промокода:
 *  - percent: value в диапазоне 0..100;
 *  - даты: ends_at ≥ starts_at (если обе заданы);
 *  - bogo: pay_qty < buy_qty (если оба заданы) И пара обязательна;
 *  - scope ∈ {category,brand,set}: targets непуст.
 */
function refinePromo(
  val: {
    kind?: string;
    value?: string;
    startsAt?: Date | null;
    endsAt?: Date | null;
    bogoBuyQty?: number | null;
    bogoPayQty?: number | null;
    applyScope?: string;
    targets?: unknown[];
  },
  ctx: z.RefinementCtx,
): void {
  if (val.kind === 'percent' && val.value !== undefined) {
    const pct = Number(val.value);
    if (pct > 100) {
      ctx.addIssue({
        code: 'custom',
        path: ['value'],
        message: 'errors.orders.percentRange',
      });
    }
  }
  if (val.startsAt && val.endsAt && val.endsAt < val.startsAt) {
    ctx.addIssue({
      code: 'custom',
      path: ['endsAt'],
      message: 'errors.orders.endBeforeStart',
    });
  }
  if (
    typeof val.bogoBuyQty === 'number' &&
    typeof val.bogoPayQty === 'number' &&
    val.bogoPayQty >= val.bogoBuyQty
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['bogoPayQty'],
      message: 'errors.orders.bogoPayLessBuy',
    });
  }
  // kind='bogo' ⇒ пара bogoBuyQty/bogoPayQty обязательна (§5.2.3).
  if (val.kind === 'bogo') {
    if (typeof val.bogoBuyQty !== 'number') {
      ctx.addIssue({
        code: 'custom',
        path: ['bogoBuyQty'],
        message: 'errors.orders.bogoBuyRequired',
      });
    }
    if (typeof val.bogoPayQty !== 'number') {
      ctx.addIssue({
        code: 'custom',
        path: ['bogoPayQty'],
        message: 'errors.orders.bogoPayRequired',
      });
    }
  }
  // scope ∈ {category,brand,set} ⇒ targets непуст (§5.2.3).
  if (
    val.applyScope === 'category' ||
    val.applyScope === 'brand' ||
    val.applyScope === 'set'
  ) {
    if (!Array.isArray(val.targets) || val.targets.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['targets'],
        message: 'errors.orders.scopeTargetsRequired',
      });
    } else {
      // Баг #5: тип таргета ДОЛЖЕН соответствовать области применения (иначе
      // scope=Категория с brand-таргетом «работал», нарушая обещание подписи).
      const allowed = allowedTargetTypesForScope(val.applyScope);
      val.targets.forEach((t, i) => {
        const targetType = (t as { targetType?: string } | null)?.targetType;
        if (targetType && !allowed.includes(targetType as PromoTargetType)) {
          ctx.addIssue({
            code: 'custom',
            path: ['targets', i, 'targetType'],
            message: 'errors.orders.scopeTargetTypeMismatch',
          });
        }
      });
    }
  }
  // free_delivery влияет ТОЛЬКО на доставку, а доставка считается по всей корзине,
  // а не по подмножеству товаров. Привязать «бесплатную доставку» к категории/
  // бренду/набору без двусмысленной семантики нельзя — поэтому такой промокод
  // запрещён (баг #10): бесплатная доставка возможна только при apply_scope='cart'.
  // pricing дополнительно страхует легаси-данные (scope учитывается для доставки).
  if (
    val.kind === 'free_delivery' &&
    val.applyScope !== undefined &&
    val.applyScope !== 'cart'
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['applyScope'],
      message: 'errors.orders.freeDeliveryCartOnly',
    });
  }
}

export const PromoCreateSchema = z.object(promoBaseShape).superRefine(refinePromo);
export type PromoCreateInput = z.infer<typeof PromoCreateSchema>;

export const PromoUpdateSchema = z
  .object({ id: uuidSchema, ...promoUpdateShape })
  .superRefine(refinePromo);
export type PromoUpdateInput = z.infer<typeof PromoUpdateSchema>;

export const PromoIdSchema = z.object({ id: uuidSchema });
export type PromoIdInput = z.infer<typeof PromoIdSchema>;
