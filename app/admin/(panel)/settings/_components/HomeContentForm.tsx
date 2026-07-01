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

  function s(v: string): string | undefined {
    const t = v.trim();
    return t.length > 0 ? t : undefined;
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

      <div className="flex items-center gap-3 border-t border-gray-200 pt-4">
        <button type="button" onClick={save} disabled={pending}
          className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50">
          {pending ? 'Сохранение…' : 'Сохранить контент главной'}
        </button>
      </div>
    </div>
  );
}
