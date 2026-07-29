'use client';

/**
 * Галерея товара — левая колонка work__slider-col (порт из frontend/views/catalog/
 * view.twig). Оригинал использует slick-карусель (JS-либа не переносится); здесь
 * — главное фото + ряд превью (клик переключает), в тех же классах work__slider*
 * на сером фоне carre. Одна картинка — просто фото без превью.
 */

import { useState } from 'react';
import type { MediaDto } from '@/lib/types';
import { fillTemplate, getDictionary } from '@/lib/dictionaries';
import { DEFAULT_LOCALE, type Locale } from '@/lib/i18n';

export default function ProductGallery({
  media,
  alt,
  locale = DEFAULT_LOCALE,
}: {
  media: MediaDto[];
  alt: string;
  /** Локаль — для подписи превью скринридеру («Фото 2» / «Photo 2»). */
  locale?: Locale;
}) {
  const d = getDictionary(locale);
  const images = media.filter((m) => m.url && m.type === 'image');
  const [active, setActive] = useState(0);

  if (images.length === 0) {
    return <div className="work__slider-col" />;
  }

  const idx = Math.min(active, images.length - 1);
  const main = images[idx];

  return (
    <div className="work__slider-col">
      <div className={`work__slider work__slider-${images.length}`}>
        <div className="work__slider-item">
          {main.url && (
            <img
              src={main.url}
              alt={main.alt || alt}
              className="work__slider-item-image"
            />
          )}
        </div>
      </div>

      {images.length > 1 && (
        <div className="sf-gallery-thumbs">
          {images.map((im, i) => (
            <button
              key={`${im.url}-${i}`}
              type="button"
              className={`sf-gallery-thumb${i === idx ? ' is-active' : ''}`}
              onClick={() => setActive(i)}
              aria-label={fillTemplate(d.product.photoNumber, { n: i + 1 })}
            >
              {im.url && <img src={im.url} alt="" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
