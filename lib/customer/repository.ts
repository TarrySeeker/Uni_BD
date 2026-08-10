/**
 * Доступ к данным личного кабинета.
 *
 * Слой намеренно «тонкий»: решения принимает сервис, здесь только запросы. Но
 * два инварианта живут именно тут, потому что обеспечиваются условиями SQL, а не
 * прикладной логикой:
 *   • заказы по совпадению адреса почты видны ТОЛЬКО при подтверждённом адресе;
 *   • «один основной адрес» держится уникальным индексом, а гонка снимается
 *     блокировкой по покупателю.
 */

import { sql } from '@/lib/db/client';

import type {
  CustomerAddress,
  CustomerAuthRow,
  CustomerOrderSummary,
  CustomerStatus,
  CustomerTokenPurpose,
} from './types';
import type { AddressInput } from './schemas';

// -----------------------------------------------------------------------------
// Учётная запись
// -----------------------------------------------------------------------------

interface AuthDbRow {
  id: string;
  email: string;
  name: string;
  phone: string | null;
  password_hash: string | null;
  status: CustomerStatus;
  email_verified_at: Date | null;
}

function mapAuth(r: AuthDbRow): CustomerAuthRow {
  return {
    id: r.id,
    email: r.email,
    name: r.name,
    phone: r.phone ?? null,
    passwordHash: r.password_hash ?? null,
    status: r.status,
    emailVerified: r.email_verified_at !== null,
  };
}

const authCols = () =>
  sql`id, email, name, phone, password_hash, status, email_verified_at`;

export async function findAuthByEmail(email: string): Promise<CustomerAuthRow | null> {
  const rows = await sql<AuthDbRow[]>`
    SELECT ${authCols()} FROM customers WHERE email = ${email} LIMIT 1
  `;
  return rows[0] ? mapAuth(rows[0]) : null;
}

export async function getAuthById(id: string): Promise<CustomerAuthRow | null> {
  const rows = await sql<AuthDbRow[]>`
    SELECT ${authCols()} FROM customers WHERE id = ${id} LIMIT 1
  `;
  return rows[0] ? mapAuth(rows[0]) : null;
}

/**
 * Регистрация — это ВСТАВКА-ИЛИ-ОБНОВЛЕНИЕ, а не создание новой записи.
 *
 * Строка покупателя обычно уже существует: она заводится при гостевом заказе,
 * чтобы агрегировать заказы по адресу почты. Создав рядом вторую, мы оторвали бы
 * историю заказов от аккаунта — покупатель зарегистрировался бы и увидел пустой
 * кабинет.
 *
 * Условие `password_hash IS NULL` в обновлении — это и есть проверка «адрес
 * свободен»: строку с уже заданным паролем оно не тронет, база вернёт пусто, и
 * вызывающий получит `null`. Проверять занятость отдельным запросом было бы
 * гонкой: между проверкой и вставкой адрес может занять другой запрос.
 *
 * Имя и телефон заполняются только если они пустые: данные, введённые при
 * гостевом заказе, могут быть точнее пустой формы регистрации.
 */
export async function upsertRegister(input: {
  email: string;
  name: string;
  phone: string;
  passwordHash: string;
}): Promise<{ id: string } | null> {
  const phone = input.phone === '' ? null : input.phone;
  const rows = await sql<{ id: string }[]>`
    INSERT INTO customers (email, name, phone, password_hash, status)
    VALUES (${input.email}, ${input.name}, ${phone}, ${input.passwordHash}, ${'active'})
    ON CONFLICT (email) DO UPDATE
      SET password_hash = EXCLUDED.password_hash,
          status        = ${'active'},
          name  = CASE WHEN customers.name = '' THEN EXCLUDED.name ELSE customers.name END,
          phone = COALESCE(NULLIF(customers.phone, ''), EXCLUDED.phone),
          updated_at = now()
      WHERE customers.password_hash IS NULL
    RETURNING id
  `;
  return rows[0] ?? null;
}

export async function setLastLogin(id: string): Promise<void> {
  await sql`UPDATE customers SET last_login_at = now() WHERE id = ${id}`;
}

export async function updatePasswordHash(id: string, hash: string): Promise<void> {
  await sql`
    UPDATE customers SET password_hash = ${hash}, updated_at = now() WHERE id = ${id}
  `;
}

export async function updateProfile(
  id: string,
  input: { name: string; phone: string },
): Promise<void> {
  await sql`
    UPDATE customers
       SET name = ${input.name},
           phone = ${input.phone === '' ? null : input.phone},
           updated_at = now()
     WHERE id = ${id}
  `;
}

/** Отмечает адрес подтверждённым. Момент важен: с него открывается доступ к заказам. */
export async function setEmailVerified(customerId: string): Promise<void> {
  await sql`
    UPDATE customers SET email_verified_at = now(), updated_at = now() WHERE id = ${customerId}
  `;
}

// -----------------------------------------------------------------------------
// Адресная книга
// -----------------------------------------------------------------------------

interface AddressDbRow {
  id: string;
  label: string;
  recipient_name: string;
  phone: string;
  city: string;
  delivery_city_code: string | null;
  address_line: string;
  postal_code: string;
  pickup_point_code: string | null;
  is_default: boolean;
}

function mapAddress(r: AddressDbRow): CustomerAddress {
  return {
    id: r.id,
    label: r.label,
    recipientName: r.recipient_name,
    phone: r.phone,
    city: r.city,
    deliveryCityCode: r.delivery_city_code ?? null,
    addressLine: r.address_line,
    postalCode: r.postal_code,
    pickupPointCode: r.pickup_point_code ?? null,
    isDefault: r.is_default,
  };
}

/**
 * Список колонок адреса — ФУНКЦИЯ, а не константа.
 *
 * Тег `sql`, вызванный на верхнем уровне модуля, выполняется при импорте и
 * требует строку подключения к базе. На сборке её нет — и сборка падала. Коварно
 * то, что проверка типов и юнит-тесты при этом молчат: ошибка вылезает только
 * при сборке. Вычисляем внутри запроса.
 */
const addressCols = () =>
  sql`id, label, recipient_name, phone, city, delivery_city_code, address_line, postal_code, pickup_point_code, is_default`;

export async function listAddresses(customerId: string): Promise<CustomerAddress[]> {
  const rows = await sql<AddressDbRow[]>`
    SELECT ${addressCols()} FROM customer_addresses
     WHERE customer_id = ${customerId}
     ORDER BY is_default DESC, created_at DESC
  `;
  return rows.map(mapAddress);
}

export async function createAddress(
  customerId: string,
  input: AddressInput,
): Promise<CustomerAddress> {
  return sql.begin(async (tx) => {
    if (input.isDefault) {
      // Блокировка по покупателю на время транзакции. Без неё два одновременных
      // «сделать основным» столкнутся на уникальном индексе и дадут ошибку
      // вместо результата — проверить-и-записать здесь недостаточно.
      await tx`SELECT pg_advisory_xact_lock(hashtext(${customerId}))`;
      await tx`
        UPDATE customer_addresses SET is_default = false
         WHERE customer_id = ${customerId} AND is_default
      `;
    }
    const rows = await tx<AddressDbRow[]>`
      INSERT INTO customer_addresses
        (customer_id, label, recipient_name, phone, city, delivery_city_code,
         address_line, postal_code, pickup_point_code, is_default)
      VALUES
        (${customerId}, ${input.label}, ${input.recipientName}, ${input.phone}, ${input.city},
         ${input.deliveryCityCode ?? null}, ${input.addressLine}, ${input.postalCode},
         ${input.pickupPointCode ?? null}, ${input.isDefault})
      RETURNING ${addressCols()}
    `;
    return mapAddress(rows[0]!);
  });
}

/**
 * Правка адреса. Обновление ЧАСТИЧНОЕ по кодам доставки.
 *
 * Форма редактирования адреса эти коды не присылает — они проставляются при
 * выборе города и пункта выдачи. Записав присланное «как есть», любая правка
 * города обнуляла бы их и ломала уже выбранную цель доставки.
 *
 * Ограничение подхода: очистить код через этот метод нельзя — отсутствие и
 * явный `null` здесь неразличимы. Для смены пункта выдачи присылается новое
 * значение, и этого достаточно.
 */
export async function updateAddress(
  id: string,
  customerId: string,
  input: AddressInput,
): Promise<CustomerAddress | null> {
  return sql.begin(async (tx) => {
    if (input.isDefault) {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${customerId}))`;
      await tx`
        UPDATE customer_addresses SET is_default = false
         WHERE customer_id = ${customerId} AND is_default AND id <> ${id}
      `;
    }
    const rows = await tx<AddressDbRow[]>`
      UPDATE customer_addresses SET
        label = ${input.label},
        recipient_name = ${input.recipientName},
        phone = ${input.phone},
        city = ${input.city},
        delivery_city_code = COALESCE(${input.deliveryCityCode ?? null}, delivery_city_code),
        address_line = ${input.addressLine},
        postal_code = ${input.postalCode},
        pickup_point_code = COALESCE(${input.pickupPointCode ?? null}, pickup_point_code),
        is_default = ${input.isDefault},
        updated_at = now()
      -- customer_id в условии: чужой адрес правке не поддаётся, даже если знать id.
      WHERE id = ${id} AND customer_id = ${customerId}
      RETURNING ${addressCols()}
    `;
    return rows[0] ? mapAddress(rows[0]) : null;
  });
}

export async function deleteAddress(id: string, customerId: string): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    DELETE FROM customer_addresses
     WHERE id = ${id} AND customer_id = ${customerId}
    RETURNING id
  `;
  return rows.length > 0;
}

// -----------------------------------------------------------------------------
// Избранное
// -----------------------------------------------------------------------------

export async function listWishlistProductIds(customerId: string): Promise<string[]> {
  const rows = await sql<{ product_id: string }[]>`
    SELECT product_id FROM customer_wishlist
     WHERE customer_id = ${customerId}
     ORDER BY created_at DESC
  `;
  return rows.map((r) => r.product_id);
}

/**
 * Добавляет товар в избранное.
 *
 * Ничего не делает, если товара нет (проверка существования внутри запроса —
 * без лишнего обращения) или он уже в списке. Повторное добавление — обычное
 * действие покупателя, а не ошибка, поэтому оно молча идемпотентно.
 */
export async function addWishlist(customerId: string, productId: string): Promise<void> {
  await sql`
    INSERT INTO customer_wishlist (customer_id, product_id)
    SELECT ${customerId}, ${productId}
     WHERE EXISTS (SELECT 1 FROM products WHERE id = ${productId})
    ON CONFLICT DO NOTHING
  `;
}

export async function removeWishlist(customerId: string, productId: string): Promise<void> {
  await sql`
    DELETE FROM customer_wishlist
     WHERE customer_id = ${customerId} AND product_id = ${productId}
  `;
}

/** Находит товар по публичному адресу: наружу идентификаторы не отдаются. */
export async function findProductIdBySlug(slug: string): Promise<string | null> {
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM products WHERE slug = ${slug} LIMIT 1
  `;
  return rows[0]?.id ?? null;
}

// -----------------------------------------------------------------------------
// Заказы покупателя (только чтение)
// -----------------------------------------------------------------------------

interface OrderSummaryDbRow {
  number: string;
  status: string;
  payment_status: string;
  delivery_status: string;
  grand_total: string;
  currency: string;
  created_at: Date | string;
  items_count: number;
}

/**
 * Заказы покупателя.
 *
 * 🔴 ГЛАВНЫЙ ИНВАРИАНТ КАБИНЕТА. Заказы по совпадению адреса почты показываются
 * ТОЛЬКО при подтверждённом адресе. Иначе достаточно зарегистрироваться на чужой
 * email, чтобы получить чужие заказы — с адресами доставки, телефонами и составом
 * покупок. Регистрация владения адресом не доказывает; доказывает переход по
 * ссылке из письма.
 *
 * Свои заказы (привязанные по идентификатору при оформлении из кабинета) видны
 * всегда — там подтверждение ни при чём.
 */
export async function listCustomerOrders(
  customerId: string,
  email: string,
  emailVerified: boolean,
): Promise<CustomerOrderSummary[]> {
  const rows = await sql<OrderSummaryDbRow[]>`
    SELECT o.number, o.status, o.payment_status, o.delivery_status,
           o.grand_total::text AS grand_total, o.currency, o.created_at,
           (SELECT count(*)::int FROM order_items oi WHERE oi.order_id = o.id) AS items_count
      FROM orders o
     WHERE o.customer_id = ${customerId}
        OR (${emailVerified} AND o.customer_email = ${email})
     ORDER BY o.created_at DESC
     LIMIT 100
  `;
  return rows.map((r) => ({
    number: r.number,
    status: r.status,
    paymentStatus: r.payment_status,
    deliveryStatus: r.delivery_status,
    grandTotal: r.grand_total,
    currency: r.currency,
    itemsCount: r.items_count,
    createdAt: (r.created_at instanceof Date ? r.created_at : new Date(r.created_at)).toISOString(),
  }));
}

/**
 * Владелец заказа — для проверки принадлежности при показе деталей.
 *
 * Отдельная проверка нужна потому, что детали запрашиваются по номеру напрямую:
 * условие из списка заказов на этот путь не распространяется, и без такой сверки
 * дыра осталась бы открытой ровно там, где её труднее заметить.
 */
export async function findOrderOwner(
  number: string,
): Promise<{ customerId: string | null; customerEmail: string } | null> {
  const rows = await sql<{ customer_id: string | null; customer_email: string }[]>`
    SELECT customer_id, customer_email FROM orders WHERE number = ${number} LIMIT 1
  `;
  const r = rows[0];
  if (!r) return null;
  return { customerId: r.customer_id ?? null, customerEmail: r.customer_email };
}

/**
 * Привязывает гостевые заказы к аккаунту.
 *
 * Вызывается ТОЛЬКО после подтверждения адреса — тогда владение доказано.
 *
 * Условие «ничей» обязательно: без него привязка могла бы перехватить заказы,
 * уже принадлежащие другому аккаунту с тем же адресом в поле контакта.
 */
export async function linkGuestOrdersByEmail(
  customerId: string,
  email: string,
): Promise<number> {
  const rows = await sql<{ id: string }[]>`
    UPDATE orders SET customer_id = ${customerId}, updated_at = now()
     WHERE customer_email = ${email} AND customer_id IS NULL
    RETURNING id
  `;
  return rows.length;
}

// -----------------------------------------------------------------------------
// Одноразовые токены (подтверждение адреса, сброс пароля)
// -----------------------------------------------------------------------------

/**
 * Выпускает токен, погасив прежние того же назначения.
 *
 * Гашение прежних — не уборка, а требование безопасности: если покупатель
 * запросил ссылку повторно (например, заподозрив утечку), старая ссылка обязана
 * перестать работать.
 */
export async function createAuthToken(input: {
  customerId: string;
  purpose: CustomerTokenPurpose;
  tokenHash: string;
  expiresAt: Date;
}): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`
      UPDATE customer_auth_tokens SET used_at = now()
       WHERE customer_id = ${input.customerId}
         AND purpose = ${input.purpose}
         AND used_at IS NULL
    `;
    await tx`
      INSERT INTO customer_auth_tokens (customer_id, purpose, token_hash, expires_at)
      VALUES (${input.customerId}, ${input.purpose}, ${input.tokenHash}, ${input.expiresAt})
    `;
  });
}

/**
 * Гасит токен и возвращает покупателя, если токен годен.
 *
 * Погашение и проверка — ОДИН запрос: условие `used_at IS NULL` внутри обновления
 * означает, что из двух одновременных запросов выиграет ровно один. Вариант
 * «прочитали → выполнили действие → пометили использованным» оставляет окно, в
 * которое проходит второй.
 */
export async function consumeAuthToken(
  tokenHash: string,
  purpose: CustomerTokenPurpose,
): Promise<{ customerId: string } | null> {
  const rows = await sql<{ customer_id: string }[]>`
    UPDATE customer_auth_tokens SET used_at = now()
     WHERE token_hash = ${tokenHash}
       AND purpose = ${purpose}
       AND used_at IS NULL
       AND expires_at > now()
    RETURNING customer_id
  `;
  return rows[0] ? { customerId: rows[0].customer_id } : null;
}

/** Удаляет просроченные и погашенные токены. Для фоновой задачи. */
export async function purgeStaleAuthTokens(): Promise<void> {
  await sql`
    DELETE FROM customer_auth_tokens
     WHERE expires_at <= now() OR used_at IS NOT NULL
  `;
}
