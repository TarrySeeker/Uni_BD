/**
 * Чистые форматтеры раздела «Доставка (СДЭК)» админки.
 *
 * Вынесены из app/admin/(panel)/cdek/page.tsx, чтобы покрыть юнит-тестами
 * (node-харнесс admik без jsdom): логика отображения способа доставки и
 * человекочитаемого «Назначения» отправления не зависит от React/БД.
 *
 * Мультитенантность: значения берутся из строки БД конкретного инстанса —
 * никаких хардкодов под отдельный магазин.
 */

/** Поля строки отправления, необходимые для форматирования назначения. */
export interface DestinationInput {
  delivery_mode: string | null;
  pvz_code?: string | null;
  delivery_city?: string | null;
  delivery_pvz_code?: string | null;
}

/** Человекочитаемый способ доставки. */
export function deliveryModeLabel(mode: string | null): string {
  switch (mode) {
    case 'pvz':
      return 'ПВЗ';
    case 'postamat':
      return 'Постамат';
    case 'door':
      return 'Курьер';
    default:
      return '—';
  }
}

/**
 * Человекочитаемое «Назначение» отправления для списка /admin/cdek.
 *
 * • pvz/postamat → «<город>, ПВЗ <код>» (город опционален); код берётся из
 *   cdek_shipments.pvz_code, при отсутствии — из orders.delivery_pvz_code;
 * • door → город доставки курьером (orders.delivery_city);
 * • иначе/пусто → «—».
 *
 * Числовой city_code СДЭК намеренно НЕ используется — он нечитаем; читаемый
 * город заполняется на чекауте в orders.delivery_city.
 */
export function destinationLabel(row: DestinationInput): string {
  const city = row.delivery_city?.trim() || null;

  if (row.delivery_mode === 'pvz' || row.delivery_mode === 'postamat') {
    const code = row.pvz_code ?? row.delivery_pvz_code;
    const pvzPart = code ? `ПВЗ ${code}` : null;
    const parts = [city, pvzPart].filter(Boolean);
    return parts.length ? parts.join(', ') : '—';
  }

  if (row.delivery_mode === 'door') {
    return city ?? '—';
  }

  return '—';
}
