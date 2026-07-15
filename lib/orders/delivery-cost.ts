/**
 * Адаптер расчёта стоимости доставки (docs/08 §5, пакет E Этапа 4).
 *
 * РАЗВЯЗКА orders↔cdek. Слой lib/orders НЕ должен жёстко зависеть от lib/cdek —
 * модуль cdek опционален (флаг в lib/config/modules) и может быть выключен на
 * деплое. Поэтому здесь нет статического `import … from '@/lib/cdek'`: cdek
 * подключается ЛЕНИВЫМ динамическим import-ом ТОЛЬКО когда:
 *   1) модуль cdek включён (isModuleEffectivelyEnabled('cdek') — env ⊕ БД-оверрайд), И
 *   2) тип доставки требует расчёта (не pickup), И
 *   3) есть назначение (cityCode | postalCode | pvzCode).
 * Иначе работает дефолтный stub-провайдер (0.00) — поведение Этапа 3 сохранено,
 * а сборка/тесты при выключенном cdek не тянут его транзитивно.
 *
 * ВЫБОР РЕШЕНИЯ (ленивый import vs реестр провайдеров): выбран ленивый
 * динамический import внутри адаптера. Он строго слабее реестра по связанности
 * (orders не знает о cdek на уровне типов и модульного графа), не требует точки
 * регистрации при старте процесса и естественно ложится на module-gate. Чистая
 * часть — `needsCdekProvider` (выбор провайдера) — тестируется без сети/cdek.
 *
 * Сети/БД здесь нет: при пустых CDEK_* менеджер СДЭК в mock-режиме (isCdekMock)
 * считает по формуле §5.3. Порог бесплатной доставки и промокоды применяются
 * ПОВЕРХ — в calculateQuote (lib/orders/pricing), не здесь.
 */

import { isModuleEffectivelyEnabled } from '@/lib/config/settings';
import { fromMinor } from './money';
import { DeliveryCalculationError } from './errors';
import type { DeliveryType } from './types';

export { DeliveryCalculationError } from './errors';

/**
 * Конфигурация зоны доставки (ТЗ_1) для расчёта стоимости. Деньги — в КОПЕЙКАХ.
 * Источник — эффективные настройки магазина (env ⊕ БД), НЕ тело запроса
 * (anti-tamper: цену зоны задаёт магазин, покупатель шлёт лишь id зоны).
 */
export interface DeliveryZoneConfig {
  id: string;
  label: string;
  price: number;
  freeThreshold?: number;
}

/** Позиция корзины с (опц.) габаритами товара/варианта (миграция 0018, §3.3). */
export interface DeliveryCostLine {
  qty: number;
  weightG?: number | null;
  lengthCm?: number | null;
  widthCm?: number | null;
  heightCm?: number | null;
}

/** Назначение доставки (anti-tamper: отправление — серверное, см. cdek config). */
export interface DeliveryDestination {
  cityCode?: number;
  postalCode?: string;
  pvzCode?: string;
  cityName?: string;
  /**
   * Выбранная покупателем зона доставки (ТЗ_1). Из тела доверяем только id;
   * цена берётся из настроек магазина по этому id (см. zones ниже, anti-tamper).
   */
  zoneId?: string;
}

/** Вход расчёта стоимости доставки. */
export interface DeliveryCostInput {
  deliveryType: DeliveryType;
  /** Позиции для агрегации упаковки (вес/габариты). */
  lines: readonly DeliveryCostLine[];
  destination: DeliveryDestination;
  /** Явный код тарифа; иначе — дефолт магазина (CDEK_DEFAULT_TARIFF). */
  tariffCode?: number;
  /**
   * Зоны доставки из эффективных настроек (ТЗ_1). Если задан destination.zoneId
   * и в этом списке есть зона с таким id — цена берётся из зоны (СДЭК не зовётся).
   */
  zones?: readonly DeliveryZoneConfig[];
}

/**
 * Источник расчёта (для прозрачности/аудита).
 *   • stub        — by-design 0.00 (самовывоз / cdek выключен / нет назначения);
 *   • zone        — зональная цена из настроек магазина (ТЗ_1, СДЭК не зовётся);
 *   • cdek/cdek_mock — успешный расчёт СДЭК (реальный/mock);
 *   • unavailable — расчёт БЫЛ нужен, но УПАЛ (только при softFail в quote;
 *     cost здесь НЕ доверять — витрина показывает «уточняется»).
 */
export type DeliveryCostSource = 'stub' | 'zone' | 'cdek' | 'cdek_mock' | 'unavailable';

/** Результат расчёта стоимости доставки. */
export interface DeliveryCostResult {
  /** Стоимость доставки (строка NUMERIC(14,2)). '0.00' для stub/pickup. */
  cost: string;
  /**
   * Доверять ли cost. true — by-design 0.00 ИЛИ успешный расчёт. false — расчёт
   * был нужен, но упал (source='unavailable'), cost — заглушка для совместимости
   * типа. Создание заказа НЕ принимает resolved:false (см. softFail).
   */
  resolved: boolean;
  /** Срок доставки (дней, минимум) — null для stub. */
  etaDays: number | null;
  periodMin: number | null;
  periodMax: number | null;
  tariffCode: number | null;
  source: DeliveryCostSource;
  provider: string;
}

/** Опции расчёта. */
export interface ComputeDeliveryCostOptions {
  /**
   * Мягкий сбой: при УПАВШЕМ нужном расчёте СДЭК НЕ бросать, а вернуть результат
   * с resolved:false / source:'unavailable' (для quote — витрина покажет
   * «уточняется»). По умолчанию false: сбой нужного расчёта БРОСАЕТ
   * DeliveryCalculationError (для createOrder — недопустима нулевая доставка
   * из-за сбоя, anti-undercharge).
   */
  softFail?: boolean;
}

/** Провайдер расчёта доставки (контракт развязки). */
export interface DeliveryCostProvider {
  quote(input: DeliveryCostInput): Promise<DeliveryCostResult>;
}

const STUB_RESULT: DeliveryCostResult = {
  cost: '0.00',
  resolved: true,
  etaDays: null,
  periodMin: null,
  periodMax: null,
  tariffCode: null,
  source: 'stub',
  provider: 'stub',
};

/** Дефолтный провайдер 0.00 (поведение Этапа 3). */
export const stubDeliveryProvider: DeliveryCostProvider = {
  async quote(): Promise<DeliveryCostResult> {
    return { ...STUB_RESULT };
  },
};

/**
 * Провайдер зональной цены (ТЗ_1). Цена берётся из настроек магазина (зона),
 * КОПЕЙКИ → строка NUMERIC(14,2). СДЭК не участвует. resolved:true (цена
 * авторитетна — задана магазином). Порог бесплатной доставки применяется ПОВЕРХ
 * (calculateQuote), как и для СДЭК-цены.
 */
export function zoneDeliveryProvider(zone: DeliveryZoneConfig): DeliveryCostProvider {
  return {
    async quote(): Promise<DeliveryCostResult> {
      return {
        cost: fromMinor(zone.price),
        resolved: true,
        etaDays: null,
        periodMin: null,
        periodMax: null,
        tariffCode: null,
        source: 'zone',
        provider: 'zone',
      };
    },
  };
}

/**
 * ЧИСТЫЙ выбор зоны доставки: возвращает зону из настроек по её id, если id задан
 * и зона существует, иначе undefined (→ обычный расчёт СДЭК/stub, не падение).
 * Anti-tamper: зоны — из настроек магазина, из запроса приходит только zoneId.
 */
export function resolveDeliveryZone(args: {
  zoneId?: string;
  zones?: readonly DeliveryZoneConfig[];
}): DeliveryZoneConfig | undefined {
  const { zoneId, zones } = args;
  if (!zoneId || !zones || zones.length === 0) return undefined;
  return zones.find((z) => z.id === zoneId);
}

/** Есть ли в назначении хоть один признак для расчёта СДЭК. */
function hasDestination(d: DeliveryDestination): boolean {
  return (
    d.cityCode !== undefined ||
    (d.postalCode !== undefined && d.postalCode !== '') ||
    (d.pvzCode !== undefined && d.pvzCode !== '') ||
    // Курьерская доставка из orders несёт назначение строковым cityName
    // (deliverySelectionSchema.city). Без его учёта needsCdekProvider всегда
    // возвращал false → stub 0.00, и курьерская доставка считалась бесплатной
    // (BUG #3). Имя города — валидный признак назначения: real СДЭК геокодирует
    // его через to_location.address, mock считает по весу.
    (d.cityName !== undefined && d.cityName !== '')
  );
}

/**
 * ЧИСТЫЙ выбор провайдера: нужен ли cdek-расчёт. pickup — никогда (самовывоз
 * бесплатен). cdek выключен / нет назначения — stub. Тестируется без сети.
 */
export function needsCdekProvider(args: {
  cdekEnabled: boolean;
  deliveryType: DeliveryType;
  hasDestination: boolean;
}): boolean {
  if (args.deliveryType === 'pickup') return false;
  if (!args.cdekEnabled) return false;
  return args.hasDestination;
}

/** deliveryType заказа → режим доставки СДЭК (для расчёта тарифа). */
function toDeliveryMode(deliveryType: DeliveryType): 'pvz' | 'door' {
  return deliveryType === 'courier' ? 'door' : 'pvz';
}

/**
 * Расчёт стоимости доставки. Развязка orders↔cdek через ленивый импорт.
 * Сам по себе НЕ применяет порог бесплатной доставки/промокоды — это делает
 * calculateQuote поверх возвращённого cost.
 */
export async function computeDeliveryCost(
  input: DeliveryCostInput,
  options: ComputeDeliveryCostOptions = {},
): Promise<DeliveryCostResult> {
  // ТЗ_1: зональная цена имеет приоритет над СДЭК (цена задана магазином в
  // настройках). Исключение — pickup: самовывоз бесплатен всегда, зона к нему не
  // применяется (иначе за самовывоз бы списали цену зоны — undercharge наоборот).
  if (input.deliveryType !== 'pickup') {
    const zone = resolveDeliveryZone({ zoneId: input.destination.zoneId, zones: input.zones });
    if (zone) {
      return zoneDeliveryProvider(zone).quote(input);
    }
  }

  const useCdek = needsCdekProvider({
    cdekEnabled: await isModuleEffectivelyEnabled('cdek'),
    deliveryType: input.deliveryType,
    hasDestination: hasDestination(input.destination),
  });

  if (!useCdek) {
    return stubDeliveryProvider.quote(input);
  }

  // Ленивый импорт cdek ТОЛЬКО при включённом модуле — нет статической связки.
  try {
    const [{ Calculator }, { getCdekManager }, { getCdekConfig, tariffForMode }] =
      await Promise.all([
        import('@/lib/cdek/services/calculator'),
        import('@/lib/cdek/manager'),
        import('@/lib/cdek/config'),
      ]);
    const manager = getCdekManager();
    const calc = new Calculator(manager);

    // M4 (полнота): тариф ВЫБИРАЕТСЯ ПО РЕЖИМУ доставки, когда явный tariffCode не
    // передан. Раньше при отсутствии tariffCode Calculator падал на defaultTariffCode
    // (ПВЗ-136) для ЛЮБОГО режима — курьер тарифицировался ПВЗ-тарифом (склад-склад),
    // хотя накладная создаётся по тарифу склад-дверь (137). Итог: клиент недоплачивал
    // за курьерскую доставку (anti-undercharge), магазин терял разницу. Теперь стоимость
    // заказа и накладная считаются по одному mode-aware тарифу.
    const mode = toDeliveryMode(input.deliveryType);
    const effectiveTariff = input.tariffCode ?? tariffForMode(getCdekConfig(), mode);

    const result = await calc.calculate({
      to: {
        code: input.destination.cityCode,
        postalCode: input.destination.postalCode,
        // Имя города пробрасываем как address: real СДЭК геокодирует его, когда
        // нет числового кода/индекса (BUG #3 — курьер несёт только cityName).
        address: input.destination.cityName,
      },
      lines: input.lines.map((l) => ({
        qty: l.qty,
        weightG: l.weightG ?? null,
        lengthCm: l.lengthCm ?? null,
        widthCm: l.widthCm ?? null,
        heightCm: l.heightCm ?? null,
      })),
      tariffCode: effectiveTariff,
    });

    return {
      cost: result.deliverySum,
      resolved: true,
      etaDays: result.periodMin,
      periodMin: result.periodMin,
      periodMax: result.periodMax,
      tariffCode: result.tariffCode,
      source: manager.isMock ? 'cdek_mock' : 'cdek',
      provider: 'cdek',
    };
  } catch (err) {
    // Сбой РЕАЛЬНО НУЖНОГО расчёта СДЭК (сеть/конфиг). Раньше он молча
    // деградировал к stub 0.00 — и в quote, и при СОЗДАНИИ заказа: клиент
    // недоплачивал за доставку (BUG major, undercharge).
    //   • softFail (quote): НЕ бросаем — возвращаем resolved:false /
    //     source:'unavailable', чтобы превью корзины не падало, а витрина
    //     показала «уточняется» (cost 0.00 здесь НЕ доверять).
    //   • по умолчанию (createOrder): БРОСАЕМ — нулевая доставка из-за сбоя
    //     недопустима (anti-undercharge), создание заказа блокируется.
    if (options.softFail) {
      return {
        cost: '0.00',
        resolved: false,
        etaDays: null,
        periodMin: null,
        periodMax: null,
        tariffCode: null,
        source: 'unavailable',
        provider: 'cdek',
      };
    }
    throw new DeliveryCalculationError(undefined, err);
  }
}
