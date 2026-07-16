'use client';

/**
 * Помечает <body> классом page--catalog на время жизни каталожной страницы
 * (в оригинале carre страница поиска имеет body.page--catalog). Корневой layout
 * держит статичный page--main, поэтому переключаем класс клиентски — тем же
 * приёмом, что /favorite. Сама страница поиска остаётся серверным компонентом.
 */

import { useEffect } from 'react';

export default function CatalogBodyClass() {
  useEffect(() => {
    document.body.classList.add('page--catalog');
    return () => document.body.classList.remove('page--catalog');
  }, []);
  return null;
}
