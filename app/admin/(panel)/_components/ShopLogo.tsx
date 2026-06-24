'use client';

import { useState } from 'react';

/**
 * Логотип магазина в шапке админки с graceful-fallback.
 *
 * Логотип — произвольный внешний URL из настроек (.env/shop_settings), который
 * может быть НЕ задан, оставлен плейсхолдером или битым. Раньше Topbar безусловно
 * рендерил <img src={...}> → при недоступном URL (например плейсхолдер
 * `https://example.com/logo.svg`) в шапке висела иконка «битой картинки».
 *
 * Здесь при ошибке загрузки изображение скрывается (onError) — остаётся текстовое
 * название магазина из Topbar. Переиспользуемо для любого арендатора.
 */
export function ShopLogo({ src, shopName }: { src: string; shopName: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- произвольный внешний URL логотипа (.env), не через next/image
    <img
      src={src}
      alt={`Логотип: ${shopName}`}
      className="h-8 w-auto"
      onError={() => setFailed(true)}
    />
  );
}
