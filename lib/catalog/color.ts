/**
 * Распознавание справочника «Цвет» среди характеристик (EAV, ADR-007).
 *
 * ПОЧЕМУ ЭВРИСТИКА, А НЕ ЖЁСТКИЙ КОД: attributes.code задаётся контентщиком
 * магазина и в реальных данных различается ('color', 'demo-color', 'tsvet'…);
 * флаг attributes.is_variant существует в схеме, но в UI не проставляется, так
 * что опираться только на него нельзя. Платформа мультитенантна — жёсткая
 * привязка к коду одного магазина запрещена, поэтому узнаём справочник по
 * нормализованному имени/коду, а перечень признаков держим в ОДНОМ месте:
 * тот же список параметризует SQL-запрос репозитория (без дублей строк в SQL).
 */

/** Имена справочника «Цвет» (нижний регистр, точное совпадение). */
export const COLOR_ATTRIBUTE_NAMES: string[] = ['цвет', 'color', 'colour'];

/** LIKE-шаблоны кода справочника «Цвет» (нижний регистр). */
export const COLOR_ATTRIBUTE_CODE_PATTERNS: string[] = [
  '%color%',
  '%colour%',
  '%цвет%',
  '%tsvet%',
  '%cvet%',
];

/** Ядро шаблона без '%' — для совпадения подстрокой в JS-версии предиката. */
const CODE_NEEDLES = COLOR_ATTRIBUTE_CODE_PATTERNS.map((p) =>
  p.replaceAll('%', ''),
);

/**
 * Предикат «эта характеристика — цвет» (чистая функция, зеркало SQL-условия
 * репозитория). Регистронезависим, работает и по имени, и по коду.
 */
export function isColorAttribute(attr: {
  code?: string | null;
  name?: string | null;
}): boolean {
  const name = (attr.name ?? '').trim().toLowerCase();
  if ((COLOR_ATTRIBUTE_NAMES as readonly string[]).includes(name)) {
    return true;
  }
  const code = (attr.code ?? '').trim().toLowerCase();
  return code !== '' && CODE_NEEDLES.some((needle) => code.includes(needle));
}

/**
 * Нормализует HEX-код цвета к виду '#RRGGBB' или null.
 * Зеркало CHECK-ограничения attribute_values_color_hex_chk (миграция 0043; на проде накатана как 0036):
 * значение вне формата наружу не отдаём (витрина не должна получать мусор в
 * inline-стиле свотча).
 */
export function normalizeColorHex(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const v = value.trim();
  return /^#[0-9A-Fa-f]{6}$/.test(v) ? v : null;
}
