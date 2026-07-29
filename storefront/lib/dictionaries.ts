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
    forDesigners: string; // «Для дизайнеров» — вторая приёмная почта в низу меню
    phoneWhatsapp: string; // «Тел. / Whatsapp»
    menuAria: string; // aria-label выезжающего меню («Меню сайта»)
    openMenu: string; // aria-label бургера («Открыть меню»)
    closeMenu: string; // aria-label крестика («Закрыть меню»)
    // aria-шаблон кнопки раскрытия раздела: «Раскрыть раздел {name}» ({name} = имя категории)
    expandSectionAria: string;
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
    // --- Форма подписки в подвале (эталон .footer-top__subscriptions) ---
    // Дефолты локали: применяются, когда владелец не заполнил navigation.footerMeta.
    subscribeTitle: string; // заголовок над полем ввода
    subscribePlaceholder: string; // «Ваша почта»
    subscribeSubmit: string; // «Отправить»
    subscribeNote: string; // приписка о согласии на обработку перс. данных
    subscribeSuccess: string; // «Спасибо за подписку!» (.fp-success__title)
    subscribeError: string; // не удалось сохранить — попробуйте позже
    subscribeInvalid: string; // введённый адрес не похож на почту
    subscribeAria: string; // aria-label поля ввода (плейсхолдера мало для скринридера)
  };
  home: {
    newProducts: string; // «Новинки»
    ourStory: string; // «Наша история»
    looksNext: string; // aria-label кнопки листания карусели «Образы»
    looksTabsAria: string; // aria-label списка вкладок-категорий «Образы»
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
    /** aria-label сердечка, когда товар ещё не в избранном. */
    add: string;
    /** aria-label сердечка, когда товар уже в избранном. */
    remove: string;
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
    /** aria-label превью в галерее; шаблон с плейсхолдером {n} — номер фото. */
    photoNumber: string;
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
    /** №19: подсказка «город не найден» — сервис ОТВЕТИЛ, совпадений нет. */
    cityLookupEmpty: string;
    /** №19: справочник городов недоступен (сеть/сервис) — это НЕ «города нет». */
    cityLookupFailed: string;
    addressLabel: string; // «Адрес доставки»
    addressPlaceholder: string; // «Улица, дом, квартира»
    pvzLabel: string; // «Пункт выдачи»
    pvzLoading: string; // «Загрузка пунктов выдачи…»
    pvzEmpty: string; // «В этом городе не найдено пунктов выдачи.»
    /** №19: список ПВЗ не загрузился — про «нет пунктов» говорить нельзя. */
    pvzLookupFailed: string;
    pvzSelect: string; // «— выберите пункт —»
    /**
     * №5: МЕТКА ТИПА пункта в списке. ПВЗ и постаматы приходят одним списком, и без
     * метки покупатель не знает, что выбирает: в постамат (автоматическая ячейка)
     * не выдают крупногабарит и там нет примерки.
     */
    pvzTypeOffice: string; // «Пункт выдачи»
    pvzTypePostamat: string; // «Постамат»
    /** №5: предупреждение об ограничениях постамата (показывается при его выборе). */
    pvzPostamatHint: string;
    /** №20: у магазина не настроен ни один способ доставки. */
    deliveryNoMethods: string;
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
    /**
     * 🔴 ГЛАВНЫЙ РИСК МУЛЬТИВАЛЮТНОСТИ (ЭТАП 1). Покупатель ходит по каталогу с
     * переключателем ₽/€ и видит цены в евро, а эквайринг у магазина РУБЛЁВЫЙ:
     * списывается grand_total в БАЗОВОЙ валюте. Чекаут обязан сказать это прямо,
     * иначе человек, пришедший из евро-режима, видит «внезапно другие» суммы и
     * уходит платить, не понимая, сколько именно с него возьмут.
     *
     * Шаблон с ДВУМЯ суммами: {charged} — то, что реально спишут (в базовой
     * валюте), {approx} — справочный эквивалент в валюте показа. Показывается
     * ТОЛЬКО когда выбрана не базовая валюта; рублёвому покупателю (и магазину
     * без доп.валют) не показывается вовсе.
     */
    paymentCurrencyNotice: string;
    /**
     * Хвост дисклеймера про КУРС: «по курсу 88,7602 ₽/€, справочно». Отдельным
     * ключом, потому что курс осмыслен не всегда (валюта показа с испорченным
     * курсом → основной текст остаётся правдивым и без этой фразы).
     *
     * ДАТЫ КУРСА ЗДЕСЬ НЕТ: публичный DTO настроек метку `rateUpdatedAt` наружу
     * не отдаёт (внутренняя диагностика, guard tests/storefront/settings-dto),
     * а подписывать курс временем рендера — врать. Точная дата действовавшего
     * курса фиксируется сервером в снимке заказа (миграция 0059).
     */
    paymentCurrencyRate: string;
    // --- Статусы/кнопки ---
    recalculating: string; // «Пересчёт заказа…»
    notFulfillable: string; // «Некоторые товары недоступны в нужном количестве — измените корзину.»
    deliveryUnavailable: string; // «Не удалось рассчитать доставку — измените способ или адрес доставки.»
    /**
     * Аудит major №3: причина НЕАКТИВНОЙ кнопки оплаты, когда для выбранного
     * способа доставки службой (курьер/ПВЗ) не указан город. Без города доставку
     * нельзя ни посчитать, ни отгрузить, поэтому оформление блокируется — и
     * покупатель должен видеть, ЧТО именно доввести, а не молчащую кнопку.
     */
    deliveryNeedsCity: string;
    unresolvableItems: string; // предупреждение о старых позициях корзины
    /**
     * №1: ПЕРЕЧЕНЬ неоформляемых позиций ({items}). Общее предупреждение выше не
     * называет ни одной, и покупателю оставалось гадать, что именно удалять.
     */
    unresolvableItemsList: string;
    /**
     * №2: цена товара в каталоге изменилась после добавления в корзину. Суммы строк
     * показываются СЕРВЕРНЫЕ (по ним и будет заказ), и расхождение с тем, что
     * покупатель запомнил в корзине, обязано быть объяснено, а не выглядеть ошибкой.
     */
    priceChangedNotice: string;
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
    issueNotFound: string; // домен: product_not_found
    /** Домен: variant_not_found — товар есть, а выбранного варианта уже нет. */
    issueVariantNotFound: string;
    issueInactive: string;
    // --- Причины отказа промокода (promo.reason) ---
    promoReasonNotFound: string;
    promoReasonExpired: string;
    promoReasonNotStarted: string;
    promoReasonInactive: string;
    promoReasonUsageLimit: string; // домен: usage_limit_reached
    promoReasonMinOrder: string; // домен: below_min_total
    promoReasonPerCustomerLimit: string; // домен: per_customer_limit_reached
    /** Домен: below_min_qty — не хватает ЕДИНИЦ товара (а не суммы). */
    promoReasonBelowMinQty: string;
    /** Домен: invalid_kind — тип скидки не применим к этой корзине. */
    promoReasonInvalidKind: string;
    /**
     * Домен: not_applicable — СКЛЕЕННАЯ причина отказа промокода. Сервер намеренно
     * не раскрывает, существует код или нет (оракул перебора закрыт), поэтому
     * текст говорит о РЕЗУЛЬТАТЕ («не подошёл»), а не о состоянии кода.
     */
    promoReasonNotApplicable: string;
    // --- Причины отказа сертификата (gift.reason из /cart/quote) ---
    giftReasonNotFound: string;
    giftReasonExpired: string;
    giftReasonDepleted: string;
    giftReasonDisabled: string;
    giftReasonNoAmountDue: string;
    /** Домен: not_applicable — склеенная причина отказа сертификата (оракул закрыт). */
    giftReasonNotApplicable: string;
    // --- Ошибки создания заказа (code из /orders) ---
    orderErrorOutOfStock: string;
    orderErrorInvalidItem: string;
    orderErrorInvalidPromo: string;
    orderErrorInvalidGift: string;
    orderErrorDeliveryUnavailable: string;
    /** Домен: invalid_zone — прислана зона доставки, которой нет в настройках. */
    orderErrorInvalidZone: string;
    /** Домен: invalid_pvz — выбранного пункта выдачи нет в справочнике службы. */
    orderErrorInvalidPvz: string;
    orderErrorPaymentsDisabled: string;
    /** Домен: order_not_found — заказ не найден либо ссылка/токен не подошли. */
    orderErrorOrderNotFound: string;
    /** Домен: order_not_payable — заказ уже оплачен или возвращён. */
    orderErrorOrderNotPayable: string;
    /** Домен: payment_init_failed — шлюз не принял инициацию оплаты. */
    orderErrorPaymentInitFailed: string;
    /**
     * Домен: payment_in_progress — по заказу УЖЕ идёт оплата, деньги удержаны
     * банком (холд). Не «нельзя оплатить», а «повторять не нужно, деньги целы».
     */
    orderErrorPaymentInProgress: string;
    /**
     * Домен: total_mismatch — СЕРВЕР отказал, потому что показанный покупателю итог
     * разошёлся с фактическим (аудит: находки №2/№9).
     */
    orderErrorTotalMismatch: string;
    /**
     * 🔴 КЛИЕНТСКАЯ сверка (вторая линия обороны, на случай старого сервера без
     * total_mismatch): заказ создан, но его итог не равен показанному. Шаблон с
     * ДВУМЯ плейсхолдерами — покупатель обязан увидеть ОБЕ суммы: {expected} —
     * что было на экране, {actual} — что вышло по факту.
     */
    orderTotalChanged: string;
    /** Что делать дальше при расхождении суммы (на оплату НЕ уводим автоматически). */
    orderTotalChangedAction: string;
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

    /**
     * ---- Исход оплаты (аудит 2026-07-26, находка №1: тупик отменённой оплаты)
     *
     * Заголовок и текст выбираются ПО ИСХОДУ (storefront/lib/payment-result.ts):
     * оплачено / подтверждается / ожидает / отменено / не прошло / заказ закрыт.
     * Раньше все шесть случаев выглядели как «Спасибо! Ваш заказ принят».
     * Тексты — шаблоны с {number}, без единого технического кода.
     */
    titleAwaiting: string; // «Заказ ожидает оплаты»
    titleCancelled: string; // «Оплата не завершена»
    titleFailed: string; // «Оплата не прошла»
    titleClosed: string; // «Заказ закрыт»
    textPaid: string; // «Спасибо! Заказ №{number} оплачен.»
    textSettling: string; // «Оплата подтверждается…»
    textAwaiting: string; // «Заказ №{number} принят, оплата пока не получена.»
    textCancelled: string; // «Вы отменили оплату. Заказ сохранён…»
    textFailed: string; // «Платёж не прошёл. Заказ сохранён…»
    textClosed: string; // «Заказ отменён, оплата по нему невозможна.»
    /** Ссылка «Проверить статус ещё раз» (пока идёт подтверждение). */
    refreshStatus: string;
    /**
     * 🔴 ВЫХОД ИЗ ОЖИДАНИЯ. Пока подтверждение платежа в пути, кнопки оплаты нет
     * (иначе двойное списание). Чтобы это ожидание не выглядело новым тупиком,
     * покупателю прямо говорим: если оплата не прошла, возможность оплатить
     * вернётся сама через несколько минут.
     */
    settlingHint: string;
    /** Кнопка повторной оплаты уже созданного заказа. */
    payAgain: string;
    payAgainBusy: string; // «Переходим к оплате…»
    payAgainError: string; // общий человекочитаемый отказ
    payAgainNotPayable: string; // «этот заказ оплатить уже нельзя»
    payAgainInProgress: string; // «оплата уже обрабатывается, деньги удержаны»

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
    // Сбой запроса кодов — четвёртое состояние блока (аудит, находка №12):
    // раньше 429/ошибка молча ПРЯТАЛИ блок, и покупатель, уплативший за
    // сертификат, не видел ни кода, ни причины.
    giftRateLimited: string; // 429: слишком много запросов, подождите
    giftError: string; // сеть/5xx: код не потерян, попробуйте обновить
  };
  /**
   * Страница заказа и блок «где моя посылка» (находка аудита №5). Покупателю
   * негде было узнать статус доставки и трек-номер: письма о смене статуса
   * платформа не шлёт, ЛК на витрине нет. Отсюда — постоянная страница заказа
   * по номеру и токену + подписи статусов доставки ПО КОДУ во всех локалях
   * (серверные подписи всегда русские — их рендерить нельзя).
   */
  order: {
    title: string; // «Ваш заказ»
    metaTitle: string; // <title> страницы
    needLink: string; // «откройте заказ по персональной ссылке»
    notFound: string; // «заказ не найден: ссылка недействительна»

    statusOrder: string; // «Статус заказа»
    statusPayment: string; // «Оплата»
    statusDelivery: string; // «Доставка»
    statusTotal: string; // «Сумма»
    placedAt: string; // «Оформлен»

    method: string; // «Способ доставки»
    destination: string; // «Куда»
    track: string; // «Трек-номер»
    trackHint: string; // «по номеру можно отследить на сайте службы доставки»
    noTrackYet: string; // «трек появится, когда посылку передадут в доставку»

    linkTitle: string; // «Ссылка на ваш заказ»
    linkHint: string; // «сохраните её — вернётесь к статусу в любой момент»
    linkOpen: string; // «Открыть страницу заказа →»

    // Способ доставки (delivery.type + флаг постамата).
    methodCourier: string;
    methodPvz: string;
    methodPostamat: string;
    methodPickup: string;
    methodUnknown: string; // код способа неизвестен витрине

    // Статус доставки ПО КОДУ (delivery_status домена).
    deliveryStatusPending: string;
    deliveryStatusRegistered: string;
    deliveryStatusInTransit: string;
    deliveryStatusDelivered: string;
    deliveryStatusReturned: string;
    deliveryStatusCancelled: string;
    deliveryStatusUnknown: string; // код неизвестен и витрине, и серверной подписи
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
  /**
   * Дополнительные CMS-страницы (about/доставка/оплата/оферта/…). Здесь ТОЛЬКО
   * строки интерфейса; заголовки и содержимое самих страниц приходят из админки
   * уже переведёнными (translations на cms_pages/cms_page_sections).
   */
  cms: {
    /**
     * Доступная подпись бокового меню разделов (`aria-label` у `.about__nav`).
     * Видна скринридеру: без неё «навигация» в списке ориентиров безымянна и
     * не отличима от меню шапки/подвала.
     */
    sectionsNavTitle: string; // «Разделы»
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
    forDesigners: 'Для дизайнеров',
    phoneWhatsapp: 'Тел. / Whatsapp',
    menuAria: 'Меню сайта',
    openMenu: 'Открыть меню',
    closeMenu: 'Закрыть меню',
    expandSectionAria: 'Раскрыть раздел «{name}»',
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
    subscribeTitle: 'Подписка на рассылку',
    subscribePlaceholder: 'Ваша почта',
    subscribeSubmit: 'Отправить',
    subscribeNote:
      'Нажимая кнопку «Отправить» вы соглашаетесь на обработку персональных данных',
    subscribeSuccess: 'Спасибо за подписку!',
    subscribeError: 'Не удалось оформить подписку. Попробуйте позже.',
    subscribeInvalid: 'Укажите корректный адрес почты.',
    subscribeAria: 'Адрес почты для подписки на рассылку',
  },
  home: {
    newProducts: 'Новинки',
    ourStory: 'Наша история',
    looksNext: 'Следующие образы',
    looksTabsAria: 'Категории образов',
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
    add: 'В избранное',
    remove: 'Убрать из избранного',
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
    photoNumber: 'Фото {n}',
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
    cityLookupEmpty: 'Город не найден. Проверьте написание или введите крупный город рядом.',
    cityLookupFailed:
      'Не удалось загрузить список городов. Повторите попытку через минуту или выберите другой способ доставки.',
    addressLabel: 'Адрес доставки',
    addressPlaceholder: 'Улица, дом, квартира',
    pvzLabel: 'Пункт выдачи',
    pvzLoading: 'Загрузка пунктов выдачи…',
    pvzEmpty: 'В этом городе не найдено пунктов выдачи.',
    pvzLookupFailed:
      'Не удалось загрузить пункты выдачи. Повторите попытку через минуту или выберите доставку курьером.',
    pvzSelect: '— выберите пункт —',
    pvzTypeOffice: 'Пункт выдачи',
    pvzTypePostamat: 'Постамат',
    pvzPostamatHint:
      'Постамат — автоматическая ячейка: получение по коду без сотрудника, примерка невозможна, крупногабаритные заказы туда не принимают.',
    deliveryNoMethods:
      'Онлайн-оформление доставки временно недоступно. Свяжитесь с нами — оформим заказ вручную.',
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
    paymentCurrencyNotice:
      'Оплата производится в валюте магазина — {base}. К списанию: {charged} (≈ {approx}).',
    paymentCurrencyRate: 'Пересчёт по курсу {rate}, справочно.',
    recalculating: 'Пересчёт заказа…',
    notFulfillable: 'Некоторые товары недоступны в нужном количестве — измените корзину.',
    deliveryUnavailable: 'Не удалось рассчитать доставку — измените способ или адрес доставки.',
    deliveryNeedsCity: 'Укажите город доставки — без него стоимость доставки не рассчитать.',
    unresolvableItems:
      'Некоторые товары добавлены в корзину в старой версии сайта и не могут быть оформлены. Пожалуйста, удалите их из корзины и добавьте заново со страницы товара.',
    unresolvableItemsList: 'Это касается позиций: {items}.',
    priceChangedNotice:
      'Цена некоторых товаров изменилась после того, как вы добавили их в корзину. В заказе указаны актуальные цены — именно они и войдут в итог.',
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
    issueVariantNotFound: 'выбранный вариант товара недоступен',
    issueInactive: 'товар снят с продажи',
    promoReasonNotFound: 'Промокод не найден.',
    promoReasonExpired: 'Срок действия промокода истёк.',
    promoReasonNotStarted: 'Промокод ещё не активен.',
    promoReasonInactive: 'Промокод неактивен.',
    promoReasonUsageLimit: 'Лимит использований промокода исчерпан.',
    promoReasonMinOrder: 'Заказ не достигает минимальной суммы для промокода.',
    promoReasonPerCustomerLimit: 'Вы уже использовали этот промокод.',
    promoReasonBelowMinQty:
      'Для этого промокода нужно больше единиц товара — добавьте ещё.',
    promoReasonInvalidKind: 'Этот промокод неприменим к вашей корзине.',
    promoReasonNotApplicable:
      'Промокод не подошёл к этому заказу. Проверьте написание или попробуйте другой.',
    giftReasonNotFound: 'Сертификат с таким кодом не найден.',
    giftReasonExpired: 'Срок действия сертификата истёк.',
    giftReasonDepleted: 'На сертификате не осталось средств.',
    giftReasonDisabled: 'Сертификат отключён.',
    giftReasonNoAmountDue: 'Сертификату нечего покрывать в этом заказе.',
    giftReasonNotApplicable:
      'Сертификат не подошёл к этому заказу. Проверьте написание кода или свяжитесь с магазином.',
    orderErrorOutOfStock:
      'Часть товаров закончилась, пока вы оформляли заказ. Обновите корзину.',
    orderErrorInvalidItem: 'Один из товаров стал недоступен. Уберите его из корзины.',
    orderErrorInvalidPromo: 'Промокод недействителен. Уберите его и попробуйте снова.',
    orderErrorInvalidGift: 'Подарочный сертификат недействителен.',
    orderErrorDeliveryUnavailable:
      'Не удалось рассчитать доставку в выбранное место. Измените способ или адрес доставки.',
    orderErrorPaymentsDisabled:
      'Онлайн-оплата временно недоступна. Свяжитесь с магазином для оформления.',
    orderErrorInvalidZone:
      'Выбранная зона доставки больше недоступна. Обновите страницу и выберите её заново.',
    orderErrorInvalidPvz:
      'Выбранный пункт выдачи больше недоступен. Обновите страницу и выберите пункт выдачи заново.',
    orderErrorOrderNotFound:
      'Заказ не найден. Проверьте ссылку из письма или свяжитесь с магазином.',
    orderErrorOrderNotPayable: 'Этот заказ оплатить нельзя: он уже оплачен или закрыт.',
    orderErrorPaymentInitFailed:
      'Не удалось начать оплату. Попробуйте ещё раз через минуту или свяжитесь с магазином.',
    orderErrorPaymentInProgress:
      'Оплата этого заказа уже обрабатывается: банк зарезервировал деньги. Платить второй раз не нужно — обновите страницу через несколько минут.',
    orderErrorTotalMismatch:
      'Сумма заказа изменилась, пока вы оформляли его: могли измениться цены, промокод или остаток сертификата. Заказ не создан, деньги не списаны. Вернитесь в корзину и проверьте актуальный итог.',
    orderTotalChanged:
      'Итог изменился: на экране было {expected}, фактическая сумма заказа — {actual}.',
    orderTotalChangedAction:
      'Мы не отправили вас на оплату, чтобы вы не заплатили сумму, которую не видели. Обновите страницу и проверьте заказ перед оплатой.',
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
    titleAwaiting: 'Заказ ожидает оплаты',
    titleCancelled: 'Оплата не завершена',
    titleFailed: 'Платёж не прошёл',
    titleClosed: 'Заказ закрыт',
    textPaid: 'Спасибо! Заказ №{number} принят и полностью оплачен.',
    textSettling:
      'Заказ №{number} принят. Банк подтверждает платёж — обычно это занимает до минуты.',
    textAwaiting: 'Заказ №{number} сохранён, но деньги за него ещё не получены.',
    textCancelled: 'Вы прервали оплату. Заказ №{number} сохранён — его можно оплатить сейчас.',
    textFailed: 'Банк отклонил платёж. Заказ №{number} сохранён — попробуйте оплатить ещё раз.',
    textClosed: 'Заказ №{number} закрыт. Оформите новый или свяжитесь с нами.',
    refreshStatus: 'Проверить статус ещё раз',
    settlingHint: 'Если оплата так и не прошла, обновите страницу через несколько минут — возможность оплатить заказ вернётся.',
    payAgain: 'Оплатить заказ',
    payAgainBusy: 'Переходим к оплате…',
    payAgainError: 'Не удалось перейти к оплате. Попробуйте ещё раз или свяжитесь с нами.',
    payAgainNotPayable: 'Этот заказ больше не требует оплаты — обновите страницу.',
    payAgainInProgress:
      'Оплата уже обрабатывается: банк зарезервировал деньги. Платить второй раз не нужно.',
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
    giftRateLimited:
      'Слишком много обращений за кодом. Подождите минуту и нажмите «Обновить» — код никуда не пропал.',
    giftError:
      'Не удалось получить код прямо сейчас. Он сохранён за вашим заказом: нажмите «Обновить» или вернитесь на эту страницу позже.',
  },
  order: {
    title: 'Ваш заказ',
    metaTitle: 'Заказ',
    needLink:
      'Чтобы открыть заказ, перейдите по персональной ссылке из подтверждения заказа.',
    notFound: 'Заказ не найден: ссылка недействительна или устарела.',

    statusOrder: 'Статус заказа',
    statusPayment: 'Оплата',
    statusDelivery: 'Доставка',
    statusTotal: 'Сумма',
    placedAt: 'Оформлен',

    method: 'Способ доставки',
    destination: 'Куда',
    track: 'Трек-номер',
    trackHint: 'По этому номеру посылку можно отследить на сайте службы доставки.',
    noTrackYet:
      'Трек-номер появится здесь, как только посылку передадут в службу доставки.',

    linkTitle: 'Ссылка на ваш заказ',
    linkHint:
      'Сохраните её: по этой ссылке вы в любой момент вернётесь к статусу заказа и трек-номеру.',
    linkOpen: 'Открыть страницу заказа →',

    methodCourier: 'Курьер',
    methodPvz: 'Пункт выдачи',
    methodPostamat: 'Постамат',
    methodPickup: 'Самовывоз',
    methodUnknown: 'Доставка',

    deliveryStatusPending: 'Готовится к отправке',
    deliveryStatusRegistered: 'Передана в службу доставки',
    deliveryStatusInTransit: 'В пути',
    deliveryStatusDelivered: 'Доставлена',
    deliveryStatusReturned: 'Возвращена отправителю',
    deliveryStatusCancelled: 'Отменена',
    deliveryStatusUnknown: 'Уточняется',
  },
  notFound: {
    text: 'Страница не найдена.',
    pageMetaTitle: 'Страница не найдена',
    productMetaTitle: 'Товар не найден',
    designerMetaTitle: 'Дизайнер не найден',
  },
  cms: {
    sectionsNavTitle: 'Разделы',
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
    forDesigners: 'For designers',
    phoneWhatsapp: 'Phone / WhatsApp',
    menuAria: 'Site menu',
    openMenu: 'Open menu',
    closeMenu: 'Close menu',
    expandSectionAria: 'Expand section “{name}”',
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
    subscribeTitle: 'Newsletter',
    subscribePlaceholder: 'Your email',
    subscribeSubmit: 'Subscribe',
    subscribeNote:
      'By clicking “Subscribe” you consent to the processing of your personal data',
    subscribeSuccess: 'Thank you for subscribing!',
    subscribeError: 'We could not save your subscription. Please try again later.',
    subscribeInvalid: 'Please enter a valid email address.',
    subscribeAria: 'Email address for the newsletter',
  },
  home: {
    newProducts: 'New arrivals',
    ourStory: 'Our story',
    looksNext: 'Next looks',
    looksTabsAria: 'Look categories',
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
    add: 'Add to wishlist',
    remove: 'Remove from wishlist',
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
    photoNumber: 'Photo {n}',
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
    cityLookupEmpty: 'City not found. Check the spelling or enter a larger city nearby.',
    cityLookupFailed:
      'We could not load the city list. Please try again in a minute or choose another delivery option.',
    addressLabel: 'Delivery address',
    addressPlaceholder: 'Street, building, apartment',
    pvzLabel: 'Pickup point',
    pvzLoading: 'Loading pickup points…',
    pvzEmpty: 'No pickup points found in this city.',
    pvzLookupFailed:
      'We could not load the pickup points. Please try again in a minute or choose courier delivery.',
    pvzSelect: '— select a point —',
    pvzTypeOffice: 'Pickup point',
    pvzTypePostamat: 'Parcel locker',
    pvzPostamatHint:
      'A parcel locker is an automated box: you collect the parcel with a code, there is no staff member, no fitting is possible and oversized orders are not accepted.',
    deliveryNoMethods:
      'Online delivery booking is temporarily unavailable. Please contact us and we will place the order for you.',
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
    paymentCurrencyNotice:
      'Payment is taken in the shop currency — {base}. You will be charged {charged} (≈ {approx}).',
    paymentCurrencyRate: 'Converted at {rate}, for reference only.',
    recalculating: 'Recalculating order…',
    notFulfillable: 'Some items are not available in the requested quantity — please update your cart.',
    deliveryUnavailable: 'Could not calculate delivery — change the method or delivery address.',
    deliveryNeedsCity:
      'Please enter the delivery city — the shipping cost cannot be calculated without it.',
    unresolvableItems:
      'Some items were added to the cart in an older version of the site and cannot be ordered. Please remove them from the cart and add them again from the product page.',
    unresolvableItemsList: 'This applies to: {items}.',
    priceChangedNotice:
      'The price of some items changed after you added them to your cart. The order shows the current prices — those are the ones included in the total.',
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
    issueVariantNotFound: 'the selected option is no longer available',
    issueInactive: 'item has been discontinued',
    promoReasonNotFound: 'Promo code not found.',
    promoReasonExpired: 'The promo code has expired.',
    promoReasonNotStarted: 'The promo code is not active yet.',
    promoReasonInactive: 'The promo code is inactive.',
    promoReasonUsageLimit: 'The promo code usage limit has been reached.',
    promoReasonMinOrder: 'The order does not reach the minimum amount for this promo code.',
    promoReasonPerCustomerLimit: 'You have already used this promo code.',
    promoReasonBelowMinQty:
      'This promo code requires more items — please add a few more.',
    promoReasonInvalidKind: 'This promo code does not apply to your cart.',
    promoReasonNotApplicable:
      'This promo code does not apply to your order. Check the spelling or try another one.',
    giftReasonNotFound: 'No gift certificate found for this code.',
    giftReasonExpired: 'The gift certificate has expired.',
    giftReasonDepleted: 'The gift certificate has no funds left.',
    giftReasonDisabled: 'The gift certificate has been disabled.',
    giftReasonNoAmountDue: 'There is nothing for the gift certificate to cover in this order.',
    giftReasonNotApplicable:
      'This gift certificate does not apply to your order. Check the code or contact the shop.',
    orderErrorOutOfStock:
      'Some items ran out while you were placing the order. Please refresh your cart.',
    orderErrorInvalidItem: 'One of the items became unavailable. Please remove it from the cart.',
    orderErrorInvalidPromo: 'The promo code is invalid. Remove it and try again.',
    orderErrorInvalidGift: 'The gift certificate is invalid.',
    orderErrorDeliveryUnavailable:
      'Could not calculate delivery to the selected location. Change the method or delivery address.',
    orderErrorPaymentsDisabled:
      'Online payment is temporarily unavailable. Please contact the store to place your order.',
    orderErrorInvalidZone:
      'The selected delivery area is no longer available. Refresh the page and pick it again.',
    orderErrorInvalidPvz:
      'The selected pickup point is no longer available. Refresh the page and choose another pickup point.',
    orderErrorOrderNotFound:
      'Order not found. Check the link from your email or contact the store.',
    orderErrorOrderNotPayable: 'This order cannot be paid: it has already been paid or closed.',
    orderErrorPaymentInitFailed:
      'Could not start the payment. Try again in a minute or contact the store.',
    orderErrorPaymentInProgress:
      'This order is already being paid: the bank is holding the funds. There is no need to pay twice — please refresh the page in a few minutes.',
    orderErrorTotalMismatch:
      'The order total changed while you were checking out: prices, the promo code or the certificate balance may have changed. The order was not created and you have not been charged. Please go back to your cart and check the current total.',
    orderTotalChanged:
      'The total changed: your screen showed {expected}, while the actual order total is {actual}.',
    orderTotalChangedAction:
      'We did not send you to payment, so that you never pay an amount you have not seen. Please refresh the page and review the order before paying.',
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
    titleAwaiting: 'Order awaiting payment',
    titleCancelled: 'Payment not completed',
    titleFailed: 'Payment declined',
    titleClosed: 'Order closed',
    textPaid: 'Thank you! Order #{number} has been received and paid in full.',
    textSettling:
      'Order #{number} has been received. The bank is confirming the payment — this usually takes under a minute.',
    textAwaiting: 'Order #{number} is saved, but we have not received the money for it yet.',
    textCancelled:
      'You stopped the payment. Order #{number} is saved — you can pay for it right now.',
    textFailed: 'The bank declined the payment. Order #{number} is saved — please try paying again.',
    textClosed: 'Order #{number} is closed. Please place a new one or contact us.',
    refreshStatus: 'Check the status again',
    settlingHint: 'If the payment did not go through after all, refresh this page in a few minutes — the option to pay will come back.',
    payAgain: 'Pay for the order',
    payAgainBusy: 'Taking you to the payment page…',
    payAgainError: 'We could not open the payment page. Please try again or contact us.',
    payAgainNotPayable: 'This order no longer needs payment — please refresh the page.',
    payAgainInProgress:
      'The payment is already being processed: the bank is holding the funds. There is no need to pay twice.',
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
    giftRateLimited:
      'Too many requests for this code. Wait a minute and press “Refresh” — the code has not been lost.',
    giftError:
      'We could not retrieve the code right now. It stays attached to your order: press “Refresh” or come back to this page later.',
  },
  order: {
    title: 'Your order',
    metaTitle: 'Order',
    needLink:
      'To open your order, follow the personal link from your order confirmation.',
    notFound: 'Order not found: the link is invalid or has expired.',

    statusOrder: 'Order status',
    statusPayment: 'Payment',
    statusDelivery: 'Delivery',
    statusTotal: 'Total',
    placedAt: 'Placed on',

    method: 'Delivery method',
    destination: 'Destination',
    track: 'Tracking number',
    trackHint: 'Use this number to track the parcel on the carrier’s website.',
    noTrackYet:
      'The tracking number will appear here as soon as the parcel is handed over to the carrier.',

    linkTitle: 'Link to your order',
    linkHint:
      'Save it: this link brings you back to the order status and the tracking number at any time.',
    linkOpen: 'Open the order page →',

    methodCourier: 'Courier',
    methodPvz: 'Pickup point',
    methodPostamat: 'Parcel locker',
    methodPickup: 'Store pickup',
    methodUnknown: 'Delivery method',

    deliveryStatusPending: 'Preparing for dispatch',
    deliveryStatusRegistered: 'Handed over to the carrier',
    deliveryStatusInTransit: 'In transit',
    deliveryStatusDelivered: 'Delivered',
    deliveryStatusReturned: 'Returned to sender',
    deliveryStatusCancelled: 'Cancelled',
    deliveryStatusUnknown: 'Being confirmed',
  },
  notFound: {
    text: 'Page not found.',
    pageMetaTitle: 'Page not found',
    productMetaTitle: 'Product not found',
    designerMetaTitle: 'Designer not found',
  },
  cms: {
    sectionsNavTitle: 'Sections',
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
    forDesigners: 'Pour les créateurs',
    phoneWhatsapp: 'Tél. / WhatsApp',
    menuAria: 'Menu du site',
    openMenu: 'Ouvrir le menu',
    closeMenu: 'Fermer le menu',
    expandSectionAria: 'Déplier la rubrique « {name} »',
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
    subscribeTitle: 'Newsletter',
    subscribePlaceholder: 'Votre e-mail',
    subscribeSubmit: 'S’abonner',
    subscribeNote:
      'En cliquant sur « S’abonner », vous acceptez le traitement de vos données personnelles',
    subscribeSuccess: 'Merci pour votre abonnement !',
    subscribeError: 'Impossible d’enregistrer votre abonnement. Réessayez plus tard.',
    subscribeInvalid: 'Veuillez saisir une adresse e-mail valide.',
    subscribeAria: 'Adresse e-mail pour la newsletter',
  },
  home: {
    newProducts: 'Nouveautés',
    ourStory: 'Notre histoire',
    looksNext: 'Looks suivants',
    looksTabsAria: 'Catégories de looks',
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
    add: 'Ajouter aux favoris',
    remove: 'Retirer des favoris',
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
    photoNumber: 'Photo {n}',
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
    cityLookupEmpty:
      'Ville introuvable. Vérifiez l’orthographe ou saisissez une grande ville proche.',
    cityLookupFailed:
      'Impossible de charger la liste des villes. Réessayez dans une minute ou choisissez un autre mode de livraison.',
    addressLabel: 'Adresse de livraison',
    addressPlaceholder: 'Rue, bâtiment, appartement',
    pvzLabel: 'Point de retrait',
    pvzLoading: 'Chargement des points de retrait…',
    pvzEmpty: 'Aucun point de retrait trouvé dans cette ville.',
    pvzLookupFailed:
      'Impossible de charger les points de retrait. Réessayez dans une minute ou choisissez la livraison par coursier.',
    pvzSelect: '— choisissez un point —',
    pvzTypeOffice: 'Point relais',
    pvzTypePostamat: 'Consigne automatique',
    pvzPostamatHint:
      'Une consigne automatique est un casier automatisé : le retrait se fait avec un code, sans personnel, l’essayage est impossible et les commandes volumineuses n’y sont pas acceptées.',
    deliveryNoMethods:
      'La commande de livraison en ligne est momentanément indisponible. Contactez-nous, nous enregistrerons la commande pour vous.',
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
    paymentCurrencyNotice:
      'Le paiement est prélevé dans la devise de la boutique — {base}. Vous serez débité de {charged} (≈ {approx}).',
    paymentCurrencyRate: 'Conversion au taux de {rate}, à titre indicatif.',
    recalculating: 'Recalcul de la commande…',
    notFulfillable: 'Certains articles ne sont pas disponibles dans la quantité demandée — modifiez votre panier.',
    deliveryUnavailable: 'Impossible de calculer la livraison — changez le mode ou l’adresse de livraison.',
    deliveryNeedsCity:
      'Indiquez la ville de livraison — sans elle, les frais de livraison ne peuvent pas être calculés.',
    unresolvableItems:
      'Certains articles ont été ajoutés au panier dans une ancienne version du site et ne peuvent pas être commandés. Veuillez les retirer du panier et les ajouter à nouveau depuis la page produit.',
    unresolvableItemsList: 'Cela concerne les articles suivants : {items}.',
    priceChangedNotice:
      'Le prix de certains articles a changé depuis que vous les avez ajoutés au panier. La commande affiche les prix actuels — ce sont eux qui entrent dans le total.',
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
    issueVariantNotFound: 'la déclinaison choisie n’est plus disponible',
    issueInactive: 'article retiré de la vente',
    promoReasonNotFound: 'Code promo introuvable.',
    promoReasonExpired: 'Le code promo a expiré.',
    promoReasonNotStarted: 'Le code promo n’est pas encore actif.',
    promoReasonInactive: 'Le code promo est inactif.',
    promoReasonUsageLimit: 'La limite d’utilisation du code promo est atteinte.',
    promoReasonMinOrder: 'La commande n’atteint pas le montant minimum pour ce code promo.',
    promoReasonPerCustomerLimit: 'Vous avez déjà utilisé ce code promo.',
    promoReasonBelowMinQty:
      'Ce code promo exige davantage d’articles — ajoutez-en quelques-uns.',
    promoReasonInvalidKind: 'Ce code promo ne s’applique pas à votre panier.',
    promoReasonNotApplicable:
      'Ce code promo ne s’applique pas à cette commande. Vérifiez l’orthographe ou essayez-en un autre.',
    giftReasonNotFound: 'Carte cadeau introuvable.',
    giftReasonExpired: 'La carte cadeau a expiré.',
    giftReasonDepleted: 'La carte cadeau n’a plus de solde.',
    giftReasonDisabled: 'La carte cadeau a été désactivée.',
    giftReasonNoAmountDue: 'Il n’y a rien à couvrir par la carte cadeau dans cette commande.',
    giftReasonNotApplicable:
      'Cette carte cadeau ne s’applique pas à cette commande. Vérifiez le code ou contactez la boutique.',
    orderErrorOutOfStock:
      'Certains articles se sont épuisés pendant votre commande. Veuillez actualiser votre panier.',
    orderErrorInvalidItem: 'Un des articles est devenu indisponible. Retirez-le du panier.',
    orderErrorInvalidPromo: 'Le code promo n’est pas valide. Retirez-le et réessayez.',
    orderErrorInvalidGift: 'La carte cadeau n’est pas valide.',
    orderErrorDeliveryUnavailable:
      'Impossible de calculer la livraison vers le lieu choisi. Changez le mode ou l’adresse de livraison.',
    orderErrorPaymentsDisabled:
      'Le paiement en ligne est temporairement indisponible. Contactez la boutique pour passer commande.',
    orderErrorInvalidZone:
      'La zone de livraison choisie n’est plus disponible. Actualisez la page et sélectionnez-la à nouveau.',
    orderErrorInvalidPvz:
      'Le point de retrait choisi n’est plus disponible. Actualisez la page et sélectionnez un autre point de retrait.',
    orderErrorOrderNotFound:
      'Commande introuvable. Vérifiez le lien reçu par e-mail ou contactez la boutique.',
    orderErrorOrderNotPayable: 'Cette commande ne peut pas être réglée : elle est déjà payée ou clôturée.',
    orderErrorPaymentInitFailed:
      'Impossible de lancer le paiement. Réessayez dans une minute ou contactez la boutique.',
    orderErrorPaymentInProgress:
      'Le paiement de cette commande est déjà en cours : la banque a réservé les fonds. Inutile de payer une seconde fois — actualisez la page dans quelques minutes.',
    orderErrorTotalMismatch:
      'Le montant de la commande a changé pendant votre commande : les prix, le code promo ou le solde du chèque-cadeau ont pu évoluer. La commande n’a pas été créée et aucun montant n’a été débité. Retournez au panier et vérifiez le total actuel.',
    orderTotalChanged:
      'Le total a changé : votre écran affichait {expected}, alors que le montant réel de la commande est {actual}.',
    orderTotalChangedAction:
      'Nous ne vous avons pas redirigé vers le paiement, afin que vous ne payiez jamais un montant que vous n’avez pas vu. Actualisez la page et vérifiez la commande avant de payer.',
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
    titleAwaiting: 'Commande en attente de paiement',
    titleCancelled: 'Paiement interrompu',
    titleFailed: 'Paiement refusé',
    titleClosed: 'Commande clôturée',
    textPaid: 'Merci ! La commande n°{number} a bien été reçue et intégralement réglée.',
    textSettling:
      'La commande n°{number} a bien été reçue. La banque confirme le paiement — cela prend généralement moins d’une minute.',
    textAwaiting:
      'La commande n°{number} est enregistrée, mais nous n’avons pas encore reçu le règlement.',
    textCancelled:
      'Vous avez interrompu le paiement. La commande n°{number} est conservée — vous pouvez la régler dès maintenant.',
    textFailed:
      'La banque a refusé le paiement. La commande n°{number} est conservée — réessayez de la régler.',
    textClosed:
      'La commande n°{number} est clôturée. Passez une nouvelle commande ou contactez-nous.',
    refreshStatus: 'Vérifier à nouveau le statut',
    settlingHint: 'Si le paiement n’a finalement pas abouti, actualisez cette page dans quelques minutes : la possibilité de régler la commande réapparaîtra.',
    payAgain: 'Régler la commande',
    payAgainBusy: 'Redirection vers le paiement…',
    payAgainError: 'Impossible d’ouvrir la page de paiement. Réessayez ou contactez-nous.',
    payAgainNotPayable: 'Cette commande ne nécessite plus de paiement — actualisez la page.',
    payAgainInProgress:
      'Le paiement est déjà en cours de traitement : la banque a réservé les fonds. Inutile de payer une seconde fois.',
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
    giftRateLimited:
      'Trop de demandes pour ce code. Patientez une minute puis appuyez sur « Actualiser » — le code n’est pas perdu.',
    giftError:
      'Impossible de récupérer le code pour le moment. Il reste rattaché à votre commande : appuyez sur « Actualiser » ou revenez sur cette page plus tard.',
  },
  order: {
    title: 'Votre commande',
    metaTitle: 'Commande',
    needLink:
      'Pour ouvrir votre commande, utilisez le lien personnel figurant dans la confirmation de commande.',
    notFound: 'Commande introuvable : le lien est invalide ou a expiré.',

    statusOrder: 'Statut de la commande',
    statusPayment: 'Paiement',
    statusDelivery: 'Livraison',
    statusTotal: 'Total à payer',
    placedAt: 'Passée le',

    method: 'Mode de livraison',
    destination: 'Lieu de livraison',
    track: 'Numéro de suivi',
    trackHint: 'Ce numéro permet de suivre le colis sur le site du transporteur.',
    noTrackYet:
      'Le numéro de suivi apparaîtra ici dès que le colis sera remis au transporteur.',

    linkTitle: 'Lien vers votre commande',
    linkHint:
      'Conservez-le : ce lien vous ramène à tout moment au statut de la commande et au numéro de suivi.',
    linkOpen: 'Ouvrir la page de la commande →',

    methodCourier: 'Coursier',
    methodPvz: 'Point de retrait',
    methodPostamat: 'Consigne automatique',
    methodPickup: 'Retrait en boutique',
    methodUnknown: 'Mode d’expédition',

    deliveryStatusPending: 'En cours de préparation',
    deliveryStatusRegistered: 'Remis au transporteur',
    deliveryStatusInTransit: 'En cours d’acheminement',
    deliveryStatusDelivered: 'Livré',
    deliveryStatusReturned: 'Retourné à l’expéditeur',
    deliveryStatusCancelled: 'Annulé',
    deliveryStatusUnknown: 'En cours de confirmation',
  },
  notFound: {
    text: 'Page introuvable.',
    pageMetaTitle: 'Page introuvable',
    productMetaTitle: 'Produit introuvable',
    designerMetaTitle: 'Créateur introuvable',
  },
  cms: {
    sectionsNavTitle: 'Rubriques',
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
