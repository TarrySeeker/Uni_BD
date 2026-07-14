import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  signCallback,
  verifyCallbackSignature,
  buildCallbackAck,
  basicAuthHeader,
} from '@/lib/payments/paykeeper/token';
import type { PaykeeperCallbackParams } from '@/lib/payments/paykeeper/types';

/**
 * Юнит-тесты подписи колбэка PayKeeper (docs/24 §2). ЧИСТЫЕ, без сети/БД.
 *
 * Боевая схема (сверено со старым carre PaykeeperController.actionNotify):
 *   • подпись key = md5(id + sum + clientid + orderid + secret);
 *   • ответ ack = `OK ` + md5(id + secret) — 'OK', ОДИН пробел, hex НИЖНИЙ регистр.
 */

const SECRET = 'paykeeper-secret-word';
const PARAMS: PaykeeperCallbackParams = {
  id: '778899',
  sum: '1500.00',
  clientid: 'buyer@example.com',
  orderid: 'ADMIK-2026-000042',
  key: '',
};

describe('paykeeper/token — signCallback (md5(id+sum+clientid+orderid+secret))', () => {
  it('эталонный вектор: md5 конкатенации сырых строк = ожидаемый hex', () => {
    const expected = createHash('md5')
      .update('778899' + '1500.00' + 'buyer@example.com' + 'ADMIK-2026-000042' + SECRET, 'utf8')
      .digest('hex');
    expect(signCallback(PARAMS, SECRET)).toBe(expected);
  });

  it('результат — нижний регистр hex длиной 32', () => {
    expect(signCallback(PARAMS, SECRET)).toMatch(/^[0-9a-f]{32}$/);
  });

  it('sum подписывается СЫРОЙ строкой (переформатирование ломает подпись)', () => {
    const raw = signCallback({ ...PARAMS, sum: '1500.00' }, SECRET);
    const reformatted = signCallback({ ...PARAMS, sum: '1500' }, SECRET);
    expect(raw).not.toBe(reformatted);
  });

  it('изменение любого поля меняет подпись', () => {
    expect(signCallback({ ...PARAMS, id: '778890' }, SECRET)).not.toBe(signCallback(PARAMS, SECRET));
    expect(signCallback({ ...PARAMS, orderid: 'X' }, SECRET)).not.toBe(signCallback(PARAMS, SECRET));
  });

  it('изменение секрета меняет подпись', () => {
    expect(signCallback(PARAMS, 'other')).not.toBe(signCallback(PARAMS, SECRET));
  });
});

describe('paykeeper/token — verifyCallbackSignature (constant-time)', () => {
  it('валидный key (пересобранный тем же алгоритмом) проходит', () => {
    const key = signCallback(PARAMS, SECRET);
    expect(verifyCallbackSignature({ ...PARAMS, key }, SECRET)).toBe(true);
  });

  it('верхний регистр присланного key тоже проходит (регистронезависимо к hex)', () => {
    const key = signCallback(PARAMS, SECRET).toUpperCase();
    expect(verifyCallbackSignature({ ...PARAMS, key }, SECRET)).toBe(true);
  });

  it('подделанный key отклоняется', () => {
    expect(verifyCallbackSignature({ ...PARAMS, key: 'deadbeef' }, SECRET)).toBe(false);
  });

  it('изменённая после подписи сумма ломает верификацию (anti-tamper)', () => {
    const key = signCallback(PARAMS, SECRET);
    expect(verifyCallbackSignature({ ...PARAMS, sum: '1.00', key }, SECRET)).toBe(false);
  });

  it('пустой key → false', () => {
    expect(verifyCallbackSignature({ ...PARAMS, key: '' }, SECRET)).toBe(false);
  });

  it('пустой секрет → false', () => {
    const key = signCallback(PARAMS, SECRET);
    expect(verifyCallbackSignature({ ...PARAMS, key }, '')).toBe(false);
  });
});

describe('paykeeper/token — buildCallbackAck (`OK `+md5(id+secret))', () => {
  it('эталонный вектор: точная строка ack (OK, пробел, hex нижний)', () => {
    const hash = createHash('md5').update('778899' + SECRET, 'utf8').digest('hex');
    expect(buildCallbackAck('778899', SECRET)).toBe(`OK ${hash}`);
  });

  it('формат: начинается с "OK " + один пробел + 32 hex нижнего регистра', () => {
    expect(buildCallbackAck('778899', SECRET)).toMatch(/^OK [0-9a-f]{32}$/);
  });

  it('ack НЕ равен подписи колбэка (разные входы md5)', () => {
    expect(buildCallbackAck(PARAMS.id, SECRET)).not.toContain(signCallback(PARAMS, SECRET));
  });
});

describe('paykeeper/token — basicAuthHeader (base64 login:password)', () => {
  it('эталон: Basic + base64(login:password)', () => {
    const b64 = Buffer.from('user:pass', 'utf8').toString('base64');
    expect(basicAuthHeader('user', 'pass')).toBe(`Basic ${b64}`);
  });

  it('совместимо с carre base64_encode("login:password")', () => {
    // carre: base64_encode("{$login}:{$password}")
    expect(basicAuthHeader('shopLogin', 's3cret')).toBe(
      `Basic ${Buffer.from('shopLogin:s3cret').toString('base64')}`,
    );
  });
});
