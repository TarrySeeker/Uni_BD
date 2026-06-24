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
 *   - SECTION_TYPE_LABELS — человекочитаемые подписи типов;
 *   - emptyFormStateFor — стартовое плоское состояние формы по type;
 *   - buildSectionContent — плоское состояние формы → типизированный `content`,
 *     валидированный тем же CmsSectionContentSchema, что и сервер.
 *
 * Инвариант: `content` НИКОГДА не доверяется клиенту — это лишь удобная сборка
 * на клиенте; сервер (upsertCmsSection) повторно валидирует CmsSectionContentSchema
 * и санитизирует rich-text. Здесь — только UX-удобство и единый контракт полей.
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

/** Описание одного поля формы секции. */
export interface SectionFieldSpec {
  /** Имя поля в плоском состоянии формы (= ключ content или служебное). */
  name: string;
  /** Подпись для пользователя. */
  label: string;
  /** Вид контрола. */
  kind: SectionFieldKind;
  /** Обязательное ли поле (для подсказки в UI; источник правды — Zod). */
  required?: boolean;
  /** Подсказка под полем. */
  hint?: string;
  /** Варианты для kind='select'. */
  options?: { value: string; label: string }[];
}

/** Человекочитаемые подписи типов секций (для селектора «добавить секцию»). */
export const SECTION_TYPE_LABELS: Record<CmsSectionType, string> = {
  hero: 'Hero (баннер с заголовком)',
  text: 'Текстовый блок',
  banner: 'Баннер-картинка',
  products_grid: 'Сетка товаров',
  faq: 'Вопросы и ответы',
  cta: 'Призыв к действию (CTA)',
  gallery: 'Галерея изображений',
};

const PRODUCTS_GRID_MODE_OPTIONS: { value: string; label: string }[] = [
  { value: 'slugs', label: 'По списку товаров (slugs)' },
  { value: 'category', label: 'По категории' },
  { value: 'brand', label: 'По бренду' },
];

/**
 * Для каждого типа секции — поля формы. Порядок задаёт порядок рендера.
 * rich-text-поля (kind='richtext') редактируются Tiptap; их HTML санитизируется
 * на сервере при upsertCmsSection (клиенту не доверяем).
 */
export const SECTION_FIELD_SPECS: Record<CmsSectionType, SectionFieldSpec[]> = {
  hero: [
    { name: 'title', label: 'Заголовок', kind: 'text', required: true },
    { name: 'subtitle', label: 'Подзаголовок', kind: 'text' },
    { name: 'html', label: 'Текст (rich-text)', kind: 'richtext' },
    {
      name: 'imageKey',
      label: 'Изображение (hero)',
      kind: 'image',
      hint: 'Загрузите файл или укажите S3-ключ (media/hero.webp)',
    },
    { name: 'ctaLabel', label: 'Текст кнопки', kind: 'text' },
    { name: 'ctaHref', label: 'Ссылка кнопки', kind: 'text', hint: '/catalog или https://…' },
  ],
  text: [
    { name: 'html', label: 'Текст (rich-text)', kind: 'richtext', required: true },
  ],
  banner: [
    {
      name: 'imageKey',
      label: 'Изображение (баннер)',
      kind: 'image',
      required: true,
      hint: 'Загрузите файл или укажите S3-ключ',
    },
    { name: 'href', label: 'Ссылка', kind: 'text' },
    { name: 'alt', label: 'Alt-текст', kind: 'text' },
  ],
  products_grid: [
    {
      name: 'mode',
      label: 'Источник товаров',
      kind: 'select',
      required: true,
      options: PRODUCTS_GRID_MODE_OPTIONS,
    },
    {
      name: 'slugs',
      label: 'Slugs товаров (через запятую)',
      kind: 'text',
      hint: "Для режима «По списку». Напр.: phone-1, phone-2",
    },
    { name: 'categorySlug', label: 'Slug категории', kind: 'text', hint: 'Для режима «По категории»' },
    { name: 'brandSlug', label: 'Slug бренда', kind: 'text', hint: 'Для режима «По бренду»' },
    { name: 'limit', label: 'Лимит (1–48)', kind: 'number', hint: 'По умолчанию 12' },
    { name: 'title', label: 'Заголовок блока', kind: 'text' },
  ],
  faq: [
    {
      name: 'items',
      label: 'Вопросы и ответы',
      kind: 'pairs',
      required: true,
      hint: 'По строке на пару: Вопрос|Ответ (ответ — rich-text)',
    },
  ],
  cta: [
    { name: 'title', label: 'Заголовок', kind: 'text', required: true },
    { name: 'html', label: 'Текст (rich-text)', kind: 'richtext' },
    { name: 'buttonLabel', label: 'Текст кнопки', kind: 'text', required: true },
    { name: 'buttonHref', label: 'Ссылка кнопки', kind: 'text', required: true },
  ],
  gallery: [
    {
      name: 'images',
      label: 'Изображения',
      kind: 'image',
      required: true,
      hint: 'Загрузите файлы или по строке: ключ-S3|alt (alt опционален)',
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
