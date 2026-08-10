import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { extractWebhookIp } from '@/lib/server/request-ip';

/**
 * СТРАЖ: определение клиентского IP живёт в ОДНОМ месте.
 *
 * Класс дефекта, который стережём: защиту чинят в одной функции, а трафик идёт
 * через её двойника. На этой кодовой базе он повторялся многократно — у каждого
 * роута вебхука была своя копия извлечения IP, и копии разошлись с общей
 * реализацией: доверяли подделываемому `X-Forwarded-For` первым и не проверяли
 * формат. Итог — IP-whitelist вебхука обходился заголовком, а в журнал попадал
 * чужой адрес. Точечный фикс общей функции этого НЕ лечил.
 *
 * Поэтому тест проверяет не поведение, а отсутствие условий для расхождения:
 * ни один роут не читает заголовки IP напрямую. Обычный юнит-тест такое не ловит —
 * копия проходит его ровно так же, как оригинал.
 */

const ROUTES_WITH_IP = [
  'app/api/cdek/webhook/route.ts',
  'app/api/payments/tbank/webhook/route.ts',
];

describe('request-ip — единственный источник правды', () => {
  it.each(ROUTES_WITH_IP)('%s не читает заголовки IP сам, а зовёт общую реализацию', (rel) => {
    const src = readFileSync(join(process.cwd(), rel), 'utf8');

    // Разрешаем упоминания в комментариях, но не фактическое чтение заголовка.
    const readsHeaderDirectly = /headers\.get\(\s*['"]x-(forwarded-for|real-ip)['"]\s*\)/.test(src);
    expect(
      readsHeaderDirectly,
      `${rel} читает заголовок IP напрямую — это заготовка для расхождения. ` +
        'Используйте extractWebhookIp из lib/server/request-ip.ts.',
    ).toBe(false);

    expect(src).toContain('extractWebhookIp');
  });

  it('extractWebhookIp предпочитает X-Real-IP подделываемому X-Forwarded-For', () => {
    const headers = new Headers({
      'x-forwarded-for': '203.0.113.7',
      'x-real-ip': '192.0.2.55',
    });
    expect(extractWebhookIp(headers, true)).toBe('192.0.2.55');
  });

  it('без доверенного прокси заголовки не читаются вовсе → пустая строка', () => {
    // Контракт whitelist-слоя: вне доверенного прокси заголовки ничего не
    // аутентифицируют, и непустой whitelist обязан отклонить запрос.
    const headers = new Headers({ 'x-real-ip': '192.0.2.55' });
    expect(extractWebhookIp(headers, false)).toBe('');
  });

  it('мусор в заголовках → пустая строка, а не мусор в whitelist и журнале', () => {
    const headers = new Headers({ 'x-real-ip': 'not-an-ip', 'x-forwarded-for': 'garbage' });
    expect(extractWebhookIp(headers, true)).toBe('');
  });
});
