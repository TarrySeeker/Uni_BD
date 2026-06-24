// =============================================================================
// Admik — самопроверка нативного sharp/libvips в РАНТАЙМ-образе (регресс-гард)
// =============================================================================
// Запускается ВНУТРИ контейнера app:  node /app/scripts/sharp-selfcheck.mjs
// (вызывается из CI docker-smoke и scripts/deploy.sh после старта стека).
//
// Зачем: standalone-трассировка Next.js (nft) приносит нативный .node sharp, но
// НЕ всегда тянет dlopen-загружаемый libvips (@img/sharp-libvips-*). Тогда
// обработка изображений падает в рантайме (ERR_DLOPEN_FAILED), из-за чего весь
// модуль lib/storage/image — а с ним экшены каталога (createBrand/createProduct,
// загрузка изображений) и storefront-роуты brands/products/pages — отдают 500.
// Юнит-тесты это НЕ ловят: они идут в CI-хосте (glibc), а баг — в musl-образе.
//
// Используем ИМЕННО ESM import('sharp') — так Turbopack грузит external-пакет в
// рантайме (CommonJS require и NODE_PATH ведут себя иначе и маскируют проблему).
// Выход 0 — sharp+libvips живы; ≠0 — образ собран неверно (libvips на пути
// загрузчика, напр. LD_LIBRARY_PATH/@img). См. Dockerfile (стадия `sharp`).
// =============================================================================

try {
  const sharp = (await import('sharp')).default;
  const buf = await sharp({
    create: { width: 8, height: 8, channels: 3, background: { r: 1, g: 2, b: 3 } },
  })
    .webp()
    .toBuffer();

  if (!buf || buf.length === 0) {
    console.error('sharp-selfcheck: пустой результат генерации webp');
    process.exit(1);
  }
  console.log(
    `sharp-selfcheck OK — libvips ${sharp.versions.vips}, sharp ${sharp.versions.sharp}, webp ${buf.length} bytes`,
  );
  process.exit(0);
} catch (err) {
  console.error('sharp-selfcheck FAILED — sharp/libvips не загрузился в образе:');
  console.error(err && err.stack ? err.stack : String(err));
  console.error(
    'Подсказка: проверь Dockerfile (стадия `sharp` + LD_LIBRARY_PATH на lib/ ' +
      '@img/sharp-libvips-*). libvips не дотрассирован в standalone.',
  );
  process.exit(1);
}
