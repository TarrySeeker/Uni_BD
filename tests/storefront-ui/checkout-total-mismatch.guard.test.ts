import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, it, expect } from 'vitest';

import { getDictionary } from '../../storefront/lib/dictionaries';
import type { Locale } from '../../storefront/lib/i18n';

/**
 * GUARD: покупатель платит РОВНО ту сумму, которую видит.
 *
 * ДЕФЕКТЫ (аудит 2026-07-26):
 *   • major №2 — повторный submit после сбоя шлюза оплачивает СТАРЫЙ заказ.
 *     `idemKeyRef` создавался один раз (`if (!idemKeyRef.current)`) и НИКОГДА не
 *     сбрасывался. Сбой init оплаты → покупатель вводит промокод (12000 → 9600) →
 *     жмёт «Оплатить» → тот же Idempotency-Key → сервер возвращает reused-заказ со
 *     СТАРЫМИ суммами → покупателя ведут платить 12000.
 *   • major №9 — сервер молча применил МЕНЬШИЙ сертификат. Витрина показала
 *     «покрывает весь заказ», сервер пересчитал списание из свежего остатка
 *     (баланс потратили параллельно) и создал заказ с ненулевым grandTotal.
 *     Клиент проверял ровно `paymentStatus==='paid' || grandTotal===0` и в
 *     остальных случаях БЕЗУСЛОВНО уходил на оплату.
 *
 * Правила, которые сторожим:
 *   1) ключ идемпотентности ПРИВЯЗАН К СОСТАВУ заказа (recalcSignature), а не к
 *      жизни компонента — смена промокода/сертификата/доставки даёт НОВЫЙ ключ
 *      (при этом сам механизм идемпотентности сохранён: повтор без изменений
 *      состава переиспользует тот же ключ и не плодит заказы);
 *   2) витрина сообщает серверу ОЖИДАЕМЫЙ итог (`expectedGrandTotal`);
 *   3) витрина СВЕРЯЕТ фактический `order.grandTotal` с `quote.grandTotal` после
 *      создания и при расхождении НЕ уводит на оплату автоматически;
 *   4) объяснение покупателю — из словаря, на всех трёх языках, без хардкода.
 *
 * storefront/ вне корневого tsconfig и не покрыт React-тестами (environment
 * 'node') — сторожим СУТЬ чтением исходника, как соседние guard-ы.
 */

const ROOT = resolve(__dirname, '../..');
const read = (p: string): string => readFileSync(resolve(ROOT, p), 'utf8');

const FORM = 'storefront/app/[lang]/cart/order/CheckoutForm.tsx';
const API = 'storefront/lib/api.ts';
const TYPES = 'storefront/lib/types.ts';

const LOCALES: Locale[] = ['ru', 'en', 'fr'];

describe('находка №2 — ключ идемпотентности привязан к составу заказа', () => {
  const form = read(FORM);

  it('🔴 прежнего «создать один раз и никогда не сбрасывать» больше нет', () => {
    // Первопричина: ключ рождался при первом submit и жил до перезагрузки страницы.
    expect(form).not.toMatch(/if\s*\(\s*!idemKeyRef\.current\s*\)/);
  });

  it('🔴 ключ пересоздаётся при смене recalcSignature (промокод/сертификат/доставка)', () => {
    // Сигнатура состава — единственный источник правды о «том же самом заказе».
    expect(form).toMatch(/idemSignatureRef|idemKeyRef/);
    // Ключ выдаётся по сигнатуре: функция обязана её принимать/читать.
    const at = form.indexOf('function ensureIdemKey');
    expect(at, 'ensureIdemKey должен остаться единой точкой выдачи ключа').toBeGreaterThan(-1);
    // Сигнатура состава обязана дойти до выдачи ключа: либо читается внутри
    // ensureIdemKey, либо передаётся ей аргументом на вызове.
    expect(form).toMatch(/ensureIdemKey\(\s*recalcSignature\s*\)/);
  });

  it('идемпотентность НЕ сломана: тот же состав → тот же ключ', () => {
    const at = form.indexOf('function ensureIdemKey');
    // До конца тела функции (следующая декларация верхнего уровня), а не N символов:
    // фиксированное окно ломалось бы от любого добавленного комментария.
    const body = form.slice(at, form.indexOf('\n  }', at));
    // Есть ветка переиспользования (сравнение сигнатур), а не безусловный randomUUID.
    expect(body).toMatch(/===|!==/);
    expect(body).toContain('randomUUID');
    // Ключ хранится между попытками (ref), иначе ретрай плодил бы заказы.
    expect(form).toContain('idemKeyRef');
  });
});

describe('находки №2/№9 — сверка ожидаемого итога с фактическим', () => {
  const form = read(FORM);
  const api = read(API);
  const types = read(TYPES);

  /**
   * Тело обработчика submit — от создания заказа до конца функции. Границу берём
   * по КОДУ, а не по фиксированному числу символов: окно вида `slice(at, at+3000)`
   * ломается от любого добавленного комментария и создаёт ложные падения.
   */
  const submitBody = (() => {
    const at = form.indexOf('const order = await createOrder(');
    expect(at, 'создание заказа должно быть в обработчике submit').toBeGreaterThan(-1);
    const end = form.indexOf('\n  if (!mounted)', at);
    return form.slice(at, end > at ? end : form.length);
  })();

  it('🔴 витрина шлёт серверу ожидаемый итог (expectedGrandTotal)', () => {
    expect(form).toContain('expectedGrandTotal');
    // Ожидаемый итог = ровно то, что показано в блоке «Итого» (quote.grandTotal),
    // снятое ДО запроса (значение фиксируется в переменной, чтобы сверка после
    // ответа шла с тем же числом, которое видел покупатель).
    expect(form).toMatch(/const\s+expectedGrandTotal\s*=\s*quote\??\.grandTotal/);
  });

  it('поле объявлено в типе запроса и опционально (аддитивность контракта)', () => {
    expect(types).toMatch(/expectedGrandTotal\?:\s*string/);
    expect(api).toContain('CreateOrderRequest');
  });

  it('🔴 после создания заказа фактический итог сверяется с показанным', () => {
    // Клиентская сверка — вторая линия обороны (сервер может быть старой версии).
    expect(form).toMatch(/order\.grandTotal/);
    const after = submitBody;
    expect(after, 'сверка должна идти сразу после создания заказа').toContain('order.grandTotal');
    // Сверяем с тем, что видел покупатель (снимок quote.grandTotal до запроса).
    expect(after).toContain('expectedGrandTotal');
  });

  it('🔴 при расхождении покупателя НЕ уводят на оплату автоматически', () => {
    const after = submitBody;
    // Есть ранний выход ДО инициации оплаты. Имя функции инициации исторически
    // менялось (initPaykeeperPayment → initPayment, когда эквайера стал выбирать
    // сервер) — ищем любое из них, чтобы гвард не ломался на переименовании.
    const mismatchAt = after.indexOf('totalMismatch');
    const payMatch = after.match(/init(?:Paykeeper)?Payment\s*\(/);
    const payAt = payMatch ? after.indexOf(payMatch[0]) : -1;
    expect(payAt, 'инициация оплаты должна быть найдена').toBeGreaterThan(-1);
    expect(mismatchAt, 'ветка расхождения должна существовать').toBeGreaterThan(-1);
    expect(mismatchAt, 'расхождение проверяется ДО инициации оплаты').toBeLessThan(payAt);
    // Корзину при расхождении НЕ чистим — покупателю ещё предстоит решение.
    expect(after.slice(mismatchAt, payAt)).toMatch(/return/);
  });

  it('🔴 сверка идёт по КОПЕЙКАМ, а не по строкам (12000 ≠ "12000.00")', () => {
    // Строковое сравнение '9600' vs '9600.00' дало бы ложное расхождение.
    expect(form).toMatch(/Number\(order\.grandTotal\)|toMinor|Math\.round/);
  });

  it('покупателю показывают ОБЕ суммы — старую и новую', () => {
    const at = form.indexOf('totalMismatch');
    expect(at).toBeGreaterThan(-1);
    // Сообщение — шаблон словаря с подстановкой сумм (fillTemplate уже используется).
    expect(form).toContain('fillTemplate');
    expect(form).toMatch(/orderTotalChanged|totalMismatch/);
  });
});

describe('тексты о расхождении суммы — во всех трёх локалях, без хардкода', () => {
  const form = read(FORM);

  it.each(LOCALES)('локаль %s: строки объявлены и не пусты', (locale) => {
    const t = getDictionary(locale).checkout;
    const dict = t as unknown as Record<string, string>;
    for (const key of ['orderTotalChanged', 'orderTotalChangedAction', 'orderErrorTotalMismatch']) {
      expect(dict[key], `${locale}.${key}`).toBeTruthy();
      expect(typeof dict[key], `${locale}.${key}`).toBe('string');
    }
  });

  it('🔴 шаблон расхождения несёт плейсхолдеры обеих сумм', () => {
    for (const locale of LOCALES) {
      const dict = getDictionary(locale).checkout as unknown as Record<string, string>;
      expect(dict.orderTotalChanged, locale).toContain('{expected}');
      expect(dict.orderTotalChanged, locale).toContain('{actual}');
    }
  });

  it('🔴 en/fr не содержат кириллицы (магазин трёхъязычный)', () => {
    for (const locale of ['en', 'fr'] as Locale[]) {
      const dict = getDictionary(locale).checkout as unknown as Record<string, string>;
      for (const key of [
        'orderTotalChanged',
        'orderTotalChangedAction',
        'orderErrorTotalMismatch',
      ]) {
        expect(dict[key], `${locale}.${key}`).not.toMatch(/[А-Яа-яЁё]/);
      }
    }
  });

  it('🔴 в компоненте нет русского литерала о смене суммы (только словарь)', () => {
    // Ловим попытку захардкодить объяснение мимо dictionaries.ts.
    const at = form.indexOf('totalMismatch');
    const around = form.slice(Math.max(0, at - 500), at + 1500);
    // Кириллица допустима только в комментариях; строковых литералов быть не должно.
    // Литерал — БЕЗ переносов строк (иначе регексп склеивает два апострофа через
    // многострочный комментарий и ловит ложное срабатывание).
    const stringLiterals = around.match(/'[^'\n]*[А-Яа-яЁё][^'\n]*'/g) ?? [];
    expect(stringLiterals, 'русские строковые литералы вместо словаря').toEqual([]);
  });
});
