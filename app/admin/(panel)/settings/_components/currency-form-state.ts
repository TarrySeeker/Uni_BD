/**
 * Чистая логика строк доп.валют формы «Валюта и единицы» — вынесена из
 * CurrencyUnitsForm.tsx, чтобы тестироваться без DOM/Next (vitest env=node, как
 * остальной слой настроек).
 *
 * ЗАЧЕМ. Строки живут в useState клиентской формы, засеянном пропсами серверной
 * страницы. router.refresh() после кнопки «Обновить курсы с ЦБ сейчас» перерисовывает
 * серверную страницу, но состояние клиентского компонента React СОХРАНЯЕТ — форма
 * продолжала показывать старые курсы (кнопка выглядела сломанной), а следующее
 * «Сохранить» отправляло эти старые курсы обратно в БД, откатывая только что
 * полученные свежие. Отсюда пересев: подпись серверного снимка (ratesSignature)
 * показывает, что БД отдала другие курсы, applyServerRates аккуратно накладывает их
 * на текущее состояние формы.
 *
 * ГРАНИЦА ПЕРЕСЕВА. Копируются ТОЛЬКО rate и метка обновления и ТОЛЬКО у валют на
 * автокурсе — то есть ровно то, что меняет прогон ЦБ. Всё остальное — правки
 * владельца, возможно ещё не сохранённые (символ, знаки, галочка «ручной курс»,
 * добавленные и удалённые строки), — переживает пересев нетронутым.
 */

/** Строка редактора доп.валюты отображения (значения — строки, это поля ввода). */
export interface DisplayCurrencyRow {
  code: string;
  symbol: string;
  rate: string;
  fractionDigits: string;
  /** Курс задан вручную: ночное обновление с ЦБ эту валюту не трогает. */
  manualRate: boolean;
  /** Метка последнего обновления курса этой валюты (только показ). */
  rateUpdatedAt: string | null;
}

/** Доп.валюта в эффективных настройках магазина (снимок сервера). */
export interface ServerDisplayCurrency {
  code: string;
  symbol: string;
  rate: number;
  fractionDigits: number;
  manualRate: boolean;
  rateUpdatedAt: string | null;
}

/** ISO-код в канонической форме — владелец печатает код руками, в любом регистре. */
function normalizeCode(code: string): string {
  return code.trim().toUpperCase();
}

/** Начальные строки формы из настроек магазина. */
export function rowsFromServer(
  list: readonly ServerDisplayCurrency[],
): DisplayCurrencyRow[] {
  return list.map((d) => ({
    code: d.code,
    symbol: d.symbol,
    rate: String(d.rate),
    fractionDigits: String(d.fractionDigits),
    manualRate: d.manualRate,
    rateUpdatedAt: d.rateUpdatedAt,
  }));
}

/**
 * Подпись серверного снимка курсов: сменилась ⇒ БД отдала другие курсы.
 *
 * Включает ровно те поля, которые пересев копирует (код, курс, метка). Правка
 * символа или знаков на сервере подпись не меняет — дёргать пересев курсов из-за
 * них незачем.
 */
export function ratesSignature(list: readonly ServerDisplayCurrency[]): string {
  return JSON.stringify(list.map((c) => [normalizeCode(c.code), c.rate, c.rateUpdatedAt]));
}

/**
 * Накладывает свежие курсы из настроек на текущие строки формы.
 *
 * Авторитет формы: состав строк и все поля, кроме курса автоматических валют.
 * Валюта с галочкой «курс задан вручную» не трогается (прогон ЦБ её и не обновлял),
 * добавленная владельцем строка не портится, удалённая — не воскресает.
 * Идемпотентно, исходный массив не мутируется.
 */
export function applyServerRates(
  rows: readonly DisplayCurrencyRow[],
  server: readonly ServerDisplayCurrency[],
): DisplayCurrencyRow[] {
  const byCode = new Map(server.map((c) => [normalizeCode(c.code), c]));
  return rows.map((r) => {
    if (r.manualRate) return r;
    const fresh = byCode.get(normalizeCode(r.code));
    if (!fresh) return r;
    const rate = String(fresh.rate);
    if (r.rate === rate && r.rateUpdatedAt === fresh.rateUpdatedAt) return r;
    return { ...r, rate, rateUpdatedAt: fresh.rateUpdatedAt };
  });
}
