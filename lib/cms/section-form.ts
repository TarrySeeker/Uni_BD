/**
 * Чистое ядро формы редактора секций CMS (docs/11 §5.1.5, пакет 5.C-3).
 *
 * Назначение — отделить load-bearing-логику редактора секций от React, чтобы её
 * можно было тестировать без браузера (ADR-004 «сначала тесты»). Модуль НЕ
 * 'use client'/'use server' — чистые данные и функции, переиспользуемые в
 * client-компоненте SectionEditor и в node-юнит-тестах.
 *
 * Здесь живут:
 *   - SECTION_FIELD_SPECS — для каждого `type` список полей (что рисовать в форме);
 *   - SECTION_TYPE_LABEL_KEYS — i18n-ключи подписей типов (+ sectionTypeLabel);
 *   - emptyFormStateFor — стартовое плоское состояние формы по type;
 *   - buildSectionContent — плоское состояние формы → типизированный `content`,
 *     валидированный тем же CmsSectionContentSchema, что и сервер.
 *
 * Инвариант: `content` НИКОГДА не доверяется клиенту — это лишь удобная сборка
 * на клиенте; сервер (upsertCmsSection) повторно валидирует CmsSectionContentSchema
 * и санитизирует rich-text. Здесь — только UX-удобство и единый контракт полей.
 *
 * i18n (волна 6-Б, ОЧАГ 3): дескрипторы полей — ДАННЫЕ, поэтому подписи и подсказки
 * в них хранятся i18n-КЛЮЧАМИ (`labelKey`/`hintKey`, пространство
 * `cms.sectionTypes.*` / `cms.sectionFields.*`), а текст резолвится на рендер-сайте
 * через переводчик next-intl — тот же паттерн, что LEAD_STATUS_LABELS/leadStatusLabel.
 * Параметров у этих подписей нет, поэтому ключ хранится плоской строкой, без
 * `{key, params}`-обёртки: незачем усложнять там, где подставлять нечего.
 * Модуль остаётся чистым (без next-intl-импортов) — юниты работают без Next-контекста.
 */

import { CmsSectionContentSchema } from './schemas';
import type { CmsSectionContent, CmsSectionType } from './types';

// -----------------------------------------------------------------------------
// Описание полей формы по типу секции.
// -----------------------------------------------------------------------------

/** Вид контрола поля в редакторе секции. */
export type SectionFieldKind =
  | 'text' // однострочный input
  | 'textarea' // многострочный, но не rich-text
  | 'richtext' // Tiptap (с серверной санитизацией)
  | 'select' // выпадающий список (options обязательны)
  | 'number' // числовой input
  | 'pairs' // multiline «a|b» список (faq items / gallery images / slugs)
  | 'image'; // загрузчик изображения → S3-ключ (фолбэк: ручной ввод ключа)

/** Вариант выпадающего списка: значение + i18n-ключ подписи. */
export interface SectionFieldOption {
  value: string;
  /** i18n-ключ подписи варианта (резолвится через t() на рендер-сайте). */
  labelKey: string;
}

/** Описание одного поля формы секции. */
export interface SectionFieldSpec {
  /** Имя поля в плоском состоянии формы (= ключ content или служебное). */
  name: string;
  /** i18n-ключ подписи для пользователя (НЕ готовый текст). */
  labelKey: string;
  /** Вид контрола. */
  kind: SectionFieldKind;
  /** Обязательное ли поле (для подсказки в UI; источник правды — Zod). */
  required?: boolean;
  /** i18n-ключ подсказки под полем (НЕ готовый текст). */
  hintKey?: string;
  /** Варианты для kind='select'. */
  options?: SectionFieldOption[];
}

/**
 * i18n-ключи подписей типов секций (для селектора «добавить секцию» и бейджей).
 * Текст — в messages/{ru,en,fr}.json → cms.sectionTypes.*; резолв — sectionTypeLabel.
 */
export const SECTION_TYPE_LABEL_KEYS: Record<CmsSectionType, string> = {
  hero: 'cms.sectionTypes.hero',
  text: 'cms.sectionTypes.text',
  banner: 'cms.sectionTypes.banner',
  products_grid: 'cms.sectionTypes.productsGrid',
  faq: 'cms.sectionTypes.faq',
  cta: 'cms.sectionTypes.cta',
  gallery: 'cms.sectionTypes.gallery',
};

/**
 * Подпись типа секции на языке оператора. Фолбэк — сама строка типа: неизвестный
 * тип из БД не должен превращаться в пустой бейдж (образец — leadStatusLabel).
 */
export function sectionTypeLabel(type: string, t: (key: string) => string): string {
  const key = SECTION_TYPE_LABEL_KEYS[type as CmsSectionType];
  return key ? t(key) : type;
}

const PRODUCTS_GRID_MODE_OPTIONS: SectionFieldOption[] = [
  { value: 'slugs', labelKey: 'cms.sectionFields.mode.options.slugs' },
  { value: 'category', labelKey: 'cms.sectionFields.mode.options.category' },
  { value: 'brand', labelKey: 'cms.sectionFields.mode.options.brand' },
];

/**
 * Для каждого типа секции — поля формы. Порядок задаёт порядок рендера.
 * rich-text-поля (kind='richtext') редактируются Tiptap; их HTML санитизируется
 * на сервере при upsertCmsSection (клиенту не доверяем).
 */
export const SECTION_FIELD_SPECS: Record<CmsSectionType, SectionFieldSpec[]> = {
  hero: [
    { name: 'title', labelKey: 'cms.sectionFields.title.label', kind: 'text', required: true },
    { name: 'subtitle', labelKey: 'cms.sectionFields.subtitle.label', kind: 'text' },
    { name: 'html', labelKey: 'cms.sectionFields.html.label', kind: 'richtext' },
    {
      name: 'imageKey',
      labelKey: 'cms.sectionFields.heroImage.label',
      kind: 'image',
      hintKey: 'cms.sectionFields.heroImage.hint',
    },
    { name: 'ctaLabel', labelKey: 'cms.sectionFields.buttonLabel.label', kind: 'text' },
    {
      name: 'ctaHref',
      labelKey: 'cms.sectionFields.buttonHref.label',
      kind: 'text',
      hintKey: 'cms.sectionFields.buttonHref.hint',
    },
  ],
  text: [
    { name: 'html', labelKey: 'cms.sectionFields.html.label', kind: 'richtext', required: true },
  ],
  banner: [
    {
      name: 'imageKey',
      labelKey: 'cms.sectionFields.bannerImage.label',
      kind: 'image',
      required: true,
      hintKey: 'cms.sectionFields.bannerImage.hint',
    },
    { name: 'href', labelKey: 'cms.sectionFields.href.label', kind: 'text' },
    { name: 'alt', labelKey: 'cms.sectionFields.alt.label', kind: 'text' },
  ],
  products_grid: [
    {
      name: 'mode',
      labelKey: 'cms.sectionFields.mode.label',
      kind: 'select',
      required: true,
      options: PRODUCTS_GRID_MODE_OPTIONS,
    },
    {
      name: 'slugs',
      labelKey: 'cms.sectionFields.slugs.label',
      kind: 'text',
      hintKey: 'cms.sectionFields.slugs.hint',
    },
    {
      name: 'categorySlug',
      labelKey: 'cms.sectionFields.categorySlug.label',
      kind: 'text',
      hintKey: 'cms.sectionFields.categorySlug.hint',
    },
    {
      name: 'brandSlug',
      labelKey: 'cms.sectionFields.brandSlug.label',
      kind: 'text',
      hintKey: 'cms.sectionFields.brandSlug.hint',
    },
    {
      name: 'limit',
      labelKey: 'cms.sectionFields.limit.label',
      kind: 'number',
      hintKey: 'cms.sectionFields.limit.hint',
    },
    { name: 'title', labelKey: 'cms.sectionFields.blockTitle.label', kind: 'text' },
  ],
  faq: [
    {
      name: 'items',
      labelKey: 'cms.sectionFields.faqItems.label',
      kind: 'pairs',
      required: true,
      hintKey: 'cms.sectionFields.faqItems.hint',
    },
  ],
  cta: [
    { name: 'title', labelKey: 'cms.sectionFields.title.label', kind: 'text', required: true },
    { name: 'html', labelKey: 'cms.sectionFields.html.label', kind: 'richtext' },
    {
      name: 'buttonLabel',
      labelKey: 'cms.sectionFields.buttonLabel.label',
      kind: 'text',
      required: true,
    },
    {
      name: 'buttonHref',
      labelKey: 'cms.sectionFields.buttonHref.label',
      kind: 'text',
      required: true,
    },
  ],
  gallery: [
    {
      name: 'images',
      labelKey: 'cms.sectionFields.galleryImages.label',
      kind: 'image',
      required: true,
      hintKey: 'cms.sectionFields.galleryImages.hint',
    },
  ],
};

// -----------------------------------------------------------------------------
// Плоское состояние формы.
// -----------------------------------------------------------------------------

/**
 * Плоское состояние формы секции: все значения — строки (как в DOM-инпутах),
 * плюс дискриминатор `type`. Сборка в типизированный content — buildSectionContent.
 */
export type SectionFormState = { type: CmsSectionType } & Record<string, string>;

/** Стартовое (пустое) состояние формы по типу секции. */
export function emptyFormStateFor(type: CmsSectionType): SectionFormState {
  const state: SectionFormState = { type };
  for (const field of SECTION_FIELD_SPECS[type]) {
    state[field.name] = '';
  }
  // Разумные дефолты.
  if (type === 'products_grid') {
    state.mode = 'slugs';
    state.limit = '12';
  }
  return state;
}

/**
 * Восстанавливает плоское состояние формы из уже сохранённого `content`
 * (для режима редактирования существующей секции).
 */
export function formStateFromContent(content: Record<string, unknown>): SectionFormState {
  const type = (content.type as CmsSectionType) ?? 'text';
  const state = emptyFormStateFor(type);

  for (const field of SECTION_FIELD_SPECS[type]) {
    const raw = content[field.name];
    if (raw === undefined || raw === null) continue;

    // pairs-семантика по ИМЕНИ поля (items/images), а не по kind: gallery.images
    // теперь kind='image' (загрузчик), но в форме хранится как multiline «ключ|alt».
    if (field.kind === 'pairs' || field.name === 'items' || field.name === 'images') {
      state[field.name] = serializePairs(field.name, raw);
    } else if (Array.isArray(raw)) {
      state[field.name] = raw.join(', ');
    } else {
      state[field.name] = String(raw);
    }
  }
  return state;
}

/** Сериализует массив пар (faq.items / gallery.images / slugs) обратно в multiline. */
function serializePairs(name: string, raw: unknown): string {
  if (!Array.isArray(raw)) return '';
  if (name === 'items') {
    return raw
      .map((it) => `${(it as { q?: string }).q ?? ''}|${(it as { a?: string }).a ?? ''}`)
      .join('\n');
  }
  if (name === 'images') {
    return raw
      .map((it) => {
        const img = it as { imageKey?: string; alt?: string };
        return img.alt ? `${img.imageKey ?? ''}|${img.alt}` : `${img.imageKey ?? ''}`;
      })
      .join('\n');
  }
  return raw.map((x) => String(x)).join(', ');
}

// -----------------------------------------------------------------------------
// Сборка content из плоского состояния + Zod-валидация.
// -----------------------------------------------------------------------------

/** Результат сборки content из формы. */
export type BuildContentResult =
  | { ok: true; content: CmsSectionContent }
  | { ok: false; fieldErrors: Record<string, string> };

/** Непустая обрезанная строка или undefined (для опциональных полей). */
function opt(v: string | undefined): string | undefined {
  const t = (v ?? '').trim();
  return t.length > 0 ? t : undefined;
}

/** Разбивает строку «a, b, c» в массив непустых элементов. */
function splitList(v: string | undefined): string[] {
  return (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Разбивает multiline «q|a» в массив пар. */
function parsePairs(v: string | undefined): { left: string; right: string }[] {
  return (v ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const idx = line.indexOf('|');
      if (idx === -1) return { left: line, right: '' };
      return { left: line.slice(0, idx).trim(), right: line.slice(idx + 1).trim() };
    });
}

/**
 * Собирает «сырой» (до Zod) объект content из плоского состояния формы по type.
 * Пустые опциональные поля отбрасываются (чтобы не слать пустые строки в Zod).
 */
function rawContentFromState(state: SectionFormState): Record<string, unknown> {
  switch (state.type) {
    case 'text':
      return { type: 'text', html: state.html ?? '' };

    case 'hero':
      return {
        type: 'hero',
        title: (state.title ?? '').trim(),
        ...(opt(state.subtitle) ? { subtitle: opt(state.subtitle) } : {}),
        ...(opt(state.html) ? { html: state.html } : {}),
        ...(opt(state.imageKey) ? { imageKey: opt(state.imageKey) } : {}),
        ...(opt(state.ctaLabel) ? { ctaLabel: opt(state.ctaLabel) } : {}),
        ...(opt(state.ctaHref) ? { ctaHref: opt(state.ctaHref) } : {}),
      };

    case 'banner':
      return {
        type: 'banner',
        imageKey: (state.imageKey ?? '').trim(),
        ...(opt(state.href) ? { href: opt(state.href) } : {}),
        ...(opt(state.alt) ? { alt: opt(state.alt) } : {}),
      };

    case 'products_grid': {
      const mode = (state.mode ?? 'slugs') as 'slugs' | 'category' | 'brand';
      const limitNum = Number((state.limit ?? '').trim() || '12');
      const base: Record<string, unknown> = {
        type: 'products_grid',
        mode,
        limit: Number.isFinite(limitNum) ? limitNum : 12,
        ...(opt(state.title) ? { title: opt(state.title) } : {}),
      };
      if (mode === 'slugs') {
        const slugs = splitList(state.slugs);
        if (slugs.length > 0) base.slugs = slugs;
      } else if (mode === 'category') {
        if (opt(state.categorySlug)) base.categorySlug = opt(state.categorySlug);
      } else if (mode === 'brand') {
        if (opt(state.brandSlug)) base.brandSlug = opt(state.brandSlug);
      }
      return base;
    }

    case 'faq':
      return {
        type: 'faq',
        items: parsePairs(state.items).map((p) => ({ q: p.left, a: p.right })),
      };

    case 'cta':
      return {
        type: 'cta',
        title: (state.title ?? '').trim(),
        ...(opt(state.html) ? { html: state.html } : {}),
        buttonLabel: (state.buttonLabel ?? '').trim(),
        buttonHref: (state.buttonHref ?? '').trim(),
      };

    case 'gallery':
      return {
        type: 'gallery',
        images: parsePairs(state.images).map((p) =>
          p.right ? { imageKey: p.left, alt: p.right } : { imageKey: p.left },
        ),
      };

    default:
      return { type: state.type };
  }
}

/**
 * Плоское состояние формы → типизированный content, провалидированный
 * CmsSectionContentSchema (тот же контракт, что и сервер). При ошибке — карта
 * `поле → сообщение` (для подсветки в форме). Сервер всё равно перевалидирует.
 */
export function buildSectionContent(state: SectionFormState): BuildContentResult {
  const raw = rawContentFromState(state);
  const parsed = CmsSectionContentSchema.safeParse(raw);
  if (parsed.success) {
    return { ok: true, content: parsed.data as CmsSectionContent };
  }
  const fieldErrors: Record<string, string> = {};
  for (const issue of parsed.error.issues) {
    const key = issue.path.length > 0 ? String(issue.path[0]) : '_';
    if (!fieldErrors[key]) fieldErrors[key] = issue.message;
  }
  return { ok: false, fieldErrors };
}
