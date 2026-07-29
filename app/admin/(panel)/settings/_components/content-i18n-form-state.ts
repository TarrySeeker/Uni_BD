/**
 * Волна 5, трек C — ЧИСТАЯ логика редактора переводов настроек (ключ content_i18n).
 *
 * Формы настроек ('use client') — тонкие обёртки над этими функциями: суть
 * (сборка патча, разбор существующего оверлея, список вызовов действия) живёт
 * здесь, чтобы покрыть юнит-тестом без React (vitest env 'node'). Модуль ЧИСТЫЙ —
 * ни БД, ни Next, ни серверных импортов (клиентский корень *-form-state.ts).
 *
 * Модель перевода (принята волной 5): базовые (русские) поля правятся прежним
 * путём через базовый action формы. Перевод — отдельный слой поверх: карта
 * состояния locale → { pathKey → строка }, где pathKey — точечный путь до
 * переводимого листа (плоский `shopName`, вложенный `hero.title`, элемент
 * массива `about.paragraphs.0`, глубокий `footer.1.links.2.label`). Сборка в
 * патч mirror'ит структуру базового ключа; read-path (localizeStructured/
 * localizeField) точечно накладывает его ТОЛЬКО на переводимые поля.
 */

import type { TranslatableFieldDef } from '../../_components/LocaleTabs';
import type { TranslationsMap } from '@/lib/i18n';

/** Состояние переводов одного языка: путь-до-листа → значение. */
export type TrLocaleState = Record<string, string>;
/** Состояние переводов формы: язык → состояние языка. */
export type TrState = Record<string, TrLocaleState>;

/** Секции настроек, доступные для перевода (совпадает с CONTENT_I18N_SECTIONS). */
export type ContentI18nSection =
  | 'home'
  | 'navigation'
  | 'branding'
  | 'seo'
  | 'contacts'
  | 'delivery';

// -----------------------------------------------------------------------------
// Плоские дескрипторы (branding/seo/contacts): whitelist = SETTINGS_TR_FIELDS.
// Порядок и набор ключей ОБЯЗАНЫ совпадать с SETTINGS_TR_FIELDS (guard-тест).
// -----------------------------------------------------------------------------

/**
 * Подписи полей живут в каталогах messages/* под `settings.trFields.*` и
 * НИКОГДА не хранятся строкой в коде: вкладку перевода владелец открывает в своей
 * локали (в т.ч. fr) и должен видеть подписи полей на своём языке. Ключи выписаны
 * целиком (а не собраны из префикса) — чтобы находиться обычным grep'ом.
 */

export const BRANDING_TR_FIELD_DEFS: readonly TranslatableFieldDef[] = [
  { key: 'shopName', labelKey: 'settings.trFields.shopName', kind: 'text' },
];

export const SEO_TR_FIELD_DEFS: readonly TranslatableFieldDef[] = [
  { key: 'site_name', labelKey: 'settings.trFields.siteName', kind: 'text' },
  { key: 'title_template', labelKey: 'settings.trFields.titleTemplate', kind: 'text' },
  { key: 'default_description', labelKey: 'settings.trFields.defaultDescription', kind: 'textarea' },
];

export const CONTACTS_TR_FIELD_DEFS: readonly TranslatableFieldDef[] = [
  { key: 'address', labelKey: 'settings.trFields.address', kind: 'text' },
  { key: 'workingHours', labelKey: 'settings.trFields.workingHours', kind: 'text' },
];

// -----------------------------------------------------------------------------
// Сборка патча: плоское состояние языка → вложенный патч (mirror базового ключа).
// -----------------------------------------------------------------------------

function isIndex(seg: string): boolean {
  return /^\d+$/.test(seg);
}

/**
 * Плоское состояние `{ pathKey: value }` → вложенный патч. Числовой сегмент пути
 * даёт массив (индексация по позиции — так же мержит read-path deepMerge/
 * localizeStructured). Пустые/пробельные значения ОТБРАСЫВАЮТСЯ: их место в
 * массиве остаётся дырой (JSON → null), которую deepMerge трактует как «взять
 * базу» — перевод не затирает базовый текст пустотой.
 */
export function assemblePatch(state: TrLocaleState): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  for (const [path, raw] of Object.entries(state)) {
    const value = raw.trim();
    if (!value) continue;
    const segs = path.split('.');
    // Узлы дерева — объекты/массивы с динамическими ключами; локальный any здесь
    // проще строгой рекурсии и не выходит за пределы функции.
    let node = root as Record<string, unknown>;
    for (let i = 0; i < segs.length - 1; i++) {
      const seg = segs[i];
      const nextIsIndex = isIndex(segs[i + 1]);
      if (node[seg] == null) node[seg] = nextIsIndex ? [] : {};
      node = node[seg] as Record<string, unknown>;
    }
    node[segs[segs.length - 1]] = value;
  }
  return root;
}

// -----------------------------------------------------------------------------
// Разбор существующего оверлея: вложенный патч → плоское состояние (пре-заполнение).
// -----------------------------------------------------------------------------

/**
 * Вложенный патч секции → плоское состояние `{ pathKey: value }` для инпутов
 * формы. В карту попадают ТОЛЬКО строковые листы: нестроковые значения (числа/
 * булевы/идентификаторы) переводом не являются и в инпуты не подставляются.
 * Битый/непонятный вход → пустая карта (не роняем форму).
 */
export function flattenOverlay(overlay: unknown): TrLocaleState {
  const out: TrLocaleState = {};
  const walk = (value: unknown, prefix: string): void => {
    if (typeof value === 'string') {
      if (prefix) out[prefix] = value;
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, i) => walk(item, prefix ? `${prefix}.${i}` : String(i)));
      return;
    }
    if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        walk(v, prefix ? `${prefix}.${k}` : k);
      }
    }
  };
  walk(overlay, '');
  return out;
}

/** Есть ли хоть одно непустое значение перевода. */
export function hasAnyTranslation(state: TrLocaleState | undefined): boolean {
  if (!state) return false;
  return Object.values(state).some((v) => v.trim().length > 0);
}

/**
 * Оверлей content_i18n целиком (карта locale → { section → patch }) → состояние
 * формы конкретной секции (locale → плоское состояние). Базовый язык в оверлее
 * не хранится, поэтому фильтровать его не нужно.
 */
export function initTrState(
  overlay: TranslationsMap | null | undefined,
  section: ContentI18nSection,
): TrState {
  const out: TrState = {};
  if (!overlay) return out;
  for (const [locale, bySection] of Object.entries(overlay)) {
    const sectionPatch = (bySection as Record<string, unknown> | null | undefined)?.[section];
    if (sectionPatch == null) continue;
    out[locale] = flattenOverlay(sectionPatch);
  }
  return out;
}

/**
 * Состояние переводов формы → список вызовов updateContentI18n (по одному на
 * язык). Каждый вызов несёт секцию целиком: read-path заменяет секцию патчем и
 * точечно накладывает переводимые листы. Пустое состояние языка даёт пустой патч
 * (сброс перевода этой секции на базовый язык).
 */
export function buildContentI18nSaves(
  section: ContentI18nSection,
  trState: TrState,
): { locale: string; section: ContentI18nSection; patch: Record<string, unknown> }[] {
  return Object.entries(trState).map(([locale, state]) => ({
    locale,
    section,
    patch: assemblePatch(state),
  }));
}

// -----------------------------------------------------------------------------
// Динамические дескрипторы структурных секций (home/navigation): разворот по
// фактической длине базовых массивов (read-path мержит перевод по индексу).
// -----------------------------------------------------------------------------

type AnyRec = Record<string, unknown>;

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/**
 * Переводимые листы блока «главной» → дескрипторы полей (key = точечный путь,
 * labelKey = ключ подписи в каталоге). Whitelist повторяет SETTINGS_TR_FIELDS.home;
 * href/imageKey/embedUrl/enabled НЕ включены (идентификаторы, не текст).
 *
 * Подписи повторяющихся элементов параметризованы номером (`labelParams.n`):
 * позиция в массиве — данные, а не текст, поэтому номер подставляет ICU, а не
 * конкатенация в коде. Номер человеческий (с 1), путь остаётся индексом (с 0).
 */
export function buildHomeTrFieldDefs(home: AnyRec): TranslatableFieldDef[] {
  const defs: TranslatableFieldDef[] = [];
  const h = (home ?? {}) as AnyRec;
  const block = (key: string): AnyRec => (h[key] as AnyRec) ?? {};

  // hero
  defs.push({ key: 'hero.title', labelKey: 'settings.trFields.heroTitle', kind: 'text' });
  defs.push({ key: 'hero.subtitle', labelKey: 'settings.trFields.heroSubtitle', kind: 'text' });
  defs.push({ key: 'hero.ctaLabel', labelKey: 'settings.trFields.heroCtaLabel', kind: 'text' });

  // about
  const about = block('about');
  defs.push({ key: 'about.title', labelKey: 'settings.trFields.aboutTitle', kind: 'text' });
  asArray(about.paragraphs).forEach((_, i) =>
    defs.push({
      key: `about.paragraphs.${i}`,
      labelKey: 'settings.trFields.aboutParagraph',
      labelParams: { n: i + 1 },
      kind: 'textarea',
    }),
  );
  asArray(about.values).forEach((_, i) =>
    defs.push({
      key: `about.values.${i}`,
      labelKey: 'settings.trFields.aboutValue',
      labelParams: { n: i + 1 },
      kind: 'text',
    }),
  );

  // quality
  const quality = block('quality');
  defs.push({ key: 'quality.title', labelKey: 'settings.trFields.qualityTitle', kind: 'text' });
  asArray(quality.items).forEach((_, i) =>
    defs.push({
      key: `quality.items.${i}`,
      labelKey: 'settings.trFields.qualityItem',
      labelParams: { n: i + 1 },
      kind: 'text',
    }),
  );

  // delivery
  asArray(block('delivery').items).forEach((_, i) => {
    defs.push({
      key: `delivery.items.${i}.title`,
      labelKey: 'settings.trFields.deliveryItemTitle',
      labelParams: { n: i + 1 },
      kind: 'text',
    });
    defs.push({
      key: `delivery.items.${i}.text`,
      labelKey: 'settings.trFields.deliveryItemText',
      labelParams: { n: i + 1 },
      kind: 'textarea',
    });
  });

  // valuesStrip
  asArray(block('valuesStrip').items).forEach((_, i) => {
    defs.push({
      key: `valuesStrip.items.${i}.title`,
      labelKey: 'settings.trFields.valuesStripItemTitle',
      labelParams: { n: i + 1 },
      kind: 'text',
    });
    defs.push({
      key: `valuesStrip.items.${i}.text`,
      labelKey: 'settings.trFields.valuesStripItemText',
      labelParams: { n: i + 1 },
      kind: 'text',
    });
  });

  // philosophy
  defs.push({ key: 'philosophy.eyebrow', labelKey: 'settings.trFields.philosophyEyebrow', kind: 'text' });
  defs.push({ key: 'philosophy.title', labelKey: 'settings.trFields.philosophyTitle', kind: 'text' });
  defs.push({ key: 'philosophy.text', labelKey: 'settings.trFields.philosophyText', kind: 'textarea' });
  defs.push({ key: 'philosophy.linkLabel', labelKey: 'settings.trFields.philosophyLinkLabel', kind: 'text' });

  // looks
  const looks = block('looks');
  defs.push({ key: 'looks.title', labelKey: 'settings.trFields.looksTitle', kind: 'text' });
  asArray(looks.categories).forEach((c, i) => {
    defs.push({
      key: `looks.categories.${i}.title`,
      labelKey: 'settings.trFields.looksCategoryTitle',
      labelParams: { n: i + 1 },
      kind: 'text',
    });
    // Текст категории — наследие v1 (статичная сетка). Показываем поле перевода
    // ТОЛЬКО если текст реально заведён: у вкладок v2 его нет, и пустая строка
    // перевода в панели сбивала бы владельца с толку.
    const legacyText = (c as AnyRec | null | undefined)?.text;
    if (typeof legacyText === 'string' && legacyText.trim().length > 0) {
      defs.push({
        key: `looks.categories.${i}.text`,
        labelKey: 'settings.trFields.looksCategoryText',
        labelParams: { n: i + 1 },
        kind: 'textarea',
      });
    }
  });
  // Имена авторов карточек — контент витрины, переводимый владельцем.
  asArray(looks.items).forEach((_, i) =>
    defs.push({
      key: `looks.items.${i}.authorName`,
      labelKey: 'settings.trFields.looksItemAuthorName',
      labelParams: { n: i + 1 },
      kind: 'text',
    }),
  );

  // tiles
  asArray(block('tiles').items).forEach((_, i) =>
    defs.push({
      key: `tiles.items.${i}.title`,
      labelKey: 'settings.trFields.tilesItemTitle',
      labelParams: { n: i + 1 },
      kind: 'text',
    }),
  );

  // designers
  const designers = block('designers');
  defs.push({ key: 'designers.title', labelKey: 'settings.trFields.designersTitle', kind: 'text' });
  asArray(designers.items).forEach((_, i) =>
    defs.push({
      key: `designers.items.${i}.name`,
      labelKey: 'settings.trFields.designersItemName',
      labelParams: { n: i + 1 },
      kind: 'text',
    }),
  );

  // slider
  asArray(block('slider').slides).forEach((_, i) => {
    defs.push({
      key: `slider.slides.${i}.name`,
      labelKey: 'settings.trFields.sliderSlideName',
      labelParams: { n: i + 1 },
      kind: 'text',
    });
    defs.push({
      key: `slider.slides.${i}.caption`,
      labelKey: 'settings.trFields.sliderSlideCaption',
      labelParams: { n: i + 1 },
      kind: 'text',
    });
  });

  // corpCert
  asArray(block('corpCert').tiles).forEach((_, i) =>
    defs.push({
      key: `corpCert.tiles.${i}.title`,
      labelKey: 'settings.trFields.corpCertTileTitle',
      labelParams: { n: i + 1 },
      kind: 'text',
    }),
  );

  return defs;
}

/**
 * Переводимые листы навигации → дескрипторы. Whitelist повторяет
 * SETTINGS_TR_FIELDS.navigation: метки пунктов шапки, заголовки колонок футера и
 * метки ссылок футера. href НЕ переводится.
 *
 * Подписи параметризованы номерами: колонка — `n`, ссылка внутри колонки — `j`.
 */
export function buildNavigationTrFieldDefs(navigation: AnyRec): TranslatableFieldDef[] {
  const defs: TranslatableFieldDef[] = [];
  const nav = (navigation ?? {}) as AnyRec;

  asArray(nav.header).forEach((_, i) =>
    defs.push({
      key: `header.${i}.label`,
      labelKey: 'settings.trFields.navHeaderItem',
      labelParams: { n: i + 1 },
      kind: 'text',
    }),
  );

  asArray(nav.footer).forEach((col, i) => {
    defs.push({
      key: `footer.${i}.title`,
      labelKey: 'settings.trFields.navFooterColumnTitle',
      labelParams: { n: i + 1 },
      kind: 'text',
    });
    asArray((col as AnyRec)?.links).forEach((_, j) =>
      defs.push({
        key: `footer.${i}.links.${j}.label`,
        labelKey: 'settings.trFields.navFooterColumnLink',
        labelParams: { n: i + 1, j: j + 1 },
        kind: 'text',
      }),
    );
  });

  return defs;
}

/**
 * Переводимые листы доставки → дескрипторы. Whitelist повторяет
 * SETTINGS_TR_FIELDS.delivery: только подпись зоны. id/price/freeThreshold НЕ
 * переводятся — это машинный ключ и деньги, локаль покупателя на них влиять не
 * должна.
 *
 * Подпись поля несёт БАЗОВОЕ имя зоны параметром `zone`, а не только номер:
 * зон обычно две-три и различаются они именно текстом («В пределах МКАД» vs
 * «За МКАД + область»), поэтому «Зона 2» без имени не даёт владельцу понять,
 * что он переводит. Номер оставлен как запасной ориентир для безымянной зоны.
 */
export function buildDeliveryTrFieldDefs(delivery: AnyRec): TranslatableFieldDef[] {
  const defs: TranslatableFieldDef[] = [];
  const d = (delivery ?? {}) as AnyRec;

  asArray(d.zones).forEach((zone, i) => {
    const base = (zone as AnyRec)?.label;
    defs.push({
      key: `zones.${i}.label`,
      labelKey: 'settings.trFields.deliveryZoneLabel',
      labelParams: { n: i + 1, zone: typeof base === 'string' && base.trim() ? base : String(i + 1) },
      kind: 'text',
    });
  });

  return defs;
}
