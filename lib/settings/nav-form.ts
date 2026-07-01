/**
 * C6 — чистый парсер текстовых полей формы навигации.
 *
 * Превращает два текстовых поля (шапка / футер) в структуру навигации, которую
 * принимает navigationSchema (lib/settings/schemas.ts) и потребляет витрина
 * (eff.navigation → Header/Footer). Никакой бизнес-логики/БД — только маппинг
 * текст → JSON, чтобы покрыть юнит-тестом без React (vitest environment=node).
 *
 * Валидацию href НЕ делаем здесь намеренно — это задача Zod на бэкенде
 * (navigationSchema через updateNavigationContentAction): форма отправляет то,
 * что ввёл владелец, и показывает ошибку валидации, если href битый.
 *
 * Мультитенантность: формат универсален, никакого хардкода под конкретный
 * магазин — пустые поля дают {header:[],footer:[]} (витрина показывает
 * навигацию по умолчанию своего инстанса).
 */

export interface NavLinkInput {
  label: string;
  href: string;
}

export interface NavFooterColumnInput {
  title: string;
  links: NavLinkInput[];
}

export interface NavigationFormState {
  header: NavLinkInput[];
  footer: NavFooterColumnInput[];
}

/** Строка «Метка | href» → пара (обе части обязательны), иначе null. */
function parsePairLine(line: string): NavLinkInput | null {
  const idx = line.indexOf('|');
  if (idx < 0) return null;
  const label = line.slice(0, idx).trim();
  const href = line.slice(idx + 1).trim();
  return label && href ? { label, href } : null;
}

/**
 * Парсит поля формы навигации.
 *
 * @param headerText  Пункты шапки — по одному на строку в формате «Метка | href».
 * @param footerText  Колонки футера — блоки, разделённые пустой строкой; в блоке
 *                    первая строка = заголовок колонки, далее «Метка | href».
 */
export function parseNavigationFormState(
  headerText: string,
  footerText: string,
): NavigationFormState {
  const header = headerText
    .split('\n')
    .map(parsePairLine)
    .filter((x): x is NavLinkInput => x !== null);

  // Колонки разделяются пустой строкой (строка из одних пробелов считается пустой).
  const footer = footerText
    .split(/\n[ \t]*\n/)
    .map((block) => {
      const lines = block
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      if (lines.length === 0) return null;
      const title = lines[0];
      const links = lines
        .slice(1)
        .map(parsePairLine)
        .filter((x): x is NavLinkInput => x !== null);
      return { title, links };
    })
    .filter((x): x is NavFooterColumnInput => x !== null);

  return { header, footer };
}
