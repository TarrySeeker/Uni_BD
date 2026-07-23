import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, it, expect } from 'vitest';

/**
 * GUARD-тесты вёрстки админки сертификатов (тестов React-компонентов в проекте
 * нет — environment 'node'). Сторожат СУТЬ, а не подстроку: правильный вызов
 * присутствует И антипаттерн запрещён.
 */

function src(rel: string): string {
  return readFileSync(path.join(process.cwd(), rel), 'utf8');
}

const LIST = src('app/admin/(panel)/gift-certificates/page.tsx');
const FORM = src('app/admin/(panel)/gift-certificates/_components/GiftCertificateForm.tsx');
const ORDER_PAGE = src('app/admin/(panel)/orders/[id]/page.tsx');
const GIFT_BLOCK = src('app/admin/(panel)/orders/[id]/_components/GiftIssueBlock.tsx');

describe('список сертификатов — колонки «кто купил» / «на чьё имя»', () => {
  it('колонки есть и берут данные из домена, а не из заглушки', () => {
    expect(LIST).toContain('Кто купил');
    expect(LIST).toContain('На чьё имя');
    expect(LIST).toContain('partyLabel(c.purchaser)');
    expect(LIST).toContain('partyLabel(c.recipient)');
  });
});

describe('карточка сертификата — форма сторон сделки', () => {
  it('оба блока отправляются И в issue, И в update (иначе поля молча теряются)', () => {
    const issueCall = FORM.slice(FORM.indexOf('issueGiftCertificateAction({'));
    const updateCall = FORM.slice(
      FORM.indexOf('updateGiftCertificateAction({'),
      FORM.indexOf('issueGiftCertificateAction({'),
    );
    for (const chunk of [issueCall, updateCall]) {
      expect(chunk).toContain('purchaser,');
      expect(chunk).toContain('recipient,');
    }
  });

  it('поля инициализируются снимком сертификата, а не именем клиента из другого источника', () => {
    expect(FORM).toContain('cert?.purchaser.name');
    expect(FORM).toContain('cert?.recipient.name');
    expect(FORM).not.toMatch(/customer\??\.name/);
  });
});

describe('карточка заказа — блок выпуска сертификата', () => {
  it('номинал считается ЧИСТОЙ функцией из снимка позиции', () => {
    expect(ORDER_PAGE).toContain('giftFaceValueFromItem(it)');
    // Антипаттерн: подставить цену каталога/сырую unit_price вместо снимка позиции.
    expect(ORDER_PAGE).not.toMatch(/faceValue:\s*it\.unitPrice/);
    expect(ORDER_PAGE).not.toMatch(/faceValue:\s*.*product/i);
  });

  it('признак «позиция — сертификат» берётся из снимка, а не из категории каталога', () => {
    expect(ORDER_PAGE).toContain('certificateItemHint(it)');
    expect(ORDER_PAGE).not.toMatch(/['"]certificates['"]/);
    expect(ORDER_PAGE).not.toMatch(/categor/i);
  });

  it('блок виден по gift.read, кнопка выпуска — по gift.write', () => {
    expect(ORDER_PAGE).toContain("can(guard.user, 'gift.read')");
    expect(ORDER_PAGE).toContain("canWrite={can(guard.user, 'gift.write')}");
  });

  it('форма выпуска НЕ даёт ввести номинал (сервер берёт его из снимка)', () => {
    expect(GIFT_BLOCK).toContain('issueGiftFromOrderAction({');
    expect(GIFT_BLOCK).toContain('orderItemId: itemId');
    // Антипаттерн: номинал во входе действия — админ смог бы выпустить код
    // дороже, чем покупатель заплатил.
    const payload = GIFT_BLOCK.slice(
      GIFT_BLOCK.indexOf('issueGiftFromOrderAction({'),
      GIFT_BLOCK.indexOf('setPendingItemId(null)'),
    );
    expect(payload).not.toContain('initialAmount');
    expect(payload).not.toContain('faceValue');
    expect(GIFT_BLOCK).not.toMatch(/setFaceValue|setInitialAmount/);
  });

  it('повторный выпуск по позиции скрыт в UI (сервер защищён частичным UNIQUE)', () => {
    expect(GIFT_BLOCK).toContain('issuedItemIds');
    expect(GIFT_BLOCK).toContain('сертификат уже выпущен');
  });
});
