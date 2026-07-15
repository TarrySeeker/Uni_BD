'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import type { ActionResult } from '@/lib/server/action';
import type { EffectiveSettings } from '@/lib/config/settings';

import { updateHomeContentAction } from './form-actions';
import { errorMessage } from './action-result';
import { ImageUploadButton } from './ImageUploadButton';

/**
 * Форма «Главная страница» (ADR-018, закрывает G-02/G-03): редактируемый контент
 * главной витрины — hero (CTA/фон), «О бренде», «Качество ткани», «Доставка и
 * оплата». Мутация — updateHomeContentAction (settings.manage). Пустые поля →
 * не отправляем (падают на дефолт витрины). Изображения пока задаются S3-ключом
 * (как og в SEO); полноценный загрузчик файлов — отдельным шагом.
 */
type Fail = Extract<ActionResult<unknown>, { ok: false }>;

/** Текст по строкам → массив непустых строк. */
function linesToArr(text: string): string[] {
  return text
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** «title | text» по строкам → массив пар (обе части обязательны). */
function pairsToArr(text: string): { title: string; text: string }[] {
  return text
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('|');
      if (idx < 0) return null;
      const title = line.slice(0, idx).trim();
      const t = line.slice(idx + 1).trim();
      return title && t ? { title, text: t } : null;
    })
    .filter((x): x is { title: string; text: string } => x !== null);
}

export function HomeContentForm({ home }: { home: EffectiveSettings['home'] }) {
  const router = useRouter();
  const [error, setError] = useState<Fail | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // hero
  const [heroTitle, setHeroTitle] = useState(home.hero.title ?? '');
  const [heroSubtitle, setHeroSubtitle] = useState(home.hero.subtitle ?? '');
  const [heroCtaLabel, setHeroCtaLabel] = useState(home.hero.ctaLabel ?? '');
  const [heroCtaHref, setHeroCtaHref] = useState(home.hero.ctaHref ?? '');
  const [heroImageKey, setHeroImageKey] = useState(home.hero.imageKey ?? '');
  // about
  const [aboutTitle, setAboutTitle] = useState(home.about.title ?? '');
  const [aboutParagraphs, setAboutParagraphs] = useState((home.about.paragraphs ?? []).join('\n'));
  const [aboutValues, setAboutValues] = useState((home.about.values ?? []).join('\n'));
  const [aboutImageKeys, setAboutImageKeys] = useState((home.about.imageKeys ?? []).join('\n'));
  // quality
  const [qualityTitle, setQualityTitle] = useState(home.quality.title ?? '');
  const [qualityItems, setQualityItems] = useState((home.quality.items ?? []).join('\n'));
  // delivery
  const [deliveryItems, setDeliveryItems] = useState(
    (home.delivery.items ?? []).map((i) => `${i.title} | ${i.text}`).join('\n'),
  );
  // valuesStrip (B1) — лента ценностей: показ + список пар title/text.
  const [valuesStripEnabled, setValuesStripEnabled] = useState(home.valuesStrip.enabled);
  const [valuesStripItems, setValuesStripItems] = useState(
    (home.valuesStrip.items ?? []).map((i) => `${i.title} | ${i.text}`).join('\n'),
  );
  // philosophy (B3)
  const [philEyebrow, setPhilEyebrow] = useState(home.philosophy.eyebrow ?? '');
  const [philTitle, setPhilTitle] = useState(home.philosophy.title ?? '');
  const [philText, setPhilText] = useState(home.philosophy.text ?? '');
  const [philLinkLabel, setPhilLinkLabel] = useState(home.philosophy.linkLabel ?? '');
  const [philLinkHref, setPhilLinkHref] = useState(home.philosophy.linkHref ?? '');
  // looks (ТЗ_2) — «Образы»: показ + заголовок + репитер категорий (фото/заголовок/текст).
  const [looksEnabled, setLooksEnabled] = useState(home.looks.enabled);
  const [looksTitle, setLooksTitle] = useState(home.looks.title ?? '');
  const [looksCategories, setLooksCategories] = useState<
    { title: string; text: string; imageKey: string }[]
  >(() => (home.looks.categories ?? []).map((c) => ({ ...c })));

  function setLookCategory(i: number, field: 'title' | 'text' | 'imageKey', value: string) {
    setLooksCategories((prev) => prev.map((c, idx) => (idx === i ? { ...c, [field]: value } : c)));
  }
  function addLookCategory() {
    setLooksCategories((prev) => [...prev, { title: '', text: '', imageKey: '' }]);
  }
  function removeLookCategory(i: number) {
    setLooksCategories((prev) => prev.filter((_, idx) => idx !== i));
  }

  // tiles (M4) — «Плитки категорий»: показ + репитер плиток (заголовок/ссылка/фото).
  const [tilesEnabled, setTilesEnabled] = useState(home.tiles.enabled);
  const [tilesItems, setTilesItems] = useState<
    { title: string; href: string; imageKey: string }[]
  >(() => (home.tiles.items ?? []).map((t) => ({ ...t })));

  function setTile(i: number, field: 'title' | 'href' | 'imageKey', value: string) {
    setTilesItems((prev) => prev.map((t, idx) => (idx === i ? { ...t, [field]: value } : t)));
  }
  function addTile() {
    setTilesItems((prev) => [...prev, { title: '', href: '', imageKey: '' }]);
  }
  function removeTile(i: number) {
    setTilesItems((prev) => prev.filter((_, idx) => idx !== i));
  }

  // video (M4) — «Видео»: показ + один https-embed URL (Vimeo/YouTube-embed).
  const [videoEnabled, setVideoEnabled] = useState(home.video.enabled);
  const [videoEmbedUrl, setVideoEmbedUrl] = useState(home.video.embedUrl ?? '');

  // designers (M4) — «Дизайнеры»: показ + заголовок + репитер записей (имя/ссылка/
  // аватар/работа + позиции фото avatarTop/workTop 0..100). Числа держим строками
  // для контролируемых input'ов; на сабмите приводим к числу (num), пусто → дефолт merge.
  const [designersEnabled, setDesignersEnabled] = useState(home.designers.enabled);
  const [designersTitle, setDesignersTitle] = useState(home.designers.title ?? '');
  const [designersItems, setDesignersItems] = useState<
    {
      name: string;
      href: string;
      avatarImageKey: string;
      workImageKey: string;
      avatarTop: string;
      workTop: string;
    }[]
  >(() =>
    (home.designers.items ?? []).map((d) => ({
      name: d.name,
      href: d.href,
      avatarImageKey: d.avatarImageKey,
      workImageKey: d.workImageKey,
      avatarTop: String(d.avatarTop),
      workTop: String(d.workTop),
    })),
  );

  function setDesigner(
    i: number,
    field: 'name' | 'href' | 'avatarImageKey' | 'workImageKey' | 'avatarTop' | 'workTop',
    value: string,
  ) {
    setDesignersItems((prev) => prev.map((d, idx) => (idx === i ? { ...d, [field]: value } : d)));
  }
  function addDesigner() {
    setDesignersItems((prev) => [
      ...prev,
      { name: '', href: '', avatarImageKey: '', workImageKey: '', avatarTop: '', workTop: '' },
    ]);
  }
  function removeDesigner(i: number) {
    setDesignersItems((prev) => prev.filter((_, idx) => idx !== i));
  }

  function s(v: string): string | undefined {
    const t = v.trim();
    return t.length > 0 ? t : undefined;
  }

  /** Строка → число (или undefined, если пусто). Пусто → merge добьёт дефолт (50). */
  function num(v: string): number | undefined {
    const t = v.trim();
    if (t.length === 0) return undefined;
    const n = Number(t);
    // Округляем: позиции avatarTop/workTop — целые (Zod .int()); дробный ввод
    // (напр. 50.5) иначе завалил бы валидацию всей формы.
    return Number.isFinite(n) ? Math.round(n) : undefined;
  }

  async function save() {
    setPending(true);
    setError(null);
    setSuccess(null);
    const result = await updateHomeContentAction({
      home: {
        hero: {
          title: s(heroTitle),
          subtitle: s(heroSubtitle),
          ctaLabel: s(heroCtaLabel),
          ctaHref: s(heroCtaHref),
          imageKey: s(heroImageKey),
        },
        about: {
          title: s(aboutTitle),
          paragraphs: linesToArr(aboutParagraphs),
          values: linesToArr(aboutValues),
          imageKeys: linesToArr(aboutImageKeys),
        },
        quality: {
          title: s(qualityTitle),
          items: linesToArr(qualityItems),
        },
        delivery: {
          items: pairsToArr(deliveryItems),
        },
        valuesStrip: {
          enabled: valuesStripEnabled,
          items: pairsToArr(valuesStripItems),
        },
        philosophy: {
          eyebrow: s(philEyebrow),
          title: s(philTitle),
          text: s(philText),
          linkLabel: s(philLinkLabel),
          linkHref: s(philLinkHref),
        },
        looks: {
          enabled: looksEnabled,
          title: s(looksTitle),
          // Только полностью заполненные категории (все три поля) — неполные строки
          // отбрасываем, как pairsToArr для delivery/valuesStrip (иначе Zod-отказ).
          categories: looksCategories
            .map((c) => ({ title: c.title.trim(), text: c.text.trim(), imageKey: c.imageKey.trim() }))
            .filter((c) => c.title && c.text && c.imageKey),
        },
        tiles: {
          enabled: tilesEnabled,
          // Только полностью заполненные плитки (все три поля) — как looks-категории.
          items: tilesItems
            .map((t) => ({ title: t.title.trim(), href: t.href.trim(), imageKey: t.imageKey.trim() }))
            .filter((t) => t.title && t.href && t.imageKey),
        },
        video: {
          enabled: videoEnabled,
          // Пусто → не отправляем (падает на дефолт витрины); иначе Zod проверит https.
          embedUrl: s(videoEmbedUrl),
        },
        designers: {
          enabled: designersEnabled,
          title: s(designersTitle),
          // Только полностью заполненные записи (имя/ссылка/оба фото). Позиции —
          // опциональны: пусто → опускаем, merge добьёт 50.
          items: designersItems
            .map((d) => {
              const item: {
                name: string;
                href: string;
                avatarImageKey: string;
                workImageKey: string;
                avatarTop?: number;
                workTop?: number;
              } = {
                name: d.name.trim(),
                href: d.href.trim(),
                avatarImageKey: d.avatarImageKey.trim(),
                workImageKey: d.workImageKey.trim(),
              };
              const at = num(d.avatarTop);
              const wt = num(d.workTop);
              if (at !== undefined) item.avatarTop = at;
              if (wt !== undefined) item.workTop = wt;
              return item;
            })
            .filter((d) => d.name && d.href && d.avatarImageKey && d.workImageKey),
        },
      },
    });
    setPending(false);
    if (result.ok) {
      setSuccess('Контент главной сохранён.');
      router.refresh();
    } else {
      setError(result);
    }
  }

  const inputCls = 'mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm';
  const labelCls = 'block text-sm font-medium text-gray-700';
  const hintCls = 'mt-1 text-xs text-gray-500';

  return (
    <div>
      {error ? (
        <div role="alert" className="mb-4 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {errorMessage(error)}
        </div>
      ) : null}
      {success ? (
        <div role="status" className="mb-4 rounded border border-green-200 bg-green-50 p-3 text-sm text-green-700">
          {success}
        </div>
      ) : null}

      <p className="mb-5 text-sm text-gray-600">
        Контент главной страницы витрины. Пустое поле — вернётся значение по умолчанию.
        В списках — по одному пункту на строку.
      </p>

      {/* Hero / обложка */}
      <fieldset className="mb-6 rounded border border-gray-200 p-4">
        <legend className="px-1 text-sm font-semibold text-gray-800">Обложка (hero)</legend>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div>
            <label htmlFor="home-hero-cta" className={labelCls}>Текст кнопки</label>
            <input id="home-hero-cta" value={heroCtaLabel} onChange={(e) => setHeroCtaLabel(e.target.value)}
              placeholder="Смотреть коллекцию" className={inputCls} />
          </div>
          <div>
            <label htmlFor="home-hero-href" className={labelCls}>Ссылка кнопки</label>
            <input id="home-hero-href" value={heroCtaHref} onChange={(e) => setHeroCtaHref(e.target.value)}
              placeholder="/catalog" className={inputCls} />
          </div>
          <div>
            <label htmlFor="home-hero-title" className={labelCls}>Заголовок (необязательно)</label>
            <input id="home-hero-title" value={heroTitle} onChange={(e) => setHeroTitle(e.target.value)} className={inputCls} />
          </div>
          <div>
            <label htmlFor="home-hero-sub" className={labelCls}>Подзаголовок (необязательно)</label>
            <input id="home-hero-sub" value={heroSubtitle} onChange={(e) => setHeroSubtitle(e.target.value)} className={inputCls} />
          </div>
          <div className="lg:col-span-2">
            <label htmlFor="home-hero-img" className={labelCls}>Фон обложки</label>
            <input id="home-hero-img" value={heroImageKey} onChange={(e) => setHeroImageKey(e.target.value)}
              placeholder="home/hero.webp" className={inputCls} />
            <ImageUploadButton label="Загрузить фон обложки" onUploaded={(key) => setHeroImageKey(key)} />
            <p className={hintCls}>Загрузите файл или укажите адрес уже загруженного. Пусто — фон витрины по умолчанию.</p>
          </div>
        </div>
      </fieldset>

      {/* О бренде */}
      <fieldset className="mb-6 rounded border border-gray-200 p-4">
        <legend className="px-1 text-sm font-semibold text-gray-800">Блок «О бренде»</legend>
        <div className="grid grid-cols-1 gap-4">
          <div>
            <label htmlFor="home-about-title" className={labelCls}>Заголовок</label>
            <input id="home-about-title" value={aboutTitle} onChange={(e) => setAboutTitle(e.target.value)}
              placeholder="О бренде" className={inputCls} />
          </div>
          <div>
            <label htmlFor="home-about-p" className={labelCls}>Абзацы (по одному на строку)</label>
            <textarea id="home-about-p" value={aboutParagraphs} onChange={(e) => setAboutParagraphs(e.target.value)}
              rows={4} className={inputCls} />
          </div>
          <div>
            <label htmlFor="home-about-v" className={labelCls}>Ценности / теги (по одному на строку)</label>
            <textarea id="home-about-v" value={aboutValues} onChange={(e) => setAboutValues(e.target.value)}
              rows={3} className={inputCls} />
          </div>
          <div>
            <label htmlFor="home-about-img" className={labelCls}>Фото галереи «О бренде» (по одному адресу на строку)</label>
            <textarea id="home-about-img" value={aboutImageKeys} onChange={(e) => setAboutImageKeys(e.target.value)}
              rows={2} className={inputCls} />
            <ImageUploadButton label="Загрузить фото" onUploaded={(key) => setAboutImageKeys((p) => (p ? `${p}\n${key}` : key))} />
          </div>
        </div>
      </fieldset>

      {/* Качество ткани */}
      <fieldset className="mb-6 rounded border border-gray-200 p-4">
        <legend className="px-1 text-sm font-semibold text-gray-800">Блок «Качество ткани»</legend>
        <div className="grid grid-cols-1 gap-4">
          <div>
            <label htmlFor="home-q-title" className={labelCls}>Заголовок</label>
            <input id="home-q-title" value={qualityTitle} onChange={(e) => setQualityTitle(e.target.value)}
              placeholder="Качество ткани" className={inputCls} />
          </div>
          <div>
            <label htmlFor="home-q-items" className={labelCls}>Пункты (по одному на строку)</label>
            <textarea id="home-q-items" value={qualityItems} onChange={(e) => setQualityItems(e.target.value)}
              rows={4} className={inputCls} />
          </div>
        </div>
      </fieldset>

      {/* Доставка и оплата */}
      <fieldset className="mb-6 rounded border border-gray-200 p-4">
        <legend className="px-1 text-sm font-semibold text-gray-800">Блок «Доставка и оплата»</legend>
        <div>
          <label htmlFor="home-delivery" className={labelCls}>Пункты: «Заголовок | Описание» (по одному на строку)</label>
          <textarea id="home-delivery" value={deliveryItems} onChange={(e) => setDeliveryItems(e.target.value)}
            rows={4} className={inputCls} placeholder={'СДЭК | Доставка по всей России…\nСроки | Москва — 1–2 дня…'} />
          <p className={hintCls}>Например: <code>СДЭК | Доставка по всей России. Пункты выдачи и курьер.</code></p>
        </div>
      </fieldset>

      {/* Лента ценностей (B1) */}
      <fieldset className="mb-6 rounded border border-gray-200 p-4">
        <legend className="px-1 text-sm font-semibold text-gray-800">Лента ценностей</legend>
        <div className="grid grid-cols-1 gap-4">
          <label className="flex items-center gap-2 text-sm font-medium text-gray-700">
            <input
              type="checkbox"
              checked={valuesStripEnabled}
              onChange={(e) => setValuesStripEnabled(e.target.checked)}
              className="h-4 w-4 rounded border-gray-300"
            />
            Показывать ленту на главной
          </label>
          <div>
            <label htmlFor="home-values-strip" className={labelCls}>
              Пункты: «Заголовок | Описание» (по одному на строку)
            </label>
            <textarea id="home-values-strip" value={valuesStripItems} onChange={(e) => setValuesStripItems(e.target.value)}
              rows={4} className={inputCls} placeholder={'Форма | Структурные силуэты…\nФункция | Продуманный крой…'} />
            <p className={hintCls}>Лента показывается, только если включён флажок выше. Пусто — пункты по умолчанию.</p>
          </div>
        </div>
      </fieldset>

      {/* Философия (B3) */}
      <fieldset className="mb-6 rounded border border-gray-200 p-4">
        <legend className="px-1 text-sm font-semibold text-gray-800">Блок «Философия»</legend>
        <div className="grid grid-cols-1 gap-4">
          <div>
            <label htmlFor="home-phil-eyebrow" className={labelCls}>Надзаголовок</label>
            <input id="home-phil-eyebrow" value={philEyebrow} onChange={(e) => setPhilEyebrow(e.target.value)}
              placeholder="Философия" className={inputCls} />
          </div>
          <div>
            <label htmlFor="home-phil-title" className={labelCls}>Заголовок</label>
            <input id="home-phil-title" value={philTitle} onChange={(e) => setPhilTitle(e.target.value)}
              placeholder="Например: качество, забота, стиль" className={inputCls} />
          </div>
          <div>
            <label htmlFor="home-phil-text" className={labelCls}>Абзац</label>
            <textarea id="home-phil-text" value={philText} onChange={(e) => setPhilText(e.target.value)}
              rows={3} className={inputCls} />
          </div>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div>
              <label htmlFor="home-phil-link-label" className={labelCls}>Текст ссылки</label>
              <input id="home-phil-link-label" value={philLinkLabel} onChange={(e) => setPhilLinkLabel(e.target.value)}
                placeholder="О бренде" className={inputCls} />
            </div>
            <div>
              <label htmlFor="home-phil-link-href" className={labelCls}>Адрес ссылки</label>
              <input id="home-phil-link-href" value={philLinkHref} onChange={(e) => setPhilLinkHref(e.target.value)}
                placeholder="/#about" className={inputCls} />
            </div>
          </div>
        </div>
      </fieldset>

      {/* Образы (lookbook, ТЗ_2) */}
      <fieldset className="mb-6 rounded border border-gray-200 p-4">
        <legend className="px-1 text-sm font-semibold text-gray-800">Блок «Образы»</legend>
        <div className="grid grid-cols-1 gap-4">
          <label className="flex items-center gap-2 text-sm font-medium text-gray-700">
            <input
              type="checkbox"
              checked={looksEnabled}
              onChange={(e) => setLooksEnabled(e.target.checked)}
              className="h-4 w-4 rounded border-gray-300"
            />
            Показывать «Образы» на главной
          </label>
          <div>
            <label htmlFor="home-looks-title" className={labelCls}>Заголовок блока (необязательно)</label>
            <input id="home-looks-title" value={looksTitle} onChange={(e) => setLooksTitle(e.target.value)}
              placeholder="Образы" className={inputCls} />
          </div>

          <div className="grid grid-cols-1 gap-4">
            {looksCategories.map((cat, i) => (
              <div key={i} className="rounded border border-gray-200 bg-gray-50 p-3">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-xs font-semibold text-gray-600">Категория {i + 1}</span>
                  <button type="button" onClick={() => removeLookCategory(i)}
                    className="rounded border border-gray-300 px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50">
                    Удалить
                  </button>
                </div>
                <div className="grid grid-cols-1 gap-3">
                  <div>
                    <label htmlFor={`home-looks-title-${i}`} className={labelCls}>Заголовок</label>
                    <input id={`home-looks-title-${i}`} value={cat.title}
                      onChange={(e) => setLookCategory(i, 'title', e.target.value)}
                      placeholder="Название образа" className={inputCls} />
                  </div>
                  <div>
                    <label htmlFor={`home-looks-text-${i}`} className={labelCls}>Текст</label>
                    <textarea id={`home-looks-text-${i}`} value={cat.text}
                      onChange={(e) => setLookCategory(i, 'text', e.target.value)}
                      rows={3} className={inputCls} />
                  </div>
                  <div>
                    <label htmlFor={`home-looks-img-${i}`} className={labelCls}>Фото</label>
                    <input id={`home-looks-img-${i}`} value={cat.imageKey}
                      onChange={(e) => setLookCategory(i, 'imageKey', e.target.value)}
                      placeholder="home/looks/1.webp" className={inputCls} />
                    <ImageUploadButton label="Загрузить фото образа" onUploaded={(key) => setLookCategory(i, 'imageKey', key)} />
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div>
            <button type="button" onClick={addLookCategory}
              className="rounded border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50">
              + Добавить категорию
            </button>
            <p className={hintCls}>Каждая категория — фото, заголовок и текст. Неполные категории не сохраняются.</p>
          </div>
        </div>
      </fieldset>

      {/* Плитки категорий (M4) */}
      <fieldset className="mb-6 rounded border border-gray-200 p-4">
        <legend className="px-1 text-sm font-semibold text-gray-800">Блок «Плитки категорий»</legend>
        <div className="grid grid-cols-1 gap-4">
          <label className="flex items-center gap-2 text-sm font-medium text-gray-700">
            <input
              type="checkbox"
              checked={tilesEnabled}
              onChange={(e) => setTilesEnabled(e.target.checked)}
              className="h-4 w-4 rounded border-gray-300"
            />
            Показывать «Плитки категорий» на главной
          </label>

          <div className="grid grid-cols-1 gap-4">
            {tilesItems.map((tile, i) => (
              <div key={i} className="rounded border border-gray-200 bg-gray-50 p-3">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-xs font-semibold text-gray-600">Плитка {i + 1}</span>
                  <button type="button" onClick={() => removeTile(i)}
                    className="rounded border border-gray-300 px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50">
                    Удалить
                  </button>
                </div>
                <div className="grid grid-cols-1 gap-3">
                  <div>
                    <label htmlFor={`home-tiles-title-${i}`} className={labelCls}>Заголовок</label>
                    <input id={`home-tiles-title-${i}`} value={tile.title}
                      onChange={(e) => setTile(i, 'title', e.target.value)}
                      placeholder="Название категории" className={inputCls} />
                  </div>
                  <div>
                    <label htmlFor={`home-tiles-href-${i}`} className={labelCls}>Ссылка</label>
                    <input id={`home-tiles-href-${i}`} value={tile.href}
                      onChange={(e) => setTile(i, 'href', e.target.value)}
                      placeholder="/catalog/scarves" className={inputCls} />
                  </div>
                  <div>
                    <label htmlFor={`home-tiles-img-${i}`} className={labelCls}>Фото</label>
                    <input id={`home-tiles-img-${i}`} value={tile.imageKey}
                      onChange={(e) => setTile(i, 'imageKey', e.target.value)}
                      placeholder="home/tiles/1.webp" className={inputCls} />
                    <ImageUploadButton label="Загрузить фото плитки" onUploaded={(key) => setTile(i, 'imageKey', key)} />
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div>
            <button type="button" onClick={addTile}
              className="rounded border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50">
              + Добавить плитку
            </button>
            <p className={hintCls}>Каждая плитка — фото, заголовок и ссылка. Неполные плитки не сохраняются.</p>
          </div>
        </div>
      </fieldset>

      {/* Видео (M4) */}
      <fieldset className="mb-6 rounded border border-gray-200 p-4">
        <legend className="px-1 text-sm font-semibold text-gray-800">Блок «Видео»</legend>
        <div className="grid grid-cols-1 gap-4">
          <label className="flex items-center gap-2 text-sm font-medium text-gray-700">
            <input
              type="checkbox"
              checked={videoEnabled}
              onChange={(e) => setVideoEnabled(e.target.checked)}
              className="h-4 w-4 rounded border-gray-300"
            />
            Показывать «Видео» на главной
          </label>
          <div>
            <label htmlFor="home-video-embed" className={labelCls}>Ссылка на видео (embed)</label>
            <input id="home-video-embed" type="url" value={videoEmbedUrl}
              onChange={(e) => setVideoEmbedUrl(e.target.value)}
              placeholder="https://player.vimeo.com/video/12345" className={inputCls} />
            <p className={hintCls}>
              Только адрес вида <code>https://…</code> (embed-ссылка Vimeo/YouTube). Пусто — видео не показывается.
            </p>
          </div>
        </div>
      </fieldset>

      {/* Дизайнеры (M4) */}
      <fieldset className="mb-6 rounded border border-gray-200 p-4">
        <legend className="px-1 text-sm font-semibold text-gray-800">Блок «Дизайнеры»</legend>
        <div className="grid grid-cols-1 gap-4">
          <label className="flex items-center gap-2 text-sm font-medium text-gray-700">
            <input
              type="checkbox"
              checked={designersEnabled}
              onChange={(e) => setDesignersEnabled(e.target.checked)}
              className="h-4 w-4 rounded border-gray-300"
            />
            Показывать «Дизайнеры» на главной
          </label>
          <div>
            <label htmlFor="home-designers-title" className={labelCls}>Заголовок блока (необязательно)</label>
            <input id="home-designers-title" value={designersTitle} onChange={(e) => setDesignersTitle(e.target.value)}
              placeholder="Дизайнеры" className={inputCls} />
          </div>

          <div className="grid grid-cols-1 gap-4">
            {designersItems.map((d, i) => (
              <div key={i} className="rounded border border-gray-200 bg-gray-50 p-3">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-xs font-semibold text-gray-600">Дизайнер {i + 1}</span>
                  <button type="button" onClick={() => removeDesigner(i)}
                    className="rounded border border-gray-300 px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50">
                    Удалить
                  </button>
                </div>
                <div className="grid grid-cols-1 gap-3">
                  <div>
                    <label htmlFor={`home-designers-name-${i}`} className={labelCls}>Имя</label>
                    <input id={`home-designers-name-${i}`} value={d.name}
                      onChange={(e) => setDesigner(i, 'name', e.target.value)}
                      placeholder="Имя дизайнера" className={inputCls} />
                  </div>
                  <div>
                    <label htmlFor={`home-designers-href-${i}`} className={labelCls}>Ссылка</label>
                    <input id={`home-designers-href-${i}`} value={d.href}
                      onChange={(e) => setDesigner(i, 'href', e.target.value)}
                      placeholder="/designers/ivanov" className={inputCls} />
                  </div>
                  <div>
                    <label htmlFor={`home-designers-avatar-${i}`} className={labelCls}>Аватар</label>
                    <input id={`home-designers-avatar-${i}`} value={d.avatarImageKey}
                      onChange={(e) => setDesigner(i, 'avatarImageKey', e.target.value)}
                      placeholder="home/designers/1-avatar.webp" className={inputCls} />
                    <ImageUploadButton label="Загрузить аватар" onUploaded={(key) => setDesigner(i, 'avatarImageKey', key)} />
                  </div>
                  <div>
                    <label htmlFor={`home-designers-work-${i}`} className={labelCls}>Фото работы</label>
                    <input id={`home-designers-work-${i}`} value={d.workImageKey}
                      onChange={(e) => setDesigner(i, 'workImageKey', e.target.value)}
                      placeholder="home/designers/1-work.webp" className={inputCls} />
                    <ImageUploadButton label="Загрузить фото работы" onUploaded={(key) => setDesigner(i, 'workImageKey', key)} />
                  </div>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div>
                      <label htmlFor={`home-designers-avatartop-${i}`} className={labelCls}>Позиция аватара (0–100)</label>
                      <input id={`home-designers-avatartop-${i}`} type="number" min={0} max={100} value={d.avatarTop}
                        onChange={(e) => setDesigner(i, 'avatarTop', e.target.value)}
                        placeholder="50" className={inputCls} />
                    </div>
                    <div>
                      <label htmlFor={`home-designers-worktop-${i}`} className={labelCls}>Позиция работы (0–100)</label>
                      <input id={`home-designers-worktop-${i}`} type="number" min={0} max={100} value={d.workTop}
                        onChange={(e) => setDesigner(i, 'workTop', e.target.value)}
                        placeholder="50" className={inputCls} />
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div>
            <button type="button" onClick={addDesigner}
              className="rounded border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50">
              + Добавить дизайнера
            </button>
            <p className={hintCls}>
              Каждая запись — имя, ссылка и два фото (аватар и работа). Позиции фото (0–100) — по вертикали,
              пусто — по центру. Неполные записи не сохраняются.
            </p>
          </div>
        </div>
      </fieldset>

      <div className="flex items-center gap-3 border-t border-gray-200 pt-4">
        <button type="button" onClick={save} disabled={pending}
          className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50">
          {pending ? 'Сохранение…' : 'Сохранить контент главной'}
        </button>
      </div>
    </div>
  );
}
