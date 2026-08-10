import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Репозиторий кабинета. Проверяем инварианты, а не текст SQL: база подменена,
 * важно КАКИЕ условия попадают в запрос и КАКИЕ значения уходят.
 *
 * Здесь живут два самых опасных места кабинета:
 *   • доступ к заказам по совпадению адреса почты — открывать его до
 *     подтверждения адреса нельзя ни при каких условиях;
 *   • «один основной адрес» — без блокировки два одновременных запроса дают
 *     ошибку уникальности вместо результата.
 */

const queries = vi.hoisted(() => [] as { text: string; values: unknown[] }[]);
const nextRows = vi.hoisted(() => ({ value: [] as unknown[] }));

vi.mock('@/lib/db/client', () => {
  // Тег-заглушка: пишет запрос в журнал и отдаёт заготовленные строки.
  // Определён ВНУТРИ фабрики: вызов vi.mock поднимается наверх файла, и внешняя
  // переменная на этот момент ещё не инициализирована.
  const sql = Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => {
      queries.push({ text: strings.join('?'), values });
      return Promise.resolve(nextRows.value);
    },
    {
      // Транзакция выполняет колбэк на том же теге — этого хватает, чтобы
      // увидеть порядок запросов внутри неё.
      begin: (fn: (tx: unknown) => Promise<unknown>) => fn(sql),
    },
  );
  return { sql };
});

import {
  upsertRegister,
  listCustomerOrders,
  linkGuestOrdersByEmail,
  createAddress,
  updateAddress,
  addWishlist,
} from '@/lib/customer/repository';

beforeEach(() => {
  queries.length = 0;
  nextRows.value = [];
});

/** Собирает весь текст выполненных запросов — удобно искать условия. */
const allSql = () => queries.map((q) => q.text).join('\n');

describe('customer/repository — регистрация как upsert', () => {
  it('не создаёт вторую строку покупателя, а дописывает пароль существующей', async () => {
    // Строка обычно уже есть после гостевого заказа. Создав вторую, мы оторвали
    // бы историю заказов от аккаунта.
    nextRows.value = [{ id: 'cust-1' }];
    await upsertRegister({
      email: 'buyer@example.com',
      name: 'Имя',
      phone: '',
      passwordHash: 'phc-hash',
    });

    const text = allSql();
    expect(text).toContain('ON CONFLICT');
    expect(text).toContain('password_hash IS NULL');
  });

  it('занятый адрес не перезаписывает чужой пароль, а возвращает null', async () => {
    // Условие `password_hash IS NULL` в upsert не даёт обновить строку с уже
    // заданным паролем — база вернёт пусто, и это ответ «адрес занят».
    nextRows.value = [];
    const res = await upsertRegister({
      email: 'taken@example.com',
      name: '',
      phone: '',
      passwordHash: 'phc',
    });
    expect(res).toBeNull();
  });

  it('пустой телефон сохраняется как NULL, а не пустой строкой', async () => {
    nextRows.value = [{ id: 'c' }];
    await upsertRegister({ email: 'a@b.co', name: '', phone: '', passwordHash: 'h' });
    expect(queries[0]!.values).toContain(null);
  });
});

describe('customer/repository — доступ к заказам', () => {
  it('НЕподтверждённый адрес: заказы по совпадению почты не показываются', async () => {
    // Самая опасная ошибка кабинета: иначе регистрация на чужой адрес отдала бы
    // чужие заказы вместе с адресами доставки и телефонами.
    await listCustomerOrders('cust-1', 'buyer@example.com', false);
    const q = queries[0]!;
    expect(q.text).toContain('customer_id');
    // Признак подтверждения уходит в запрос как значение — при false ветка
    // сравнения по почте не даёт ни одной строки.
    expect(q.values).toContain(false);
  });

  it('подтверждённый адрес: заказы по совпадению почты доступны', async () => {
    await listCustomerOrders('cust-1', 'buyer@example.com', true);
    expect(queries[0]!.values).toContain(true);
  });

  it('свои заказы видны всегда — они привязаны по идентификатору, а не по почте', async () => {
    await listCustomerOrders('cust-1', 'buyer@example.com', false);
    expect(queries[0]!.values).toContain('cust-1');
  });
});

describe('customer/repository — привязка гостевых заказов', () => {
  it('забирает только НИЧЕЙНЫЕ заказы с этим адресом', async () => {
    // Условие `customer_id IS NULL` обязательно: без него привязка могла бы
    // перехватить заказы, уже принадлежащие другому аккаунту.
    nextRows.value = [{ id: 'o1' }, { id: 'o2' }];
    const n = await linkGuestOrdersByEmail('cust-1', 'buyer@example.com');

    expect(n).toBe(2);
    expect(queries[0]!.text).toContain('customer_id IS NULL');
  });
});

describe('customer/repository — адреса', () => {
  it('установка основного адреса берёт блокировку по покупателю', async () => {
    // Без неё два одновременных «сделать основным» столкнутся на уникальном
    // индексе и дадут ошибку вместо результата.
    nextRows.value = [{ id: 'a1', is_default: true }];
    await createAddress('cust-1', {
      label: '', recipientName: '', phone: '', city: '',
      addressLine: '', postalCode: '', isDefault: true,
    });
    expect(allSql()).toContain('pg_advisory_xact_lock');
  });

  it('обычный адрес не берёт блокировку — она нужна только при смене основного', async () => {
    nextRows.value = [{ id: 'a1', is_default: false }];
    await createAddress('cust-1', {
      label: '', recipientName: '', phone: '', city: '',
      addressLine: '', postalCode: '', isDefault: false,
    });
    expect(allSql()).not.toContain('pg_advisory_xact_lock');
  });

  it('правка адреса без кодов доставки НЕ затирает их', async () => {
    // Форма редактирования города эти поля не присылает. Без сохранения
    // прежнего значения любая правка ломала бы выбранный пункт выдачи.
    nextRows.value = [{ id: 'a1' }];
    await updateAddress('a1', 'cust-1', {
      label: '', recipientName: '', phone: '', city: 'Новый город',
      addressLine: '', postalCode: '', isDefault: false,
    });
    expect(allSql()).toContain('COALESCE');
  });

  it('правка чужого адреса ничего не меняет: условие включает покупателя', async () => {
    nextRows.value = [];
    const res = await updateAddress('чужой-адрес', 'cust-1', {
      label: '', recipientName: '', phone: '', city: '',
      addressLine: '', postalCode: '', isDefault: false,
    });
    expect(res).toBeNull();
    expect(allSql()).toContain('customer_id');
  });
});

describe('customer/repository — избранное', () => {
  it('повторное добавление того же товара не создаёт дубль', async () => {
    await addWishlist('cust-1', 'prod-1');
    expect(allSql()).toContain('ON CONFLICT');
  });
});
