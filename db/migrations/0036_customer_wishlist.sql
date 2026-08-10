-- =============================================================================
-- 0036_customer_wishlist.sql — избранное покупателя
-- -----------------------------------------------------------------------------
-- Серверное избранное имеет смысл ровно тогда, когда список должен пережить
-- смену устройства. Если это не требуется, честнее держать избранное в браузере
-- и не заставлять покупателя регистрироваться ради «сердечка».
--
-- Составной первичный ключ (customer_id, product_id) вместо суррогатного id:
-- «товар в избранном» — это факт, а не сущность со своей жизнью. Повторное
-- добавление того же товара тогда не создаёт дубль, а отбивается ключом, и
-- операция становится идемпотентной без единой строки прикладного кода.
--
-- Оба внешних ключа CASCADE:
--   • удалили покупателя → его избранное уходит (152-ФЗ);
--   • удалили товар → он исчезает из чужих списков сам, без «мёртвых» строк.
-- Второе важно: на живом магазине удалённый товар оставался в избранном и
-- показывался покупателю как доступный к покупке.
--
-- Идемпотентно: CREATE TABLE / CREATE INDEX — IF NOT EXISTS.
-- =============================================================================

CREATE TABLE IF NOT EXISTS customer_wishlist (
  customer_id uuid        NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  product_id  uuid        NOT NULL REFERENCES products(id)  ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (customer_id, product_id)
);

-- Обратный обход: «кто добавил этот товар» — под аналитику спроса и под каскад.
CREATE INDEX IF NOT EXISTS customer_wishlist_product_idx ON customer_wishlist (product_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON customer_wishlist TO admik_app;

INSERT INTO schema_migrations (version, name)
VALUES ('0036', 'customer_wishlist')
ON CONFLICT DO NOTHING;
