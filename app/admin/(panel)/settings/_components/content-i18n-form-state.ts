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
export type ContentI18nSection = 'home' | 'navigation' | 'branding' | 'seo' | 'contacts';

// -----------------------------------------------------------------------------
// Плоские дескрипторы (branding/seo/contacts): whitelist = SETTINGS_TR_FIELDS.
// Порядок и набор ключей ОБЯЗАНЫ совпадать с SETTINGS_TR_FIELDS (guard-тест).
// -----------------------------------------------------------------------------

export const BRANDING_TR_FIELD_DEFS: readonly TranslatableFieldDef[] = [
  { key: 'shopName', label: 'Название магазина', kind: 'text' },
];

export const SEO_TR_FIELD_DEFS: readonly TranslatableFieldDef[] = [
  { key: 'site_name', label: 'Название сайта', kind: 'text' },
  { key: 'title_template', label: 'Шаблон заголовка страниц', kind: 'text' },
  { key: 'default_description', label: 'Описание по умолчанию', kind: 'textarea' },
];

export const CONTACTS_TR_FIELD_DEFS: readonly TranslatableFieldDef[] = [
  { key: 'address', label: 'Адрес', kind: 'text' },
  { key: 'workingHours', label: 'Часы работы', kind: 'text' },
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
 * label = человекочитаемая подпись). Whitelist повторяет SETTINGS_TR_FIELDS.home;
 * href/imageKey/embedUrl/enabled НЕ включены (идентификаторы, не текст).
 */
export function buildHomeTrFieldDefs(home: AnyRec): TranslatableFieldDef[] {
  const defs: TranslatableFieldDef[] = [];
  const h = (home ?? {}) as AnyRec;
  const block = (key: string): AnyRec => (h[key] as AnyRec) ?? {};

  // hero
  defs.push({ key: 'hero.title', label: 'Обложка — заголовок', kind: 'text' });
  defs.push({ key: 'hero.subtitle', label: 'Обложка — подзаголовок', kind: 'text' });
  defs.push({ key: 'hero.ctaLabel', label: 'Обложка — текст кнопки', kind: 'text' });

  // about
  const about = block('about');
  defs.push({ key: 'about.title', label: 'О бренде — заголовок', kind: 'text' });
  asArray(about.paragraphs).forEach((_, i) =>
    defs.push({ key: `about.paragraphs.${i}`, label: `О бренде — абзац ${i + 1}`, kind: 'textarea' }),
  );
  asArray(about.values).forEach((_, i) =>
    defs.push({ key: `about.values.${i}`, label: `О бренде — ценность ${i + 1}`, kind: 'text' }),
  );

  // quality
  const quality = block('quality');
  defs.push({ key: 'quality.title', label: 'Качество ткани — заголовок', kind: 'text' });
  asArray(quality.items).forEach((_, i) =>
    defs.push({ key: `quality.items.${i}`, label: `Качество ткани — пункт ${i + 1}`, kind: 'text' }),
  );

  // delivery
  asArray(block('delivery').items).forEach((_, i) => {
    defs.push({ key: `delivery.items.${i}.title`, label: `Доставка — пункт ${i + 1} (заголовок)`, kind: 'text' });
    defs.push({ key: `delivery.items.${i}.text`, label: `Доставка — пункт ${i + 1} (описание)`, kind: 'textarea' });
  });

  // valuesStrip
  asArray(block('valuesStrip').items).forEach((_, i) => {
    defs.push({ key: `valuesStrip.items.${i}.title`, label: `Лента ценностей — пункт ${i + 1} (заголовок)`, kind: 'text' });
    defs.push({ key: `valuesStrip.items.${i}.text`, label: `Лента ценностей — пункт ${i + 1} (описание)`, kind: 'text' });
  });

  // philosophy
  defs.push({ key: 'philosophy.eyebrow', label: 'Философия — надзаголовок', kind: 'text' });
  defs.push({ key: 'philosophy.title', label: 'Философия — заголовок', kind: 'text' });
  defs.push({ key: 'philosophy.text', label: 'Философия — абзац', kind: 'textarea' });
  defs.push({ key: 'philosophy.linkLabel', label: 'Философия — текст ссылки', kind: 'text' });

  // looks
  const looks = block('looks');
  defs.push({ key: 'looks.title', label: 'Образы — заголовок', kind: 'text' });
  asArray(looks.categories).forEach((_, i) => {
    defs.push({ key: `looks.categories.${i}.title`, label: `Образы — категория ${i + 1} (заголовок)`, kind: 'text' });
    defs.push({ key: `looks.categories.${i}.text`, label: `Образы — категория ${i + 1} (текст)`, kind: 'textarea' });
  });

  // tiles
  asArray(block('tiles').items).forEach((_, i) =>
    defs.push({ key: `tiles.items.${i}.title`, label: `Плитки категорий — плитка ${i + 1}`, kind: 'text' }),
  );

  // designers
  const designers = block('designers');
  defs.push({ key: 'designers.title', label: 'Дизайнеры — заголовок', kind: 'text' });
  asArray(designers.items).forEach((_, i) =>
    defs.push({ key: `designers.items.${i}.name`, label: `Дизайнеры — имя ${i + 1}`, kind: 'text' }),
  );

  // slider
  asArray(block('slider').slides).forEach((_, i) => {
    defs.push({ key: `slider.slides.${i}.name`, label: `Промо-слайдер — слайд ${i + 1} (название)`, kind: 'text' });
    defs.push({ key: `slider.slides.${i}.caption`, label: `Промо-слайдер — слайд ${i + 1} (подпись)`, kind: 'text' });
  });

  // corpCert
  asArray(block('corpCert').tiles).forEach((_, i) =>
    defs.push({ key: `corpCert.tiles.${i}.title`, label: `Корпоративным / сертификаты — плитка ${i + 1}`, kind: 'text' }),
  );

  return defs;
}

/**
 * Переводимые листы навигации → дескрипторы. Whitelist повторяет
 * SETTINGS_TR_FIELDS.navigation: метки пунктов шапки, заголовки колонок футера и
 * метки ссылок футера. href НЕ переводится.
 */
export function buildNavigationTrFieldDefs(navigation: AnyRec): TranslatableFieldDef[] {
  const defs: TranslatableFieldDef[] = [];
  const nav = (navigation ?? {}) as AnyRec;

  asArray(nav.header).forEach((_, i) =>
    defs.push({ key: `header.${i}.label`, label: `Меню шапки — пункт ${i + 1}`, kind: 'text' }),
  );

  asArray(nav.footer).forEach((col, i) => {
    defs.push({ key: `footer.${i}.title`, label: `Футер — колонка ${i + 1} (заголовок)`, kind: 'text' });
    asArray((col as AnyRec)?.links).forEach((_, j) =>
      defs.push({
        key: `footer.${i}.links.${j}.label`,
        label: `Футер — колонка ${i + 1}, ссылка ${j + 1}`,
        kind: 'text',
      }),
    );
  });

  return defs;
}
