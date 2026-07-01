'use client';

/**
 * Переиспользуемый SEO-набор полей для форм товара/категории/бренда (docs/11
 * §5.3.5, пакет 5.S-1). Один компонент для всех сущностей каталога (catalog.write)
 * и CMS-страниц (cms.write, позже). Контролируемый: состояние держит родитель,
 * сюда приходят value + onChange (изоляция от конкретной формы).
 *
 * Поля: seoTitle, seoDescription (с превью-сниппетом), ogTitle/ogDescription,
 * ogImageKey, canonicalUrl (плейсхолдер = автоген из slug+домена), noindex.
 * ogImageKey — КЛЮЧ объекта S3 (URL собирает витрина через storage). canonicalUrl
 * валидируется на сервере (абсолютный https / path с '/').
 */

export interface SeoFieldsetValue {
  seoTitle: string;
  seoDescription: string;
  ogTitle: string;
  ogDescription: string;
  ogImageKey: string;
  canonicalUrl: string;
  noindex: boolean;
}

/** Пустое начальное значение набора SEO-полей. */
export const EMPTY_SEO_FIELDSET: SeoFieldsetValue = {
  seoTitle: '',
  seoDescription: '',
  ogTitle: '',
  ogDescription: '',
  ogImageKey: '',
  canonicalUrl: '',
  noindex: false,
};

export interface SeoFieldsetProps {
  value: SeoFieldsetValue;
  onChange: (next: SeoFieldsetValue) => void;
  /** Префикс id полей (уникальность при нескольких наборах на странице). */
  idPrefix?: string;
  /** Подсказка автоген-canonical (например `https://shop/product/<slug>`). */
  canonicalPlaceholder?: string;
  /** Ошибки по полям (из ActionResult.fieldErrors). */
  fieldErrors?: Record<string, string | undefined>;
  /**
   * Слот под полем «Картинка для соцсетей» — сюда вызывающая форма помещает свой
   * загрузчик файла (находка 13 аудита). Компонент общий (товар/бренд/CMS), поэтому
   * конкретный экшен загрузки в него НЕ вшит: каждая форма передаёт свой виджет,
   * который кладёт полученный ключ/URL в value.ogImageKey через onChange.
   */
  ogImageSlot?: React.ReactNode;
  /**
   * Режим «только чтение» (находка 14 аудита): дизейблит все поля для пользователя
   * без права записи, чтобы интерфейс не выглядел рабочим там, где сервер отклонит.
   */
  disabled?: boolean;
}

const inputCls = 'mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm';
const labelCls = 'block text-sm font-medium text-gray-700';

export function SeoFieldset({
  value,
  onChange,
  idPrefix = 'seo',
  canonicalPlaceholder,
  fieldErrors = {},
  ogImageSlot,
  disabled = false,
}: SeoFieldsetProps) {
  const set = <K extends keyof SeoFieldsetValue>(k: K, v: SeoFieldsetValue[K]) =>
    onChange({ ...value, [k]: v });

  const id = (f: string) => `${idPrefix}-${f}`;
  const err = (f: string) =>
    fieldErrors[f] ? <p className="mt-1 text-xs text-red-600">{fieldErrors[f]}</p> : null;

  return (
    <fieldset className="rounded-lg border border-gray-200 p-4">
      <legend className="px-1 text-sm font-semibold text-gray-700">SEO</legend>

      <div className="grid grid-cols-1 gap-4">
        <div>
          <label htmlFor={id('title')} className={labelCls}>
            Заголовок для поисковиков
          </label>
          <input
            id={id('title')}
            value={value.seoTitle}
            onChange={(e) => set('seoTitle', e.target.value)}
            className={inputCls}
            placeholder="По умолчанию — название сущности"
            disabled={disabled}
          />
          {err('seoTitle')}
        </div>

        <div>
          <label htmlFor={id('desc')} className={labelCls}>
            Описание для поисковиков
          </label>
          <textarea
            id={id('desc')}
            value={value.seoDescription}
            onChange={(e) => set('seoDescription', e.target.value)}
            rows={2}
            className={inputCls}
            disabled={disabled}
          />
          {/* Превью-сниппет поисковой выдачи. */}
          {(value.seoTitle || value.seoDescription) && (
            <div className="mt-2 rounded border border-gray-100 bg-gray-50 p-2">
              <p className="truncate text-sm text-blue-700">
                {value.seoTitle || 'Заголовок'}
              </p>
              <p className="line-clamp-2 text-xs text-gray-600">
                {value.seoDescription || 'Описание появится здесь…'}
              </p>
            </div>
          )}
          {err('seoDescription')}
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div>
            <label htmlFor={id('ogtitle')} className={labelCls}>
              OG-заголовок
            </label>
            <input
              id={id('ogtitle')}
              value={value.ogTitle}
              onChange={(e) => set('ogTitle', e.target.value)}
              className={inputCls}
              disabled={disabled}
            />
            {err('ogTitle')}
          </div>
          <div>
            <label htmlFor={id('ogimg')} className={labelCls}>
              Картинка для соцсетей (адрес файла)
            </label>
            <input
              id={id('ogimg')}
              value={value.ogImageKey}
              onChange={(e) => set('ogImageKey', e.target.value)}
              className={inputCls}
              placeholder="products/<id>/og.webp"
              disabled={disabled}
            />
            {/* Слот загрузчика OG-картинки (находка 13): форма передаёт свой
                виджет загрузки; адрес подставляется в поле автоматически. */}
            {!disabled && ogImageSlot ? ogImageSlot : null}
            {err('ogImageKey')}
          </div>
        </div>

        <div>
          <label htmlFor={id('ogdesc')} className={labelCls}>
            OG-описание
          </label>
          <textarea
            id={id('ogdesc')}
            value={value.ogDescription}
            onChange={(e) => set('ogDescription', e.target.value)}
            rows={2}
            className={inputCls}
            disabled={disabled}
          />
          {err('ogDescription')}
        </div>

        <div>
          <label htmlFor={id('canonical')} className={labelCls}>
            Основной адрес страницы
          </label>
          <input
            id={id('canonical')}
            value={value.canonicalUrl}
            onChange={(e) => set('canonicalUrl', e.target.value)}
            className={inputCls}
            placeholder={canonicalPlaceholder ?? 'Автоген из slug и домена'}
            disabled={disabled}
          />
          <p className="mt-1 text-xs text-gray-400">
            Абсолютный https-URL или путь с ведущим «/». Пусто — авто из slug.
          </p>
          {err('canonicalUrl')}
        </div>

        <label className="flex items-center gap-2 text-sm text-gray-700">
          <input
            type="checkbox"
            checked={value.noindex}
            onChange={(e) => set('noindex', e.target.checked)}
            disabled={disabled}
          />
          Скрыть страницу от поисковиков
        </label>
      </div>
    </fieldset>
  );
}
