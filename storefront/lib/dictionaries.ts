/**
 * Словарь UI-строк витрины carre (шапка/подвал/кнопки/статусы). Локализованный
 * КОНТЕНТ (товары/категории/CMS/SEO) приходит уже переведённым из Storefront API
 * (jsonb-оверлеи ru+en/fr) — здесь ТОЛЬКО строки, захардкоженные в компонентах
 * витрины и не приходящие из API.
 *
 * Ключи сгруппированы по областям (common/header/footer/cart/checkout/product/…).
 * ru — эталон (полный). en/fr переведены; недостающие значения фолбэчат на ru
 * через getDictionary (объединение с ru-эталоном).
 *
 * ⚠️ ПЕРЕВОД en/fr сделан по смыслу для КАРКАСА. Часть длинных юридических/
 * маркетинговых фраз (чекаут, предупреждения) стоит выверить с носителем языка —
 * отмечено в отчёте. Каталог/CMS/SEO это НЕ затрагивает (они из БД).
 */

import type { Locale } from './i18n';
import { DEFAULT_LOCALE, LOCALES } from './i18n';

export interface Dictionary {
  common: {
    home: string;
    catalog: string;
    all: string;
    goToCatalog: string; // «Перейти в каталог →»
    continueShopping: string; // «Продолжить покупки →»
    showMore: string; // «Показать еще»
    nothingFound: string; // «Ничего не найдено»
    seeAll: string; // «Смотреть всё»
    aboutUs: string;
    contacts: string;
    loading: string;
  };
  header: {
    searchPlaceholder: string; // «Что вы ищете?»
    aboutUs: string;
    corporate: string; // «Корпоративным клиентам»
    certificates: string; // «Подарочные сертификаты»
    favorites: string;
    cart: string;
    contacts: string;
    forCustomers: string; // «Для покупателей»
    phoneWhatsapp: string; // «Тел. / Whatsapp»
    langAria: string; // aria-шаблон с плейсхолдером {code}, напр. «Язык сайта: {code}»
    currencyAria: string; // aria-шаблон с плейсхолдером {code}
  };
  footer: {
    catalog: string;
    information: string;
    services: string;
    aboutUs: string;
    contacts: string;
    corporate: string;
    certificates: string;
    delivery: string; // «Способы оплаты и Доставки»
    returns: string; // «Политика возвратов»
    offer: string; // «Оферта»
    userContract: string; // «Пользовательское соглашение»
  };
  home: {
    newProducts: string; // «Новинки»
    ourStory: string; // «Наша история»
  };
  catalog: {
    title: string; // «Каталог»
    categories: string; // «Категории»
    clear: string; // «Очистить»
    sortBy: string; // «Сортировка по:»
    priceAsc: string; // «возрастанию цены»
    priceDesc: string; // «убыванию цены»
  };
  search: {
    title: string; // «Поиск»
    resultsFor: string; // шаблон с плейсхолдером {q}, напр. «Поиск: «{q}»»
    prompt: string; // приглашение ввести запрос
  };
  favorite: {
    title: string; // «Избранное»
    empty: string; // «В избранном пока пусто.»
  };
  product: {
    inStock: string; // «В наличии»
    preorder: string; // «Доступно по предзаказу»
    description: string; // «Описание»
    addToCart: string; // «В корзину» (см. AddToCart)
    outOfStock: string; // «Нет в наличии» (кнопка disabled)
    alreadyInCart: string; // «Уже в корзине»
    seeAlso: string; // «Смотрите также»
    works: string; // «Работы» (страница дизайнера)
    aboutDesigner: string; // «О дизайнере»
    worksCount: string; // шаблон с плейсхолдером {n}, напр. «Работ: {n}»
    designerNoWorks: string; // «У этого дизайнера пока нет опубликованных работ.»
  };
  cart: {
    title: string; // «Корзина»
    empty: string; // «Ваша корзина пуста :(»
    colProduct: string;
    colPrice: string;
    colQty: string;
    colTotal: string; // «Итого»
    checkout: string; // «Оформить заказ →»
    grandTotal: string; // «Итого к оплате»
    remove: string; // aria «Удалить»
  };
  checkout: {
    title: string; // «Оформление заказа»
  };
  success: {
    title: string; // «Заказ оформлен»
  };
}

const ru: Dictionary = {
  common: {
    home: 'Главная',
    catalog: 'Каталог',
    all: 'Все',
    goToCatalog: 'Перейти в каталог →',
    continueShopping: 'Продолжить покупки →',
    showMore: 'Показать еще',
    nothingFound: 'Ничего не найдено',
    seeAll: 'Смотреть всё',
    aboutUs: 'О нас',
    contacts: 'Контакты',
    loading: 'Загрузка…',
  },
  header: {
    searchPlaceholder: 'Что вы ищете?',
    aboutUs: 'О нас',
    corporate: 'Корпоративным клиентам',
    certificates: 'Подарочные сертификаты',
    favorites: 'Избранное',
    cart: 'Корзина',
    contacts: 'Контакты',
    forCustomers: 'Для покупателей',
    phoneWhatsapp: 'Тел. / Whatsapp',
    langAria: 'Язык сайта: {code}',
    currencyAria: 'Показывать цены в {code}',
  },
  footer: {
    catalog: 'Каталог',
    information: 'Информация',
    services: 'Услуги',
    aboutUs: 'О нас',
    contacts: 'Контакты',
    corporate: 'Корпоративным клиентам',
    certificates: 'Подарочные сертификаты',
    delivery: 'Способы оплаты и Доставки',
    returns: 'Политика возвратов',
    offer: 'Оферта',
    userContract: 'Пользовательское соглашение',
  },
  home: {
    newProducts: 'Новинки',
    ourStory: 'Наша история',
  },
  catalog: {
    title: 'Каталог',
    categories: 'Категории',
    clear: 'Очистить',
    sortBy: 'Сортировка по:',
    priceAsc: 'возрастанию цены',
    priceDesc: 'убыванию цены',
  },
  search: {
    title: 'Поиск',
    resultsFor: 'Поиск: «{q}»',
    prompt: 'Введите запрос в поле поиска, чтобы найти товары.',
  },
  favorite: {
    title: 'Избранное',
    empty: 'В избранном пока пусто.',
  },
  product: {
    inStock: 'В наличии',
    preorder: 'Доступно по предзаказу',
    description: 'Описание',
    addToCart: 'В корзину',
    outOfStock: 'Нет в наличии',
    alreadyInCart: 'Уже в корзине',
    seeAlso: 'Смотрите также',
    works: 'Работы',
    aboutDesigner: 'О дизайнере',
    worksCount: 'Работ: {n}',
    designerNoWorks: 'У этого дизайнера пока нет опубликованных работ.',
  },
  cart: {
    title: 'Корзина',
    empty: 'Ваша корзина пуста :(',
    colProduct: 'Товар',
    colPrice: 'Стоимость',
    colQty: 'Количество',
    colTotal: 'Итого',
    checkout: 'Оформить заказ →',
    grandTotal: 'Итого к оплате',
    remove: 'Удалить',
  },
  checkout: {
    title: 'Оформление заказа',
  },
  success: {
    title: 'Заказ оформлен',
  },
};

const en: Dictionary = {
  common: {
    home: 'Home',
    catalog: 'Catalog',
    all: 'All',
    goToCatalog: 'Go to catalog →',
    continueShopping: 'Continue shopping →',
    showMore: 'Show more',
    nothingFound: 'Nothing found',
    seeAll: 'See all',
    aboutUs: 'About us',
    contacts: 'Contacts',
    loading: 'Loading…',
  },
  header: {
    searchPlaceholder: 'What are you looking for?',
    aboutUs: 'About us',
    corporate: 'For corporate clients',
    certificates: 'Gift certificates',
    favorites: 'Wishlist',
    cart: 'Cart',
    contacts: 'Contacts',
    forCustomers: 'For customers',
    phoneWhatsapp: 'Phone / WhatsApp',
    langAria: 'Site language: {code}',
    currencyAria: 'Show prices in {code}',
  },
  footer: {
    catalog: 'Catalog',
    information: 'Information',
    services: 'Services',
    aboutUs: 'About us',
    contacts: 'Contacts',
    corporate: 'For corporate clients',
    certificates: 'Gift certificates',
    delivery: 'Payment & Delivery',
    returns: 'Returns policy',
    offer: 'Terms of sale',
    userContract: 'User agreement',
  },
  home: {
    newProducts: 'New arrivals',
    ourStory: 'Our story',
  },
  catalog: {
    title: 'Catalog',
    categories: 'Categories',
    clear: 'Clear',
    sortBy: 'Sort by:',
    priceAsc: 'price ascending',
    priceDesc: 'price descending',
  },
  search: {
    title: 'Search',
    resultsFor: 'Search: “{q}”',
    prompt: 'Type a query in the search field to find products.',
  },
  favorite: {
    title: 'Wishlist',
    empty: 'Your wishlist is empty.',
  },
  product: {
    inStock: 'In stock',
    preorder: 'Available on pre-order',
    description: 'Description',
    addToCart: 'Add to cart',
    outOfStock: 'Out of stock',
    alreadyInCart: 'Already in cart',
    seeAlso: 'See also',
    works: 'Works',
    aboutDesigner: 'About the designer',
    worksCount: 'Works: {n}',
    designerNoWorks: 'This designer has no published works yet.',
  },
  cart: {
    title: 'Cart',
    empty: 'Your cart is empty :(',
    colProduct: 'Product',
    colPrice: 'Price',
    colQty: 'Quantity',
    colTotal: 'Total',
    checkout: 'Checkout →',
    grandTotal: 'Total to pay',
    remove: 'Remove',
  },
  checkout: {
    title: 'Checkout',
  },
  success: {
    title: 'Order placed',
  },
};

const fr: Dictionary = {
  common: {
    home: 'Accueil',
    catalog: 'Catalogue',
    all: 'Tous',
    goToCatalog: 'Aller au catalogue →',
    continueShopping: 'Continuer les achats →',
    showMore: 'Voir plus',
    nothingFound: 'Aucun résultat',
    seeAll: 'Tout voir',
    aboutUs: 'À propos',
    contacts: 'Contacts',
    loading: 'Chargement…',
  },
  header: {
    searchPlaceholder: 'Que recherchez-vous ?',
    aboutUs: 'À propos',
    corporate: 'Clients professionnels',
    certificates: 'Cartes cadeaux',
    favorites: 'Favoris',
    cart: 'Panier',
    contacts: 'Contacts',
    forCustomers: 'Pour les clients',
    phoneWhatsapp: 'Tél. / WhatsApp',
    langAria: 'Langue du site : {code}',
    currencyAria: 'Afficher les prix en {code}',
  },
  footer: {
    catalog: 'Catalogue',
    information: 'Informations',
    services: 'Services',
    aboutUs: 'À propos',
    contacts: 'Contacts',
    corporate: 'Clients professionnels',
    certificates: 'Cartes cadeaux',
    delivery: 'Paiement et livraison',
    returns: 'Politique de retour',
    offer: 'Conditions de vente',
    userContract: 'Conditions d’utilisation',
  },
  home: {
    newProducts: 'Nouveautés',
    ourStory: 'Notre histoire',
  },
  catalog: {
    title: 'Catalogue',
    categories: 'Catégories',
    clear: 'Effacer',
    sortBy: 'Trier par :',
    priceAsc: 'prix croissant',
    priceDesc: 'prix décroissant',
  },
  search: {
    title: 'Recherche',
    resultsFor: 'Recherche : « {q} »',
    prompt: 'Saisissez une requête dans le champ de recherche pour trouver des produits.',
  },
  favorite: {
    title: 'Favoris',
    empty: 'Votre liste de favoris est vide.',
  },
  product: {
    inStock: 'En stock',
    preorder: 'Disponible en précommande',
    description: 'Description',
    addToCart: 'Ajouter au panier',
    outOfStock: 'Rupture de stock',
    alreadyInCart: 'Déjà dans le panier',
    seeAlso: 'Voir aussi',
    works: 'Œuvres',
    aboutDesigner: 'À propos du créateur',
    worksCount: 'Œuvres : {n}',
    designerNoWorks: 'Ce créateur n’a pas encore d’œuvres publiées.',
  },
  cart: {
    title: 'Panier',
    empty: 'Votre panier est vide :(',
    colProduct: 'Produit',
    colPrice: 'Prix',
    colQty: 'Quantité',
    colTotal: 'Total',
    checkout: 'Commander →',
    grandTotal: 'Total à payer',
    remove: 'Supprimer',
  },
  checkout: {
    title: 'Commande',
  },
  success: {
    title: 'Commande passée',
  },
};

const DICTS: Record<Locale, Dictionary> = { ru, en, fr };

/**
 * Словарь для локали. ru — эталон; неизвестная локаль → ru. (en/fr здесь полные,
 * но выбор через DICTS[locale] ?? ru страхует от рассинхрона типов/данных.)
 */
export function getDictionary(locale: Locale): Dictionary {
  return DICTS[locale] ?? DICTS[DEFAULT_LOCALE];
}

/**
 * Подстановка значений в строку-шаблон словаря (`{code}`, `{q}`, `{n}`, …). Словарь
 * НЕ содержит функций (иначе Next не сериализует его через границу server→client) —
 * динамические подписи хранятся как шаблоны, а собираются здесь.
 *   fillTemplate('Работ: {n}', { n: 5 }) → 'Работ: 5'
 */
export function fillTemplate(
  template: string,
  vars: Record<string, string | number>,
): string {
  return template.replace(/\{(\w+)\}/g, (m, key) =>
    key in vars ? String(vars[key]) : m,
  );
}

/** Все локали, у которых есть словарь (для проверок/тестов). */
export const DICTIONARY_LOCALES = LOCALES;
