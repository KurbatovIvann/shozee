/**
 * Staff products copy (SHO-477).
 *
 * Wholesale move of the mobile products tree. Web has no products
 * copy today — do not invent web strings here. Chrome spreads come
 * from `./chrome`. Do not import catalog or contract types.
 */
import {
  formChromeEn,
  formChromeUk,
  type FormChromeCopy,
  type WriteErrorsCopy,
} from "./chrome.js";
import { selectCopy, type Locale } from "./locale.js";
import type { CountForms } from "./plural.js";

export type ProductsVariantForms = CountForms & {
  readonly none: string;
};

export type ProductsFormCopy = FormChromeCopy & {
  readonly detailsTitle: string;
  readonly priceSectionTitle: string;
  readonly nameLabel: string;
  readonly namePlaceholder: string;
  readonly priceLabel: string;
  readonly pricePlaceholder: string;
  readonly priceHint: string;
  readonly variantsTitle: string;
  readonly variantsEmptyTitle: string;
  readonly variantsEmptyDescription: string;
  readonly addVariant: string;
  readonly variantInheritedPrice: string;
  readonly footerBasePrice: string;
  readonly variantSheetNewTitle: string;
  readonly variantSheetEditTitle: string;
  readonly variantSheetNameLabel: string;
  readonly variantSheetNamePlaceholder: string;
  readonly variantSheetCustomPrice: string;
  readonly variantSheetCustomPriceDescription: string;
  readonly variantSheetPriceLabel: string;
  readonly variantSheetSave: string;
  readonly permissionCreateTitle: string;
  readonly permissionCreateDescription: string;
  readonly permissionEditTitle: string;
  readonly permissionEditDescription: string;
  readonly errors: {
    readonly nameRequired: string;
    readonly nameTooLong: string;
    readonly priceRequired: string;
    readonly priceInvalid: string;
    readonly tooManyVariants: string;
  } & WriteErrorsCopy;
};

export type ProductsDetailCopy = {
  readonly title: string;
  readonly loadingLabel: string;
  readonly offlineTitle: string;
  readonly offlineDescription: string;
  readonly errorTitle: string;
  readonly errorDescription: string;
  readonly retry: string;
  readonly notFoundTitle: string;
  readonly notFoundDescription: string;
  readonly variantsTitle: string;
  readonly noPhotos: string;
  readonly photosLabel: string;
  readonly photosManageLabel: string;
  readonly editLabel: string;
  readonly inheritedPrice: string;
  readonly archiveProduct: string;
  readonly restoreProduct: string;
  readonly archiveVariant: string;
  readonly restoreVariant: string;
  readonly archiveVariantNamed: string;
  readonly restoreVariantNamed: string;
  readonly productActionsTitle: string;
  readonly productActionsLabel: string;
  readonly variantActionsLabel: string;
  readonly statusActive: string;
  readonly factsTitle: string;
  readonly factStatus: string;
  readonly confirmArchiveProductTitle: string;
  readonly confirmArchiveProductDescription: string;
  readonly confirmRestoreProductTitle: string;
  readonly confirmRestoreProductDescription: string;
  readonly confirmArchiveVariantTitle: string;
  readonly confirmArchiveVariantDescription: string;
  readonly confirmRestoreVariantTitle: string;
  readonly confirmRestoreVariantDescription: string;
  readonly cancel: string;
  readonly mutationError: string;
  readonly mutationOffline: string;
  readonly mutationPermission: string;
};

export type ProductsPhotosCopy = {
  readonly title: string;
  readonly heading: string;
  readonly count: string;
  readonly hint: string;
  readonly addLabel: string;
  readonly addCamera: string;
  readonly addLibrary: string;
  readonly coverLabel: string;
  readonly removeLabel: string;
  readonly moveEarlier: string;
  readonly moveLater: string;
  readonly retryLabel: string;
  readonly cancelUpload: string;
  readonly uploadingLabel: string;
  readonly failedLabel: string;
  readonly emptyTitle: string;
  readonly emptyDescription: string;
  readonly pickTitle: string;
  readonly pickDescription: string;
  readonly permissionTitle: string;
  readonly permissionDescription: string;
  readonly cameraDeniedTitle: string;
  readonly cameraDeniedDescription: string;
  readonly libraryDeniedTitle: string;
  readonly libraryDeniedDescription: string;
  readonly closeSheet: string;
  readonly errors: {
    readonly network: string;
    readonly offline: string;
    readonly unavailable: string;
    readonly permission: string;
    readonly denied: string;
    readonly validation: string;
    readonly too_many: string;
    readonly commit: string;
  };
};

export type SharedProductsCopy = {
  readonly title: string;
  readonly searchLabel: string;
  readonly searchPlaceholder: string;
  readonly createLabel: string;
  readonly backLabel: string;
  readonly filters: {
    readonly all: string;
    readonly active: string;
    readonly archived: string;
  };
  readonly foundCount: string;
  readonly thumbnailUnavailable: string;
  readonly archivedBadge: string;
  readonly variants: ProductsVariantForms;
  readonly loadingLabel: string;
  readonly loadingMoreLabel: string;
  readonly empty: {
    readonly offlineTitle: string;
    readonly offlineDescription: string;
    readonly errorTitle: string;
    readonly errorDescription: string;
    readonly retry: string;
    readonly searchTitle: string;
    readonly searchDescription: string;
    readonly reset: string;
    readonly archivedTitle: string;
    readonly archivedDescription: string;
    readonly catalogTitle: string;
    readonly catalogDescription: string;
    readonly create: string;
    readonly activeTitle: string;
    readonly activeDescription: string;
    readonly showAll: string;
  };
  readonly stub: {
    readonly createTitle: string;
    readonly editTitle: string;
    readonly photosTitle: string;
  };
  readonly form: ProductsFormCopy;
  readonly detail: ProductsDetailCopy;
  readonly photos: ProductsPhotosCopy;
};

const en: SharedProductsCopy = {
  title: "Products",
  searchLabel: "Search products",
  searchPlaceholder: "Product name",
  createLabel: "New product",
  backLabel: "Back",
  filters: {
    all: "All",
    active: "Active",
    archived: "Archived",
  },
  foundCount: "Found · {{count}}",
  thumbnailUnavailable: "Photo unavailable",
  archivedBadge: "Archived",
  variants: {
    none: "No variants",
    one: "{{count}} variant",
    few: "{{count}} variants",
    many: "{{count}} variants",
  },
  loadingLabel: "Loading products",
  loadingMoreLabel: "Loading more products",
  empty: {
    offlineTitle: "No connection",
    offlineDescription:
      "The product list is unavailable offline. Connect and try again.",
    errorTitle: "Could not load products",
    errorDescription: "Check your connection and try again.",
    retry: "Retry",
    searchTitle: "Nothing found",
    searchDescription: "Change the search query or reset the search.",
    reset: "Reset",
    archivedTitle: "The archive is empty",
    archivedDescription:
      "Archived products stay in the list so old orders keep working.",
    catalogTitle: "No products yet",
    catalogDescription:
      "Create the first product manually or ask the AI assistant.",
    create: "New product",
    activeTitle: "No active products",
    activeDescription:
      "Restore a product from the archive or view all products.",
    showAll: "Show all",
  },
  stub: {
    createTitle: "New product",
    editTitle: "Edit product",
    photosTitle: "Photos",
  },
  form: {
    detailsTitle: "Details",
    priceSectionTitle: "Price",
    nameLabel: "Product name",
    namePlaceholder: "For example, Napoleon cake",
    priceLabel: "Base price",
    pricePlaceholder: "0",
    priceHint: "Base price for variants without their own price. Hryvnia only.",
    variantsTitle: "Variants",
    variantsEmptyTitle: "No variants yet",
    variantsEmptyDescription:
      "Add sizes or flavors when the price or composition differs.",
    addVariant: "Add variant",
    variantInheritedPrice: "same as product · {{price}}",
    footerBasePrice: "Base price",
    ...formChromeEn,
    changedLabel: "changed",
    variantSheetNewTitle: "New variant",
    variantSheetEditTitle: "Edit variant",
    variantSheetNameLabel: "Name",
    variantSheetNamePlaceholder: "For example, 2 kg or Vanilla",
    variantSheetCustomPrice: "Different price",
    variantSheetCustomPriceDescription:
      "When off, the variant uses the product base price",
    variantSheetPriceLabel: "Variant price",
    variantSheetSave: "Save",
    submitCreate: "Create product",
    submitCreateLoading: "Creating…",
    permissionCreateTitle: "No permission",
    permissionCreateDescription:
      "You do not have permission to create products.",
    permissionEditTitle: "No permission",
    permissionEditDescription:
      "You do not have permission to change this product.",
    errors: {
      nameRequired: "Enter a name",
      nameTooLong: "Name is too long",
      priceRequired: "Enter a price",
      priceInvalid: "Check the price",
      validation: "Check the fields and try again.",
      network: "Network error. Check your connection.",
      offline: "You're offline. Check your connection and try again.",
      unavailable: "Something went wrong. Try again.",
      permission: "You do not have permission to change this product.",
      tooManyVariants: "Too many variants. Maximum is 100.",
    },
  },
  detail: {
    title: "Product",
    loadingLabel: "Loading product",
    offlineTitle: "No connection",
    offlineDescription:
      "Product details are unavailable offline. Connect and try again.",
    errorTitle: "Could not load the product",
    errorDescription: "Check your connection and try again.",
    retry: "Retry",
    notFoundTitle: "Product not found",
    notFoundDescription: "This product could not be found or is unavailable.",
    variantsTitle: "Variants",
    noPhotos: "No photos",
    photosLabel: "Photos",
    photosManageLabel: "Manage photos",
    editLabel: "Edit",
    inheritedPrice: "Base price",
    archiveProduct: "Archive product",
    restoreProduct: "Restore product",
    archiveVariant: "Archive",
    restoreVariant: "Restore",
    archiveVariantNamed: "Archive variant «{{name}}»",
    restoreVariantNamed: "Restore variant «{{name}}»",
    productActionsTitle: "Product actions",
    productActionsLabel: "Product actions",
    variantActionsLabel: "Actions for «{{name}}»",
    statusActive: "Active",
    factsTitle: "Overview",
    factStatus: "Status",
    confirmArchiveProductTitle: "Archive this product?",
    confirmArchiveProductDescription:
      "The product will leave sale. Variants keep their own status. Existing orders stay valid.",
    confirmRestoreProductTitle: "Restore this product?",
    confirmRestoreProductDescription:
      "The product will be available for sale again.",
    confirmArchiveVariantTitle: "Archive this variant?",
    confirmArchiveVariantDescription:
      "Variant «{{name}}» will leave sale. The product status does not change.",
    confirmRestoreVariantTitle: "Restore this variant?",
    confirmRestoreVariantDescription:
      "Variant «{{name}}» will be available for sale again.",
    cancel: "Cancel",
    mutationError: "Could not update status. Try again.",
    mutationOffline: "No connection. Connect and try again.",
    mutationPermission: "You do not have permission to change this product.",
  },
  photos: {
    title: "Photos",
    heading: "Product photos",
    count: "{{count}}/10",
    hint: "JPG, PNG or WebP · up to 10 MB · up to 10 photos. Photos belong to the product, not a variant.",
    addLabel: "Add photo",
    addCamera: "Camera",
    addLibrary: "Photo library",
    coverLabel: "Cover",
    removeLabel: "Remove photo",
    moveEarlier: "Move earlier",
    moveLater: "Move later",
    retryLabel: "Retry",
    cancelUpload: "Cancel upload",
    uploadingLabel: "Uploading",
    failedLabel: "Could not upload",
    emptyTitle: "No photos",
    emptyDescription: "Add photos from the camera or the photo library.",
    pickTitle: "Add a photo",
    pickDescription: "Choose the camera or the photo library.",
    permissionTitle: "No permission",
    permissionDescription: "You do not have permission to change these photos.",
    cameraDeniedTitle: "No camera access",
    cameraDeniedDescription:
      "Allow camera access in system settings to take product photos.",
    libraryDeniedTitle: "No photo access",
    libraryDeniedDescription:
      "Allow photo library access in system settings to attach product images.",
    closeSheet: "Cancel",
    errors: {
      network: "Network error. Check your connection.",
      offline: "You're offline. Check your connection and try again.",
      unavailable: "Something went wrong. Try again.",
      permission: "You do not have permission to change these photos.",
      denied: "No camera or library access. Allow it in the phone settings.",
      validation: "This image cannot be attached. Try another photo.",
      too_many: "Too many photos. Maximum is 10.",
      commit: "Could not save the photo list. Try again.",
    },
  },
};

const uk: SharedProductsCopy = {
  title: "Товари",
  searchLabel: "Пошук товарів",
  searchPlaceholder: "Назва товару",
  createLabel: "Новий товар",
  backLabel: "Назад",
  filters: {
    all: "Усі",
    active: "Активні",
    archived: "Архівні",
  },
  foundCount: "Знайдено · {{count}}",
  thumbnailUnavailable: "Фото недоступне",
  archivedBadge: "Архівний",
  variants: {
    none: "Без варіантів",
    one: "{{count}} варіант",
    few: "{{count}} варіанти",
    many: "{{count}} варіантів",
  },
  loadingLabel: "Завантаження товарів",
  loadingMoreLabel: "Завантаження наступних товарів",
  empty: {
    offlineTitle: "Немає зʼєднання",
    offlineDescription:
      "Список товарів недоступний офлайн. Підключіться і спробуйте ще раз.",
    errorTitle: "Не вдалося завантажити товари",
    errorDescription: "Перевірте з’єднання та спробуйте ще раз.",
    retry: "Повторити",
    searchTitle: "Нічого не знайдено",
    searchDescription: "Змініть пошуковий запит або скиньте пошук.",
    reset: "Скинути",
    archivedTitle: "Архів порожній",
    archivedDescription:
      "Архівні товари залишаються у списку, щоб не ламати старі замовлення.",
    catalogTitle: "Товарів ще немає",
    catalogDescription:
      "Створіть перший товар вручну або попросіть AI-асистента.",
    create: "Новий товар",
    activeTitle: "Активних товарів немає",
    activeDescription: "Поверніть товар з архіву або перегляньте всі товари.",
    showAll: "Показати всі",
  },
  stub: {
    createTitle: "Новий товар",
    editTitle: "Редагувати товар",
    photosTitle: "Фото",
  },
  form: {
    detailsTitle: "Деталі",
    priceSectionTitle: "Ціна",
    nameLabel: "Назва товару",
    namePlaceholder: "Наприклад, Торт «Наполеон»",
    priceLabel: "Базова ціна",
    pricePlaceholder: "0",
    priceHint: "Базова ціна для варіантів без власної ціни. Лише гривня.",
    variantsTitle: "Варіанти",
    variantsEmptyTitle: "Варіантів ще немає",
    variantsEmptyDescription:
      "Додайте розміри чи смаки, якщо ціна або склад відрізняються.",
    addVariant: "Додати варіант",
    variantInheritedPrice: "як у товару · {{price}}",
    footerBasePrice: "Базова ціна",
    ...formChromeUk,
    variantSheetNewTitle: "Новий варіант",
    variantSheetEditTitle: "Редагувати варіант",
    variantSheetNameLabel: "Назва",
    variantSheetNamePlaceholder: "Наприклад, 2 кг або Ваніль",
    variantSheetCustomPrice: "Інша ціна",
    variantSheetCustomPriceDescription:
      "Якщо вимкнено — варіант бере базову ціну товару",
    variantSheetPriceLabel: "Ціна варіанту",
    variantSheetSave: "Зберегти",
    submitCreate: "Створити товар",
    submitCreateLoading: "Створюємо…",
    submitEditLoading: "Зберігаємо…",
    permissionCreateTitle: "Немає права",
    permissionCreateDescription: "Немає права створювати товари.",
    permissionEditTitle: "Немає права",
    permissionEditDescription: "Немає права змінювати цей товар.",
    errors: {
      nameRequired: "Вкажіть назву",
      nameTooLong: "Назва занадто довга",
      priceRequired: "Вкажіть ціну",
      priceInvalid: "Перевірте ціну",
      validation: "Перевірте поля і спробуйте ще раз.",
      network: "Помилка мережі. Перевірте з’єднання.",
      offline: "Немає зʼєднання. Підключіться і спробуйте ще раз.",
      unavailable: "Щось пішло не так. Спробуйте ще раз.",
      permission: "Немає права змінювати цей товар.",
      tooManyVariants: "Забагато варіантів. Максимум 100.",
    },
  },
  detail: {
    title: "Товар",
    loadingLabel: "Завантаження товару",
    offlineTitle: "Немає зʼєднання",
    offlineDescription:
      "Картка товару недоступна офлайн. Підключіться і спробуйте ще раз.",
    errorTitle: "Не вдалося завантажити товар",
    errorDescription: "Перевірте з’єднання та спробуйте ще раз.",
    retry: "Повторити",
    notFoundTitle: "Товар не знайдено",
    notFoundDescription: "Не вдалося знайти цей товар або він недоступний.",
    variantsTitle: "Варіанти",
    noPhotos: "Немає фото",
    photosLabel: "Фото",
    photosManageLabel: "Керувати фото",
    editLabel: "Редагувати",
    inheritedPrice: "Базова ціна",
    archiveProduct: "Архівувати товар",
    restoreProduct: "Відновити товар",
    archiveVariant: "Архівувати",
    restoreVariant: "Відновити",
    archiveVariantNamed: "Архівувати варіант «{{name}}»",
    restoreVariantNamed: "Відновити варіант «{{name}}»",
    productActionsTitle: "Дії з товаром",
    productActionsLabel: "Дії з товаром",
    variantActionsLabel: "Дії з варіантом «{{name}}»",
    statusActive: "Активний",
    factsTitle: "Основне",
    factStatus: "Статус",
    confirmArchiveProductTitle: "Архівувати товар?",
    confirmArchiveProductDescription:
      "Товар зникне з продажу. Статус варіантів не зміниться. Старі замовлення залишаться чинними.",
    confirmRestoreProductTitle: "Повернути товар?",
    confirmRestoreProductDescription: "Товар знову буде доступний для продажу.",
    confirmArchiveVariantTitle: "Архівувати варіант?",
    confirmArchiveVariantDescription:
      "Варіант «{{name}}» зникне з продажу. Статус товару не зміниться.",
    confirmRestoreVariantTitle: "Повернути варіант?",
    confirmRestoreVariantDescription:
      "Варіант «{{name}}» знову буде доступний для продажу.",
    cancel: "Скасувати",
    mutationError: "Не вдалося змінити статус. Спробуйте ще раз.",
    mutationOffline: "Немає зʼєднання. Підключіться і спробуйте ще раз.",
    mutationPermission: "Немає права змінювати цей товар.",
  },
  photos: {
    title: "Фото",
    heading: "Фото товару",
    count: "{{count}}/10",
    hint: "JPG, PNG або WebP · до 10 МБ · до 10 фото. Фото належать товару, не варіанту.",
    addLabel: "Додати фото",
    addCamera: "Камера",
    addLibrary: "Галерея",
    coverLabel: "Обкладинка",
    removeLabel: "Видалити фото",
    moveEarlier: "Перемістити ліворуч",
    moveLater: "Перемістити праворуч",
    retryLabel: "Повторити",
    cancelUpload: "Скасувати завантаження",
    uploadingLabel: "Завантаження",
    failedLabel: "Не вдалося завантажити",
    emptyTitle: "Немає фото",
    emptyDescription: "Додайте фото з камери або галереї.",
    pickTitle: "Додати фото",
    pickDescription: "Оберіть камеру або галерею.",
    permissionTitle: "Немає права",
    permissionDescription: "Немає права змінювати фото цього товару.",
    cameraDeniedTitle: "Немає доступу до камери",
    cameraDeniedDescription:
      "Дозвольте доступ до камери в налаштуваннях системи, щоб знімати фото товару.",
    libraryDeniedTitle: "Немає доступу до фото",
    libraryDeniedDescription:
      "Дозвольте доступ до фото в налаштуваннях системи, щоб додати зображення товару.",
    closeSheet: "Скасувати",
    errors: {
      network: "Помилка мережі. Перевірте з’єднання.",
      offline: "Немає зʼєднання. Підключіться і спробуйте ще раз.",
      unavailable: "Щось пішло не так. Спробуйте ще раз.",
      permission: "Немає права змінювати фото цього товару.",
      denied:
        "Немає доступу до камери / галереї. Дозвольте у налаштуваннях телефона.",
      validation: "Це зображення не можна додати. Спробуйте інше фото.",
      too_many: "Забагато фото. Максимум 10.",
      commit: "Не вдалося зберегти список фото. Спробуйте ще раз.",
    },
  },
};

export function sharedProductsCopy(locale: Locale): SharedProductsCopy {
  return selectCopy(locale, { uk, en });
}
