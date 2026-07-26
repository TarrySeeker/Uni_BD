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
    // --- Секции/легенды ---
    contacts: string; // «Контактные данные»
    nameLabel: string; // «Имя и фамилия»
    emailLabel: string; // «E-mail»
    phoneLabel: string; // «Телефон»
    emailInvalid: string; // «Введите корректный e-mail.»
    phonePlaceholder: string; // «+7 900 000-00-00»
    // --- Доставка ---
    delivery: string; // «Доставка»
    deliveryCourierZonal: string; // «Курьер по региону» (нейтральный лейбл зональной доставки)
    deliveryCourierCdek: string; // «Курьер СДЭК»
    deliveryPvz: string; // «Пункт выдачи СДЭК»
    zoneLabel: string; // «Зона доставки»
    cityLabel: string; // «Город»
    cityPlaceholder: string; // «Начните вводить город»
    addressLabel: string; // «Адрес доставки»
    addressPlaceholder: string; // «Улица, дом, квартира»
    pvzLabel: string; // «Пункт выдачи»
    pvzLoading: string; // «Загрузка пунктов выдачи…»
    pvzEmpty: string; // «В этом городе не найдено пунктов выдачи.»
    pvzSelect: string; // «— выберите пункт —»
    // --- Промокод ---
    promo: string; // «Промокод»
    promoApplied: string; // «Применён:»
    promoNotApplied: string; // «не применён»
    promoRemove: string; // «Убрать»
    promoPlaceholder: string; // «Введите промокод»
    promoApply: string; // «Применить»
    // --- Подарочный сертификат (код на чекауте) ---
    giftCode: string; // «Подарочный сертификат» (легенда секции)
    giftCodePlaceholder: string; // «Введите код сертификата»
    giftCodeApply: string; // «Применить»
    giftCodeRemove: string; // «Убрать»
    giftCodeApplied: string; // «Применён:» — ТОЛЬКО когда сертификат реально применён
    /** 🔴 Общий человекочитаемый текст отказа — фолбэк вместо сырого reason. */
    giftCodeNotApplied: string;
    /**
     * 🔴 Подсказка при ОТКАЗЕ кода: поле остаётся доступным, значение сохранено —
     * покупателю нужно сказать, что делать дальше. Без неё отказ выглядел тупиком
     * (а вместе с «Применён:» — ещё и самоотрицающей фразой).
     */
    giftCodeRetry: string;
    giftCodeCovered: string; // шаблон «Списано с сертификата: {amount}»
    giftCodeRemaining: string; // шаблон «Остаток на сертификате: {amount}»
    giftCodeFullyCovered: string; // «Сертификат покрывает весь заказ — оплата не требуется.»
    // --- Итоги ---
    yourOrder: string; // «Ваш заказ»
    summaryItems: string; // «Товары»
    summaryDiscount: string; // «Скидка»
    summaryGift: string; // «Сертификат»
    summaryDelivery: string; // «Доставка»
    deliveryFree: string; // «бесплатно»
    deliveryPending: string; // «уточняется»
    summaryTotal: string; // «Итого»
    // --- Статусы/кнопки ---
    recalculating: string; // «Пересчёт заказа…»
    notFulfillable: string; // «Некоторые товары недоступны в нужном количестве — измените корзину.»
    deliveryUnavailable: string; // «Не удалось рассчитать доставку — измените способ или адрес доставки.»
    unresolvableItems: string; // предупреждение о старых позициях корзины
    submit: string; // «Оплатить»
    /** Кнопка, когда платить нечего (сертификат покрыл заказ полностью). */
    submitGiftCovered: string; // «Оформить заказ»
    submitting: string; // «Переход к оплате…»
    legal: string; // легал-текст под кнопкой (цитирует подпись submit)
    /**
     * 🔴 Легал-текст, когда платить нечего (сертификат покрыл заказ целиком):
     * кнопка в этом случае — submitGiftCovered, и текст под ней ОБЯЗАН цитировать
     * её же и не обещать онлайн-оплату, которой не будет.
     */
    legalGiftCovered: string;
    emptyCart: string; // «Ваша корзина пуста :(»
    // --- Причины проблем позиций (issues[].code) ---
    issueOutOfStock: string;
    issueInvalidItem: string;
    issueNotFound: string;
    issueInactive: string;
    // --- Причины отказа промокода (promo.reason) ---
    promoReasonNotFound: string;
    promoReasonExpired: string;
    promoReasonNotStarted: string;
    promoReasonInactive: string;
    promoReasonUsageLimit: string;
    promoReasonMinOrder: string;
    promoReasonPerCustomerLimit: string;
    // --- Причины отказа сертификата (gift.reason из /cart/quote) ---
    giftReasonNotFound: string;
    giftReasonExpired: string;
    giftReasonDepleted: string;
    giftReasonDisabled: string;
    giftReasonNoAmountDue: string;
    // --- Ошибки создания заказа (code из /orders) ---
    orderErrorOutOfStock: string;
    orderErrorInvalidItem: string;
    orderErrorInvalidPromo: string;
    orderErrorInvalidGift: string;
    orderErrorDeliveryUnavailable: string;
    orderErrorPaymentsDisabled: string;
    orderErrorNetwork: string; // ApiError code 'network' (fetch не дошёл)
    orderErrorRateLimited: string; // ApiError code 'rate_limited' (429 от API)
    /**
     * 🔴 Фолбэк на ЛЮБОЙ неизвестный код ошибки. Сырое `err.message` от сервера
     * покупателю не показывается никогда: оно на языке сервера (русский) и уехало
     * бы франкоязычному покупателю как есть.
     */
    orderErrorGeneric: string; // «Произошла ошибка. Попробуйте ещё раз.»
  };
  success: {
    title: string; // «Заказ оформлен»
    metaTitle: string; // <title> страницы (metadata)
    noOrder: string; // «Не удалось определить заказ.»
    thanks: string; // шаблон «Спасибо! Ваш заказ №{number} принят.» с {number}
    /**
     * Примечание под номером заказа. 🔴 Здесь НЕ должно быть обещания письма:
     * модуля отправки email в платформе нет, поэтому прежняя формулировка про
     * высланное письмо была прямым обманом покупателя (сторожит guard-тест).
     */
    emailNote: string;
    statusOrder: string; // «Статус заказа»
    statusPayment: string; // «Оплата»
    statusTotal: string; // «Сумма»

    // ---- Блок кода подарочного сертификата (ТЗ п.11) ----
    giftTitle: string; // «Ваш подарочный сертификат»
    giftPending: string; // «Оплата подтверждается, код появится здесь автоматически»
    giftRefresh: string; // «Обновить»
    giftTimeout: string; // «подтверждение задерживается… обратитесь к менеджеру»
    giftAmount: string; // «Номинал»
    giftRemaining: string; // «Остаток»
    giftValidUntil: string; // «Действует до»
    giftForever: string; // «бессрочно»
    giftCopy: string; // «Скопировать»
    giftCopied: string; // «Скопировано»
    giftWarning: string; // «сохраните код — он равносилен деньгам»
  };
  notFound: {
    text: string; // «Страница не найдена.»
    /**
     * <title> страниц-заглушек. 🔴 БЕЗ имени магазина: его один раз доклеит
     * title.template корневого layout из настроек админки (см. lib/seo.ts).
     * Зашитый здесь суффикс с именем магазина ломал мультитенантность и удваивался.
     */
    pageMetaTitle: string; // «Страница не найдена» (fallback CMS)
    productMetaTitle: string; // «Товар не найден»
    designerMetaTitle: string; // «Дизайнер не найден»
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
    contacts: 'Контактные данные',
    nameLabel: 'Имя и фамилия',
    emailLabel: 'E-mail',
    phoneLabel: 'Телефон',
    emailInvalid: 'Введите корректный e-mail.',
    phonePlaceholder: '+7 900 000-00-00',
    delivery: 'Доставка',
    deliveryCourierZonal: 'Курьер по региону',
    deliveryCourierCdek: 'Курьер СДЭК',
    deliveryPvz: 'Пункт выдачи СДЭК',
    zoneLabel: 'Зона доставки',
    cityLabel: 'Город',
    cityPlaceholder: 'Начните вводить город',
    addressLabel: 'Адрес доставки',
    addressPlaceholder: 'Улица, дом, квартира',
    pvzLabel: 'Пункт выдачи',
    pvzLoading: 'Загрузка пунктов выдачи…',
    pvzEmpty: 'В этом городе не найдено пунктов выдачи.',
    pvzSelect: '— выберите пункт —',
    promo: 'Промокод',
    promoApplied: 'Применён:',
    promoNotApplied: 'не применён',
    promoRemove: 'Убрать',
    promoPlaceholder: 'Введите промокод',
    promoApply: 'Применить',
    giftCode: 'Подарочный сертификат',
    giftCodePlaceholder: 'Введите код сертификата',
    giftCodeApply: 'Применить',
    giftCodeRemove: 'Убрать',
    giftCodeApplied: 'Применён:',
    giftCodeNotApplied: 'Сертификат не применён.',
    giftCodeRetry: 'Проверьте код и попробуйте снова.',
    giftCodeCovered: 'Списано с сертификата: {amount}',
    giftCodeRemaining: 'Остаток на сертификате: {amount}',
    giftCodeFullyCovered: 'Сертификат покрывает весь заказ — оплата не требуется.',
    yourOrder: 'Ваш заказ',
    summaryItems: 'Товары',
    summaryDiscount: 'Скидка',
    summaryGift: 'Сертификат',
    summaryDelivery: 'Доставка',
    deliveryFree: 'бесплатно',
    deliveryPending: 'уточняется',
    summaryTotal: 'Итого',
    recalculating: 'Пересчёт заказа…',
    notFulfillable: 'Некоторые товары недоступны в нужном количестве — измените корзину.',
    deliveryUnavailable: 'Не удалось рассчитать доставку — измените способ или адрес доставки.',
    unresolvableItems:
      'Некоторые товары добавлены в корзину в старой версии сайта и не могут быть оформлены. Пожалуйста, удалите их из корзины и добавьте заново со страницы товара.',
    submit: 'Оплатить',
    submitGiftCovered: 'Оформить заказ',
    submitting: 'Переход к оплате…',
    legal:
      'Нажимая «Оплатить», вы соглашаетесь с условиями продажи. Оплата производится онлайн через защищённую платёжную страницу.',
    legalGiftCovered:
      'Нажимая «Оформить заказ», вы соглашаетесь с условиями продажи. Оплата не требуется: заказ полностью покрыт подарочным сертификатом.',
    emptyCart: 'Ваша корзина пуста :(',
    issueOutOfStock: 'нет в наличии в нужном количестве',
    issueInvalidItem: 'товар недоступен',
    issueNotFound: 'товар больше не найден в каталоге',
    issueInactive: 'товар снят с продажи',
    promoReasonNotFound: 'Промокод не найден.',
    promoReasonExpired: 'Срок действия промокода истёк.',
    promoReasonNotStarted: 'Промокод ещё не активен.',
    promoReasonInactive: 'Промокод неактивен.',
    promoReasonUsageLimit: 'Лимит использований промокода исчерпан.',
    promoReasonMinOrder: 'Заказ не достигает минимальной суммы для промокода.',
    promoReasonPerCustomerLimit: 'Вы уже использовали этот промокод.',
    giftReasonNotFound: 'Сертификат с таким кодом не найден.',
    giftReasonExpired: 'Срок действия сертификата истёк.',
    giftReasonDepleted: 'На сертификате не осталось средств.',
    giftReasonDisabled: 'Сертификат отключён.',
    giftReasonNoAmountDue: 'Сертификату нечего покрывать в этом заказе.',
    orderErrorOutOfStock:
      'Часть товаров закончилась, пока вы оформляли заказ. Обновите корзину.',
    orderErrorInvalidItem: 'Один из товаров стал недоступен. Уберите его из корзины.',
    orderErrorInvalidPromo: 'Промокод недействителен. Уберите его и попробуйте снова.',
    orderErrorInvalidGift: 'Подарочный сертификат недействителен.',
    orderErrorDeliveryUnavailable:
      'Не удалось рассчитать доставку в выбранное место. Измените способ или адрес доставки.',
    orderErrorPaymentsDisabled:
      'Онлайн-оплата временно недоступна. Свяжитесь с магазином для оформления.',
    orderErrorNetwork:
      'Не удалось связаться с магазином. Проверьте соединение и попробуйте ещё раз.',
    orderErrorRateLimited: 'Слишком много попыток. Подождите немного и попробуйте снова.',
    orderErrorGeneric: 'Произошла ошибка. Попробуйте ещё раз.',
  },
  success: {
    title: 'Заказ оформлен',
    metaTitle: 'Заказ оформлен',
    noOrder: 'Не удалось определить заказ.',
    thanks: 'Спасибо! Ваш заказ №{number} принят.',
    emailNote:
      'Детали заказа доступны на этой странице по вашей ссылке — сохраните её. ' +
      'Если оплата ещё обрабатывается, статус обновится автоматически.',
    statusOrder: 'Статус заказа',
    statusPayment: 'Оплата',
    statusTotal: 'Сумма',
    giftTitle: 'Ваш подарочный сертификат',
    giftPending: 'Оплата подтверждается, код появится здесь автоматически.',
    giftRefresh: 'Обновить',
    giftTimeout:
      'Подтверждение задерживается. Код закреплён за вашим заказом — обратитесь к менеджеру.',
    giftAmount: 'Номинал',
    giftRemaining: 'Остаток',
    giftValidUntil: 'Действует до',
    giftForever: 'бессрочно',
    giftCopy: 'Скопировать',
    giftCopied: 'Скопировано',
    giftWarning: 'Сохраните код — он равносилен деньгам. Не показывайте его посторонним.',
  },
  notFound: {
    text: 'Страница не найдена.',
    pageMetaTitle: 'Страница не найдена',
    productMetaTitle: 'Товар не найден',
    designerMetaTitle: 'Дизайнер не найден',
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
    contacts: 'Contact details',
    nameLabel: 'Full name',
    emailLabel: 'E-mail',
    phoneLabel: 'Phone',
    emailInvalid: 'Please enter a valid e-mail.',
    phonePlaceholder: '+7 900 000-00-00',
    delivery: 'Delivery',
    deliveryCourierZonal: 'Zonal courier',
    deliveryCourierCdek: 'CDEK courier',
    deliveryPvz: 'CDEK pickup point',
    zoneLabel: 'Delivery zone',
    cityLabel: 'City',
    cityPlaceholder: 'Start typing a city',
    addressLabel: 'Delivery address',
    addressPlaceholder: 'Street, building, apartment',
    pvzLabel: 'Pickup point',
    pvzLoading: 'Loading pickup points…',
    pvzEmpty: 'No pickup points found in this city.',
    pvzSelect: '— select a point —',
    promo: 'Promo code',
    promoApplied: 'Applied:',
    promoNotApplied: 'not applied',
    promoRemove: 'Remove',
    promoPlaceholder: 'Enter promo code',
    promoApply: 'Apply',
    giftCode: 'Gift certificate',
    giftCodePlaceholder: 'Enter gift certificate code',
    giftCodeApply: 'Apply',
    giftCodeRemove: 'Remove',
    giftCodeApplied: 'Applied:',
    giftCodeNotApplied: 'The gift certificate has not been applied.',
    giftCodeRetry: 'Check the code and try again.',
    giftCodeCovered: 'Paid with the gift certificate: {amount}',
    giftCodeRemaining: 'Certificate balance left: {amount}',
    giftCodeFullyCovered: 'The gift certificate covers the whole order — no payment required.',
    yourOrder: 'Your order',
    summaryItems: 'Items',
    summaryDiscount: 'Discount',
    summaryGift: 'Gift certificate',
    summaryDelivery: 'Delivery',
    deliveryFree: 'free',
    deliveryPending: 'to be confirmed',
    summaryTotal: 'Total',
    recalculating: 'Recalculating order…',
    notFulfillable: 'Some items are not available in the requested quantity — please update your cart.',
    deliveryUnavailable: 'Could not calculate delivery — change the method or delivery address.',
    unresolvableItems:
      'Some items were added to the cart in an older version of the site and cannot be ordered. Please remove them from the cart and add them again from the product page.',
    submit: 'Pay',
    submitGiftCovered: 'Place order',
    submitting: 'Redirecting to payment…',
    legal:
      'By clicking “Pay”, you agree to the terms of sale. Payment is made online via a secure payment page.',
    legalGiftCovered:
      'By clicking “Place order”, you agree to the terms of sale. No payment is required: the order is fully covered by your gift certificate.',
    emptyCart: 'Your cart is empty :(',
    issueOutOfStock: 'not available in the requested quantity',
    issueInvalidItem: 'item unavailable',
    issueNotFound: 'item is no longer in the catalog',
    issueInactive: 'item has been discontinued',
    promoReasonNotFound: 'Promo code not found.',
    promoReasonExpired: 'The promo code has expired.',
    promoReasonNotStarted: 'The promo code is not active yet.',
    promoReasonInactive: 'The promo code is inactive.',
    promoReasonUsageLimit: 'The promo code usage limit has been reached.',
    promoReasonMinOrder: 'The order does not reach the minimum amount for this promo code.',
    promoReasonPerCustomerLimit: 'You have already used this promo code.',
    giftReasonNotFound: 'No gift certificate found for this code.',
    giftReasonExpired: 'The gift certificate has expired.',
    giftReasonDepleted: 'The gift certificate has no funds left.',
    giftReasonDisabled: 'The gift certificate has been disabled.',
    giftReasonNoAmountDue: 'There is nothing for the gift certificate to cover in this order.',
    orderErrorOutOfStock:
      'Some items ran out while you were placing the order. Please refresh your cart.',
    orderErrorInvalidItem: 'One of the items became unavailable. Please remove it from the cart.',
    orderErrorInvalidPromo: 'The promo code is invalid. Remove it and try again.',
    orderErrorInvalidGift: 'The gift certificate is invalid.',
    orderErrorDeliveryUnavailable:
      'Could not calculate delivery to the selected location. Change the method or delivery address.',
    orderErrorPaymentsDisabled:
      'Online payment is temporarily unavailable. Please contact the store to place your order.',
    orderErrorNetwork:
      'Could not reach the store. Please check your connection and try again.',
    orderErrorRateLimited: 'Too many attempts. Please wait a moment and try again.',
    orderErrorGeneric: 'An error occurred. Please try again.',
  },
  success: {
    title: 'Order placed',
    metaTitle: 'Order placed',
    noOrder: 'Could not identify the order.',
    thanks: 'Thank you! Your order #{number} has been received.',
    emailNote:
      'Your order details are available on this page via your link — keep it. ' +
      'If payment is still processing, the status will update automatically.',
    statusOrder: 'Order status',
    statusPayment: 'Payment',
    statusTotal: 'Amount',
    giftTitle: 'Your gift certificate',
    giftPending: 'Payment is being confirmed, the code will appear here automatically.',
    giftRefresh: 'Refresh',
    giftTimeout:
      'Confirmation is taking longer than usual. The code is reserved for your order — please contact the store.',
    giftAmount: 'Value',
    giftRemaining: 'Balance',
    giftValidUntil: 'Valid until',
    giftForever: 'no expiry',
    giftCopy: 'Copy',
    giftCopied: 'Copied',
    giftWarning: 'Keep this code safe — it is equivalent to money. Do not share it.',
  },
  notFound: {
    text: 'Page not found.',
    pageMetaTitle: 'Page not found',
    productMetaTitle: 'Product not found',
    designerMetaTitle: 'Designer not found',
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
    contacts: 'Coordonnées',
    nameLabel: 'Nom et prénom',
    emailLabel: 'E-mail',
    phoneLabel: 'Téléphone',
    emailInvalid: 'Veuillez saisir un e-mail valide.',
    phonePlaceholder: '+7 900 000-00-00',
    delivery: 'Livraison',
    deliveryCourierZonal: 'Coursier par zone',
    deliveryCourierCdek: 'Coursier CDEK',
    deliveryPvz: 'Point de retrait CDEK',
    zoneLabel: 'Zone de livraison',
    cityLabel: 'Ville',
    cityPlaceholder: 'Commencez à saisir une ville',
    addressLabel: 'Adresse de livraison',
    addressPlaceholder: 'Rue, bâtiment, appartement',
    pvzLabel: 'Point de retrait',
    pvzLoading: 'Chargement des points de retrait…',
    pvzEmpty: 'Aucun point de retrait trouvé dans cette ville.',
    pvzSelect: '— choisissez un point —',
    promo: 'Code promo',
    promoApplied: 'Appliqué :',
    promoNotApplied: 'non appliqué',
    promoRemove: 'Retirer',
    promoPlaceholder: 'Saisissez un code promo',
    promoApply: 'Appliquer',
    giftCode: 'Carte cadeau',
    giftCodePlaceholder: 'Saisissez le code de la carte cadeau',
    giftCodeApply: 'Appliquer',
    giftCodeRemove: 'Retirer',
    giftCodeApplied: 'Appliquée :',
    giftCodeNotApplied: 'La carte cadeau n’a pas été appliquée.',
    giftCodeRetry: 'Vérifiez le code et réessayez.',
    giftCodeCovered: 'Déduit de la carte cadeau : {amount}',
    giftCodeRemaining: 'Solde restant sur la carte cadeau : {amount}',
    giftCodeFullyCovered:
      'La carte cadeau couvre la totalité de la commande — aucun paiement n’est nécessaire.',
    yourOrder: 'Votre commande',
    summaryItems: 'Articles',
    summaryDiscount: 'Remise',
    summaryGift: 'Carte cadeau',
    summaryDelivery: 'Livraison',
    deliveryFree: 'gratuite',
    deliveryPending: 'à confirmer',
    summaryTotal: 'Total',
    recalculating: 'Recalcul de la commande…',
    notFulfillable: 'Certains articles ne sont pas disponibles dans la quantité demandée — modifiez votre panier.',
    deliveryUnavailable: 'Impossible de calculer la livraison — changez le mode ou l’adresse de livraison.',
    unresolvableItems:
      'Certains articles ont été ajoutés au panier dans une ancienne version du site et ne peuvent pas être commandés. Veuillez les retirer du panier et les ajouter à nouveau depuis la page produit.',
    submit: 'Payer',
    submitGiftCovered: 'Valider la commande',
    submitting: 'Redirection vers le paiement…',
    legal:
      'En cliquant sur « Payer », vous acceptez les conditions de vente. Le paiement s’effectue en ligne via une page de paiement sécurisée.',
    legalGiftCovered:
      'En cliquant sur « Valider la commande », vous acceptez les conditions de vente. Aucun paiement n’est requis : la commande est intégralement couverte par votre carte cadeau.',
    emptyCart: 'Votre panier est vide :(',
    issueOutOfStock: 'indisponible dans la quantité demandée',
    issueInvalidItem: 'article indisponible',
    issueNotFound: 'article introuvable dans le catalogue',
    issueInactive: 'article retiré de la vente',
    promoReasonNotFound: 'Code promo introuvable.',
    promoReasonExpired: 'Le code promo a expiré.',
    promoReasonNotStarted: 'Le code promo n’est pas encore actif.',
    promoReasonInactive: 'Le code promo est inactif.',
    promoReasonUsageLimit: 'La limite d’utilisation du code promo est atteinte.',
    promoReasonMinOrder: 'La commande n’atteint pas le montant minimum pour ce code promo.',
    promoReasonPerCustomerLimit: 'Vous avez déjà utilisé ce code promo.',
    giftReasonNotFound: 'Carte cadeau introuvable.',
    giftReasonExpired: 'La carte cadeau a expiré.',
    giftReasonDepleted: 'La carte cadeau n’a plus de solde.',
    giftReasonDisabled: 'La carte cadeau a été désactivée.',
    giftReasonNoAmountDue: 'Il n’y a rien à couvrir par la carte cadeau dans cette commande.',
    orderErrorOutOfStock:
      'Certains articles se sont épuisés pendant votre commande. Veuillez actualiser votre panier.',
    orderErrorInvalidItem: 'Un des articles est devenu indisponible. Retirez-le du panier.',
    orderErrorInvalidPromo: 'Le code promo n’est pas valide. Retirez-le et réessayez.',
    orderErrorInvalidGift: 'La carte cadeau n’est pas valide.',
    orderErrorDeliveryUnavailable:
      'Impossible de calculer la livraison vers le lieu choisi. Changez le mode ou l’adresse de livraison.',
    orderErrorPaymentsDisabled:
      'Le paiement en ligne est temporairement indisponible. Contactez la boutique pour passer commande.',
    orderErrorNetwork:
      'Impossible de joindre la boutique. Vérifiez votre connexion et réessayez.',
    orderErrorRateLimited: 'Trop de tentatives. Patientez un instant puis réessayez.',
    orderErrorGeneric: 'Une erreur est survenue. Veuillez réessayer.',
  },
  success: {
    title: 'Commande passée',
    metaTitle: 'Commande passée',
    noOrder: 'Impossible d’identifier la commande.',
    thanks: 'Merci ! Votre commande n°{number} a bien été reçue.',
    emailNote:
      'Les détails de votre commande sont disponibles sur cette page via votre lien — conservez-le. ' +
      'Si le paiement est encore en cours, le statut se mettra à jour automatiquement.',
    statusOrder: 'Statut de la commande',
    statusPayment: 'Paiement',
    statusTotal: 'Montant',
    giftTitle: 'Votre carte cadeau',
    giftPending: 'Le paiement est en cours de confirmation, le code apparaîtra ici automatiquement.',
    giftRefresh: 'Actualiser',
    giftTimeout:
      'La confirmation prend plus de temps que prévu. Le code est réservé à votre commande — contactez la boutique.',
    giftAmount: 'Valeur',
    giftRemaining: 'Solde',
    giftValidUntil: 'Valable jusqu’au',
    giftForever: 'sans expiration',
    giftCopy: 'Copier',
    giftCopied: 'Copié',
    giftWarning: 'Conservez ce code — il équivaut à de l’argent. Ne le partagez pas.',
  },
  notFound: {
    text: 'Page introuvable.',
    pageMetaTitle: 'Page introuvable',
    productMetaTitle: 'Produit introuvable',
    designerMetaTitle: 'Créateur introuvable',
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
