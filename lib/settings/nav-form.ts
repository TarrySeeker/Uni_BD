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

/**
 * НЕ-ссылочное содержимое подвала (заголовок рассылки, приписка о согласии,
 * копирайт, кредит студии). Собирается из отдельных однострочных полей формы.
 * Пустые поля НЕ попадают в результат: `footerMetaSchema` требует непустые
 * строки, а «пусто» означает «владелец не задал» → витрина берёт свой дефолт.
 */
export interface NavFooterMetaInput {
  subscribeTitle?: string;
  subscribeNote?: string;
  copyright?: string;
  designedByLabel?: string;
  designedByHref?: string;
}

export interface NavigationFormState {
  header: NavLinkInput[];
  footer: NavFooterColumnInput[];
  /** Отсутствует, если владелец не заполнил ни одного поля подвала. */
  footerMeta?: NavFooterMetaInput;
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
 * Собирает footerMeta из однострочных полей формы. Пустые/пробельные значения
 * отбрасываются; ни одного заполненного → undefined (ключ в настройки не пойдёт,
 * витрина остаётся на словарных дефолтах — мультитенантный «не задано»).
 */
export function parseFooterMetaFormState(
  raw: NavFooterMetaInput,
): NavFooterMetaInput | undefined {
  const out: NavFooterMetaInput = {};
  const keys = [
    'subscribeTitle',
    'subscribeNote',
    'copyright',
    'designedByLabel',
    'designedByHref',
  ] as const;
  for (const key of keys) {
    const value = (raw[key] ?? '').trim();
    if (value) out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Парсит поля формы навигации.
 *
 * @param headerText  Пункты шапки — по одному на строку в формате «Метка | href».
 * @param footerText  Колонки футера — блоки, разделённые пустой строкой; в блоке
 *                    первая строка = заголовок колонки, далее «Метка | href».
 * @param footerMeta  Тексты подвала (заголовок рассылки/приписка/копирайт/кредит).
 *                    Аддитивный необязательный аргумент: прежние вызовы с двумя
 *                    аргументами дают ровно прежний результат (без ключа footerMeta).
 */
export function parseNavigationFormState(
  headerText: string,
  footerText: string,
  footerMeta?: NavFooterMetaInput,
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

  const meta = footerMeta ? parseFooterMetaFormState(footerMeta) : undefined;

  return meta ? { header, footer, footerMeta: meta } : { header, footer };
}
