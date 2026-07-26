import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, it, expect } from 'vitest';

/**
 * GUARD: покупатель может ПОТРАТИТЬ подарочный сертификат на чекауте.
 *
 * ДЕФЕКТ: магазин продавал сертификаты, серверный слой умел их применять
 * (CartQuoteSchema.giftCertificateCode, CreateOrderSchema.giftCertificateCode,
 * QuoteDto.gift), но на витрине ПОЛЯ ДЛЯ КОДА НЕ БЫЛО — предъявить сертификат
 * было физически негде. Правило: код сертификата вводится рядом с промокодом,
 * уходит И в /cart/quote, И в /orders; результат применения (сколько списано,
 * остаток, человекочитаемая причина отказа) виден покупателю.
 *
 * 🔴 Второе правило: сырой машинный reason НИКОГДА не рендерится покупателю —
 * неизвестный код падает в общий человекочитаемый текст словаря.
 *
 * storefront/ исключён из корневого tsconfig/eslint и не покрыт React-тестами
 * (environment 'node') — сторожим СУТЬ чтением исходника, как соседние guard-ы.
 */

const ROOT = resolve(__dirname, '../..');
const read = (p: string): string => readFileSync(resolve(ROOT, p), 'utf8');

const FORM = 'storefront/app/[lang]/cart/order/CheckoutForm.tsx';
const TYPES = 'storefront/lib/types.ts';
const DICT = 'storefront/lib/dictionaries.ts';
/**
 * Карты «машинный код → строка словаря» переехали из компонента в чистый модуль
 * (аудит №3/№6: внутри клиентского компонента они не тестировались и разошлись с
 * доменным алфавитом). Инвариант тот же — сторожим его по новому месту.
 */
const ERRORS = 'storefront/lib/checkout-errors.ts';

/** Причины отказа сертификата, реально достижимые в /cart/quote. */
const GIFT_REASONS = ['not_found', 'expired', 'depleted', 'disabled', 'no_amount_due'] as const;

/** Ключи словаря блока сертификата на чекауте (без причин отказа). */
const GIFT_UI_KEYS = [
  'giftCode',
  'giftCodePlaceholder',
  'giftCodeApply',
  'giftCodeRemove',
  'giftCodeApplied',
  'giftCodeNotApplied',
  'giftCodeCovered',
  'giftCodeRemaining',
  'giftCodeFullyCovered',
  'submitGiftCovered',
] as const;

/** Ключи причин отказа: not_found → giftReasonNotFound и т.д. */
const reasonKey = (reason: string): string =>
  'giftReason' + reason.replace(/(^|_)([a-z])/g, (_m, _s, c: string) => c.toUpperCase());

describe('CheckoutForm — поле кода подарочного сертификата', () => {
  const src = read(FORM);

  it('в форме есть отдельное состояние кода сертификата и кнопки применить/убрать', () => {
    expect(src).toMatch(/useState.*giftInput|const \[giftInput/);
    expect(src).toMatch(/const \[appliedGift/);
    expect(src).toMatch(/function applyGift\(/);
    expect(src).toMatch(/function removeGift\(/);
  });

  it('есть input с placeholder из словаря и подпись секции', () => {
    expect(src).toContain('t.giftCodePlaceholder');
    expect(src).toContain('t.giftCode');
    expect(src).toContain('t.giftCodeApply');
    expect(src).toContain('t.giftCodeRemove');
    // Значение поля связано со состоянием (контролируемый input); обработчик
    // ввода может быть как прямым сеттером, так и функцией-обёрткой.
    expect(src).toMatch(/value=\{giftInput\}/);
    expect(src).toMatch(/(setGiftInput|changeGiftInput)\(e\.target\.value\)/);
    expect(src).toMatch(/function changeGiftInput|setGiftInput\(/);
  });

  it('🔴 код уходит в /cart/quote', () => {
    // В теле quoteCart — условное поле giftCertificateCode.
    const at = src.indexOf('quoteCart(');
    expect(at).toBeGreaterThan(-1);
    const body = src.slice(at, at + 600);
    expect(body).toMatch(/appliedGift \? \{ giftCertificateCode: appliedGift \} : \{\}/);
  });

  it('🔴 код уходит в /orders (createOrder)', () => {
    const at = src.indexOf('await createOrder(');
    expect(at).toBeGreaterThan(-1);
    const body = src.slice(at, at + 900);
    expect(body).toMatch(/appliedGift \? \{ giftCertificateCode: appliedGift \} : \{\}/);
  });

  it('смена кода сертификата вызывает пересчёт (входит в сигнатуру recalc)', () => {
    const at = src.indexOf('recalcSignature');
    expect(at).toBeGreaterThan(-1);
    const body = src.slice(at, src.indexOf('useEffect', at));
    expect(body).toMatch(/gift:\s*appliedGift/);
  });

  it('покупателю показаны списанная сумма и остаток сертификата', () => {
    expect(src).toContain('t.giftCodeCovered');
    expect(src).toContain('t.giftCodeRemaining');
    expect(src).toMatch(/appliedAmount/);
    expect(src).toMatch(/balanceRemainingAfter/);
  });

  it('полное покрытие: онлайн-оплата не инициируется, покупатель уходит на success', () => {
    const at = src.indexOf('await createOrder(');
    const tail = src.slice(at);
    // Ветка полного покрытия ДО initPaykeeperPayment.
    const guard = tail.indexOf("paymentStatus === 'paid'");
    const init = tail.indexOf('initPaykeeperPayment(');
    expect(guard).toBeGreaterThan(-1);
    expect(init).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(init);
    expect(tail.slice(guard, init)).toContain('return');
  });
});

describe('🔴 Подписи ошибок — сырой машинный код не рендерится покупателю', () => {
  const src = read(FORM);
  const labels = read(ERRORS);

  it('подпись причины отказа сертификата падает в текст словаря, а не в код', () => {
    const at = labels.indexOf('function giftReasonLabel');
    expect(at, 'нет giftReasonLabel').toBeGreaterThan(-1);
    const body = labels.slice(at, labels.indexOf('\n}', at));
    for (const reason of GIFT_REASONS) {
      expect(body, `нет ветки ${reason}`).toContain(`${reason}: t.${reasonKey(reason)}`);
    }
    // Фолбэк — человекочитаемая строка словаря, НЕ сырой reason.
    expect(body).toContain('?? t.giftCodeNotApplied');
    expect(body).not.toMatch(/\?\?\s*reason/);
  });

  it('reason нигде не выводится в JSX напрямую', () => {
    expect(src).not.toMatch(/\{\s*(quote\.)?gift\.reason\s*\}/);
    expect(src).not.toMatch(/\{\s*gift\?\.reason\s*\}/);
  });

  it('старая утечка «?? code» в подписи проблем позиций устранена', () => {
    const at = labels.indexOf('function issueLabel');
    expect(at).toBeGreaterThan(-1);
    const body = labels.slice(at, labels.indexOf('\n}', at));
    expect(body).not.toMatch(/\?\?\s*code\s*;/);
    expect(body).toMatch(/\?\?\s*t\./);
  });
});

/**
 * Тело <fieldset> секции подарочного сертификата (по легенде {t.giftCode}).
 * Нужен именно этот блок: проверяем, ЧТО показано в ветке принятого кода, а что —
 * в ветке отклонённого.
 */
function giftFieldset(src: string): string {
  const legend = src.indexOf('{t.giftCode}');
  expect(legend, 'нет секции сертификата').toBeGreaterThan(-1);
  const start = src.lastIndexOf('<fieldset', legend);
  const end = src.indexOf('</fieldset>', legend);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

describe('🔴 CheckoutForm — отклонённый код НЕ выглядит применённым', () => {
  const src = read(FORM);
  const block = giftFieldset(src);
  const split = block.indexOf(') : (');
  const accepted = split > -1 ? block.slice(0, split) : block;
  const rejected = split > -1 ? block.slice(split) : '';

  it('секция разделена на ветки «код принят» / «код не принят»', () => {
    expect(split, 'нет ветвления по факту применения').toBeGreaterThan(-1);
    // Ветка «применён» условлена ФАКТОМ применения, а не наличием введённого кода.
    expect(accepted).toMatch(/\{\s*(giftAccepted|giftApplied)\s*\?/);
    expect(accepted).not.toMatch(/\{\s*appliedGift\s*\?/);
  });

  it('«Применён:» рендерится ТОЛЬКО в ветке принятого кода', () => {
    expect(accepted).toContain('t.giftCodeApplied');
    expect(rejected, 'самоотрицающая фраза «Применён: … — не найден»').not.toContain(
      't.giftCodeApplied',
    );
    // Причина отказа НЕ имеет права стоять рядом с «Применён:» — это и была
    // самоотрицающая фраза «Применён: ABCD-1234 — Сертификат … не найден.».
    expect(accepted, 'причина отказа в ветке «применён»').not.toContain('giftReasonLabel');
  });

  it('при отказе НЕ рисуются «Списано …» / «Остаток …» с нулями', () => {
    expect(accepted).toContain('t.giftCodeCovered');
    expect(accepted).toContain('t.giftCodeRemaining');
    for (const leak of ['t.giftCodeCovered', 't.giftCodeRemaining', 'appliedAmount', 'balanceRemainingAfter']) {
      expect(rejected, `${leak} в ветке отказа`).not.toContain(leak);
    }
  });

  it('при отказе поле ввода доступно, значение не потеряно, причина человекочитаема', () => {
    expect(rejected).toMatch(/value=\{giftInput\}/);
    expect(rejected).toContain('giftReasonLabel(');
    // Явная подсказка «исправьте код и попробуйте снова» — из словаря.
    expect(rejected).toContain('t.giftCodeRetry');
  });

  it('признак отказа опирается на applied=false И на эхо ИМЕННО этого кода', () => {
    const at = src.indexOf('const giftRejected');
    expect(at, 'нет флага giftRejected').toBeGreaterThan(-1);
    const decl = src.slice(at, src.indexOf(';', at));
    expect(decl).toMatch(/!gift\.applied/);
    expect(decl).toMatch(/gift\.code === appliedGift|appliedGift === gift\.code/);
  });
});

describe('🔴 CheckoutForm — код сертификата нормализуется к хранимому виду', () => {
  const src = read(FORM);

  it('форма использует normalizeGiftCode, а не сырой trim()', () => {
    expect(src).toMatch(/normalizeGiftCode/);
    expect(src).toMatch(/from '@\/lib\/gift-code'/);
    const at = src.indexOf('function applyGift');
    expect(at).toBeGreaterThan(-1);
    const body = src.slice(at, src.indexOf('\n  }', at));
    expect(body).toContain('normalizeGiftCode');
    expect(body, 'сырой trim() отправлял код с чужими разделителями').not.toMatch(
      /giftInput\.trim\(\)/,
    );
  });

  it('кнопка «Применить» включена по нормализованному значению', () => {
    // disabled по сырой строке пропускал бы ввод из одних пробелов/тире.
    expect(src).not.toMatch(/disabled=\{giftInput\.trim\(\)\.length === 0\}/);
    expect(src).toMatch(/normalizedGift/);
  });
});

describe('🔴 CheckoutForm — легал-текст соответствует кнопке', () => {
  const src = read(FORM);

  it('при полном покрытии сертификатом под кнопкой другой легал-текст', () => {
    expect(src).toMatch(/giftFullyCovered \? t\.legalGiftCovered : t\.legal/);
  });
});

describe('🔴 CheckoutForm — сырое серверное сообщение не доезжает до покупателя', () => {
  const src = read(FORM);

  it('humanError не возвращает err.message ни в одной ветке', () => {
    const at = src.indexOf('function humanError');
    expect(at).toBeGreaterThan(-1);
    const body = src.slice(at, src.indexOf('\n}', at));
    expect(body, 'русский текст сервера уехал бы французу').not.toMatch(/err\.message/);
    expect(body).toContain('t.orderErrorGeneric');
    // Техническая информация — только в лог.
    expect(body).toMatch(/console\.(error|warn)/);
  });

  it('во ВСЁМ файле нет ни одной утечки .message / сырого кода в UI', () => {
    expect(src).not.toMatch(/err\.message/);
    expect(src).not.toMatch(/\?\?\s*(code|reason|err)\b/);
  });

  it('сетевой сбой и rate-limit получили свои человекочитаемые тексты', () => {
    const labels = read(ERRORS);
    const at = labels.indexOf('function orderErrorLabel');
    expect(at, 'нет orderErrorLabel').toBeGreaterThan(-1);
    const body = labels.slice(at, labels.indexOf('\n}', at));
    expect(body).toContain('network: t.orderErrorNetwork');
    expect(body).toContain('rate_limited: t.orderErrorRateLimited');
  });
});

describe('storefront/lib/types.ts — типы запросов позволяют передать код', () => {
  const src = read(TYPES);

  /** Тело именованного интерфейса до закрывающей скобки уровня 0. */
  function block(source: string, header: string): string {
    const at = source.indexOf(header);
    expect(at, `${header} не найден`).toBeGreaterThan(-1);
    let depth = 0;
    for (let i = source.indexOf('{', at); i < source.length; i++) {
      if (source[i] === '{') depth++;
      else if (source[i] === '}' && --depth === 0) return source.slice(at, i + 1);
    }
    throw new Error(`не удалось выделить тело ${header}`);
  }

  it('CartQuoteRequest и CreateOrderRequest несут giftCertificateCode', () => {
    for (const header of [
      'export interface CartQuoteRequest',
      'export interface CreateOrderRequest',
    ]) {
      expect(block(src, header), header).toMatch(/giftCertificateCode\?: string;/);
    }
  });

  it('QuoteDto.gift типизирован (не unknown) — витрине нужны applied/суммы/reason', () => {
    const dto = block(src, 'export interface QuoteDto');
    expect(dto).not.toMatch(/gift:\s*unknown/);
    expect(dto).toMatch(/gift:\s*GiftQuoteDto \| null;/);
    const gift = block(src, 'export interface GiftQuoteDto');
    for (const field of [
      'applied: boolean;',
      'appliedAmount: string;',
      'balanceRemainingAfter: string;',
      'reason: string | null;',
    ]) {
      expect(gift, field).toContain(field);
    }
  });
});

describe('словари витрины — блок сертификата во ВСЕХ трёх локалях', () => {
  const dict = read(DICT);
  const keys = [...GIFT_UI_KEYS, ...GIFT_REASONS.map(reasonKey)];

  it('каждый ключ объявлен в интерфейсе и заполнен в ru/en/fr (4 вхождения)', () => {
    for (const key of keys) {
      const count = dict.split(`${key}:`).length - 1;
      expect(count, `${key}: интерфейс + ru/en/fr`).toBe(4);
    }
  });

  it('нет ни одного пустого значения', () => {
    for (const key of keys) {
      expect(dict, key).not.toMatch(new RegExp(`${key}:\\s*['"]['"]`));
    }
  });

  it('русский/английский/французский тексты причин действительно разные', () => {
    for (const reason of GIFT_REASONS) {
      const key = reasonKey(reason);
      const values = [...dict.matchAll(new RegExp(`${key}:\\s*'([^']+)'`, 'g'))].map((m) => m[1]!);
      expect(values.length, `${key}: три значения`).toBe(3);
      expect(new Set(values).size, `${key}: локали не должны совпадать`).toBe(3);
      // Русский — только первый (порядок словарей ru→en→fr); en/fr без кириллицы.
      expect(values[0]).toMatch(/[А-Яа-яЁё]/);
      expect(values[1]).not.toMatch(/[А-Яа-яЁё]/);
      expect(values[2]).not.toMatch(/[А-Яа-яЁё]/);
    }
  });

  it('французский — настоящий французский, а не английская копия', () => {
    expect(dict).toContain('Carte cadeau introuvable.');
    expect(dict).toContain('Saisissez le code de la carte cadeau');
  });

  it('шаблоны суммы/остатка несут подстановку {amount} во всех локалях', () => {
    for (const key of ['giftCodeCovered', 'giftCodeRemaining']) {
      const values = [...dict.matchAll(new RegExp(`${key}:\\s*'([^']+)'`, 'g'))].map((m) => m[1]!);
      expect(values.length, key).toBe(3);
      for (const v of values) expect(v, `${key}: ${v}`).toContain('{amount}');
    }
  });

  it('🔴 новые ключи (отказ/легал/ошибки) есть во всех трёх локалях и различны', () => {
    const newKeys = [
      'giftCodeRetry',
      'legalGiftCovered',
      'orderErrorNetwork',
      'orderErrorRateLimited',
    ];
    for (const key of newKeys) {
      expect(dict.split(`${key}:`).length - 1, `${key}: интерфейс + ru/en/fr`).toBe(4);
      const values = [...dict.matchAll(new RegExp(`${key}:\\s*'([^']+)'`, 'g'))].map((m) => m[1]!);
      expect(values.length, `${key}: три значения`).toBe(3);
      expect(new Set(values).size, `${key}: локали не должны совпадать`).toBe(3);
      expect(values[0], `${key}: ru`).toMatch(/[А-Яа-яЁё]/);
      expect(values[1], `${key}: en`).not.toMatch(/[А-Яа-яЁё]/);
      expect(values[2], `${key}: fr`).not.toMatch(/[А-Яа-яЁё]/);
    }
  });

  it('🔴 легал-текст цитирует РЕАЛЬНУЮ подпись кнопки в каждой локали', () => {
    const values = (key: string): string[] =>
      [...dict.matchAll(new RegExp(`${key}:\\s*'([^']+)'`, 'g'))].map((m) => m[1]!);
    const pairs: [string, string][] = [
      ['legal', 'submit'],
      ['legalGiftCovered', 'submitGiftCovered'],
    ];
    for (const [legalKey, buttonKey] of pairs) {
      const legals = values(legalKey);
      const buttons = values(buttonKey);
      expect(legals.length, legalKey).toBe(3);
      expect(buttons.length, buttonKey).toBe(3);
      for (let i = 0; i < 3; i++) {
        expect(legals[i], `${legalKey}[${i}] должен цитировать «${buttons[i]}»`).toContain(
          buttons[i]!,
        );
      }
    }
  });

  it('🔴 легал полного покрытия не обещает онлайн-оплату', () => {
    const covered = [...dict.matchAll(/legalGiftCovered:\s*'([^']+)'/g)].map((m) => m[1]!);
    expect(covered.length).toBe(3);
    for (const v of covered) {
      expect(v, `обещание оплаты в «${v}»`).not.toMatch(
        /Оплата производится онлайн|Payment is made online|paiement s’effectue en ligne/,
      );
    }
    // ru-версия прямо говорит, что платить не нужно.
    expect(covered[0]).toMatch(/не требуется|не нужн/i);
  });

  it('🔴 в добавленных ключах только строки (функции ломают prerender)', () => {
    for (const key of keys) {
      let from = 0;
      for (;;) {
        const at = dict.indexOf(`${key}:`, from);
        if (at < 0) break;
        expect(dict.slice(at, at + 300)).not.toMatch(/^[^\n]*=>/m);
        from = at + key.length;
      }
    }
  });
});
