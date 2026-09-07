/**
 * Staff documents copy (SHO-479).
 *
 * Wholesale move of the mobile documents tree. Web has no documents
 * copy today — do not invent web strings here. Chrome spreads come
 * from `./chrome`. Do not import document, QES, or contract types.
 */
import {
  formChromeEn,
  formChromeUk,
  type FormChromeCopy,
  type WriteErrorsCopy,
} from "./chrome.js";
import { selectCopy, type Locale } from "./locale.js";

export type DocumentsFormCopy = Omit<
  FormChromeCopy,
  "changedLabel" | "submitEdit" | "submitEditLoading"
> & {
  readonly typeSectionTitle: string;
  readonly layoutSectionTitle: string;
  readonly basisSectionTitle: string;
  readonly orderSectionTitle: string;
  readonly counterpartySectionTitle: string;
  readonly typePaymentInvoice: string;
  readonly typeDeliveryNote: string;
  readonly layoutLoading: string;
  readonly layoutError: string;
  readonly layoutRetry: string;
  readonly layoutPreviewHint: string;
  readonly basisLabel: string;
  readonly basisPlaceholder: string;
  readonly orderLabel: string;
  readonly orderPlaceholder: string;
  readonly orderSheetTitle: string;
  readonly orderSearchPlaceholder: string;
  readonly orderSearchLabel: string;
  readonly orderEmpty: string;
  readonly orderMissingCustomer: string;
  readonly counterpartyLabel: string;
  readonly counterpartyPlaceholder: string;
  readonly counterpartyDisabledPlaceholder: string;
  readonly counterpartySheetTitle: string;
  readonly counterpartySearchPlaceholder: string;
  readonly counterpartySearchLabel: string;
  readonly counterpartyEmptyOption: string;
  readonly counterpartyEmpty: string;
  readonly permissionCreateTitle: string;
  readonly permissionCreateDescription: string;
  readonly loadingLabel: string;
  readonly errors: {
    readonly orderRequired: string;
    readonly layoutRequired: string;
    readonly basisTooLong: string;
    readonly conflict: string;
  } & WriteErrorsCopy;
};

export type DocumentsSharedCopy = {
  readonly title: string;
  readonly loadingLabel: string;
  readonly download: string;
  readonly downloadSigned: string;
  readonly refresh: string;
  readonly notFoundTitle: string;
  readonly notFoundDescription: string;
  readonly offlineTitle: string;
  readonly offlineDescription: string;
  readonly errorTitle: string;
  readonly errorDescription: string;
  readonly retry: string;
  readonly backLabel: string;
};

export type DocumentsMutationCopy = {
  readonly error: string;
  readonly offline: string;
  readonly permission: string;
};

export type DocumentsEmptyCopy = {
  readonly offlineTitle: string;
  readonly offlineDescription: string;
  readonly errorTitle: string;
  readonly errorDescription: string;
  readonly retry: string;
  readonly filteredTitle: string;
  readonly filteredDescription: string;
  readonly filteredOrderDescription: string;
  readonly filteredTypeAndOrderDescription: string;
  readonly reset: string;
  readonly catalogTitle: string;
  readonly catalogDescription: string;
  readonly create: string;
};

export type SharedDocumentsCopy = {
  readonly title: string;
  readonly createLabel: string;
  readonly backLabel: string;
  readonly optionsLabel: string;
  readonly optionsButton: string;
  readonly signButton: string;
  readonly signedBadge: string;
  readonly loadingLabel: string;
  readonly loadingMoreLabel: string;
  readonly cancelledBadge: string;
  readonly filters: {
    readonly all: string;
    readonly payment_invoice: string;
    readonly delivery_note: string;
  };
  readonly types: {
    readonly payment_invoice: string;
    readonly delivery_note: string;
  };
  readonly empty: DocumentsEmptyCopy;
  readonly options: {
    readonly share: string;
    readonly qr: string;
    readonly print: string;
    readonly openPdf: string;
    readonly sign: string;
    readonly cancel: string;
    readonly close: string;
  };
  readonly optionsGet: {
    readonly loading: string;
    readonly offline: string;
    readonly error: string;
  };
  readonly generation: {
    readonly pending: string;
    readonly ready: string;
    readonly failed: string;
  };
  readonly confirm: {
    readonly cancelTitle: string;
    readonly cancelDescription: string;
    readonly cancelConfirm: string;
    readonly signTitle: string;
    readonly signDescription: string;
    readonly signConfirm: string;
    readonly dismiss: string;
  };
  readonly handover: {
    readonly title: string;
    readonly copy: string;
    readonly copied: string;
    readonly copyFailed: string;
    readonly share: string;
    readonly hint: string;
    readonly close: string;
  };
  readonly toast: {
    readonly pdfNotReady: string;
    readonly pdfFailed: string;
    readonly pdfOpenFailed: string;
    readonly shareFailed: string;
    readonly signFailed: string;
    readonly keyInvalid: string;
  };
  readonly mutation: DocumentsMutationCopy;
  readonly form: DocumentsFormCopy;
  readonly shared: DocumentsSharedCopy;
  readonly signing: {
    readonly title: string;
    readonly hint: string;
    readonly lock: string;
    readonly pickKey: string;
    readonly pickKeyA11y: string;
    readonly passwordLabel: string;
    readonly passwordPlaceholder: string;
    readonly passwordA11y: string;
    readonly submit: string;
    readonly submitBusy: string;
    readonly close: string;
    readonly signedBadge: string;
    readonly pendingBadge: string;
    readonly banners: {
      readonly password: string;
      readonly validation: string;
      readonly permission: string;
      readonly network: string;
      readonly offline: string;
      readonly unavailable: string;
      readonly native: string;
      readonly key: string;
    };
  };
};

const enForm: DocumentsFormCopy = {
  typeSectionTitle: "Document type",
  layoutSectionTitle: "Look",
  basisSectionTitle: "Basis",
  orderSectionTitle: "Order",
  counterpartySectionTitle: "Counterparty",
  typePaymentInvoice: "Invoice РХ",
  typeDeliveryNote: "Delivery note ВН",
  layoutLoading: "Loading looks…",
  layoutError: "Could not load looks.",
  layoutRetry: "Retry",
  layoutPreviewHint: "Issued PDF look",
  basisLabel: "Basis",
  basisPlaceholder: "Agreement or reason (optional)",
  orderLabel: "Order",
  orderPlaceholder: "Choose an order",
  orderSheetTitle: "Order",
  orderSearchPlaceholder: "Search orders…",
  orderSearchLabel: "Search orders",
  orderEmpty: "No orders found.",
  orderMissingCustomer: "Deleted customer",
  counterpartyLabel: "Counterparty",
  counterpartyPlaceholder: "Optional — legal face",
  counterpartyDisabledPlaceholder: "Choose an order first",
  counterpartySheetTitle: "Counterparty",
  counterpartySearchPlaceholder: "Search counterparties…",
  counterpartySearchLabel: "Search counterparties",
  counterpartyEmptyOption: "Customer name only",
  counterpartyEmpty: "No counterparties for this customer.",
  ...formChromeEn,
  submitCreateLoading: "Creating…",
  permissionCreateTitle: "No permission",
  permissionCreateDescription:
    "You do not have permission to create documents.",
  loadingLabel: "Loading",
  errors: {
    orderRequired: "Choose an order.",
    layoutRequired: "Choose a look.",
    basisTooLong: "Basis must be 500 characters or fewer.",
    validation:
      "Could not create the document. Check the seller legal details, customer, and counterparty.",
    network: "Could not create the document. Try again.",
    offline: "No connection. Try again when you are online.",
    unavailable: "Could not create the document. Try again.",
    permission: "You do not have permission to create documents.",
    conflict:
      "A live document of this type already exists for the order, or the order is canceled.",
  },
};

const ukForm: DocumentsFormCopy = {
  typeSectionTitle: "Тип документа",
  layoutSectionTitle: "Вигляд",
  basisSectionTitle: "Підстава",
  orderSectionTitle: "Замовлення",
  counterpartySectionTitle: "Контрагент",
  typePaymentInvoice: "Рахунок РХ",
  typeDeliveryNote: "Видаткова ВН",
  layoutLoading: "Завантаження виглядів…",
  layoutError: "Не вдалося завантажити вигляди.",
  layoutRetry: "Повторити",
  layoutPreviewHint: "Вигляд виданого PDF",
  basisLabel: "Підстава",
  basisPlaceholder: "Договір або причина (необов’язково)",
  orderLabel: "Замовлення",
  orderPlaceholder: "Обрати замовлення",
  orderSheetTitle: "Замовлення",
  orderSearchPlaceholder: "Пошук замовлень…",
  orderSearchLabel: "Пошук замовлень",
  orderEmpty: "Замовлень не знайдено.",
  orderMissingCustomer: "Клієнт видалений",
  counterpartyLabel: "Контрагент",
  counterpartyPlaceholder: "Необов’язково — юрособа",
  counterpartyDisabledPlaceholder: "Спочатку оберіть замовлення",
  counterpartySheetTitle: "Контрагент",
  counterpartySearchPlaceholder: "Пошук контрагентів…",
  counterpartySearchLabel: "Пошук контрагентів",
  counterpartyEmptyOption: "Лише ім’я клієнта",
  counterpartyEmpty: "Для цього клієнта немає контрагентів.",
  ...formChromeUk,
  submitCreateLoading: "Створення…",
  permissionCreateTitle: "Немає права",
  permissionCreateDescription: "Немає права створювати документи.",
  loadingLabel: "Завантаження",
  errors: {
    orderRequired: "Оберіть замовлення.",
    layoutRequired: "Оберіть вигляд.",
    basisTooLong: "Підстава має бути не довша за 500 символів.",
    validation:
      "Не вдалося створити документ. Перевірте реквізити продавця, клієнта та контрагента.",
    network: "Не вдалося створити документ. Спробуйте ще раз.",
    offline: "Немає з’єднання. Спробуйте, коли з’явиться мережа.",
    unavailable: "Не вдалося створити документ. Спробуйте ще раз.",
    permission: "Немає права створювати документи.",
    conflict:
      "Живий документ цього типу для замовлення вже є, або замовлення скасовано.",
  },
};

const en: SharedDocumentsCopy = {
  title: "Documents",
  createLabel: "New document",
  backLabel: "Back",
  optionsLabel: "Options for {{number}}",
  optionsButton: "Options",
  signButton: "Sign",
  signedBadge: "Signed",
  loadingLabel: "Loading documents",
  loadingMoreLabel: "Loading more documents",
  cancelledBadge: "Cancelled",
  filters: {
    all: "All",
    payment_invoice: "Invoice",
    delivery_note: "Delivery note",
  },
  types: {
    payment_invoice: "Invoice",
    delivery_note: "Delivery note",
  },
  empty: {
    offlineTitle: "No connection",
    offlineDescription: "Check your network and try again.",
    errorTitle: "Could not load documents",
    errorDescription: "Try again in a moment.",
    retry: "Retry",
    filteredTitle: "Nothing found",
    filteredDescription: "Change the type filter.",
    filteredOrderDescription: "No documents for this order.",
    filteredTypeAndOrderDescription:
      "Change the type filter. Documents stay scoped to this order.",
    reset: "Reset",
    catalogTitle: "No documents yet",
    catalogDescription: "Create the first invoice or delivery note.",
    create: "New document",
  },
  options: {
    share: "Share",
    qr: "QR code",
    print: "Print",
    openPdf: "Open PDF",
    sign: "Sign",
    cancel: "Cancel document",
    close: "Close",
  },
  optionsGet: {
    loading: "Loading PDF status",
    offline: "No connection. Open PDF to retry.",
    error: "Could not load PDF status. Open PDF to retry.",
  },
  generation: {
    pending: "PDF pending",
    ready: "PDF ready",
    failed: "PDF failed",
  },
  confirm: {
    cancelTitle: "Cancel this document?",
    cancelDescription:
      "The document will move to Cancelled. The number stays consumed.",
    cancelConfirm: "Cancel document",
    signTitle: "Sign this document?",
    signDescription:
      "You will confirm a qualified electronic signature. The key stays on this device — confirmation does not replace key possession.",
    signConfirm: "Continue",
    dismiss: "Keep",
  },
  handover: {
    title: "Document link",
    copy: "Copy link",
    copied: "Copied",
    copyFailed: "Could not copy the link.",
    share: "Share",
    hint: "Send this link. The counterparty does not need a Showzy account.",
    close: "Close",
  },
  toast: {
    pdfNotReady: "The PDF is not ready yet. Try again in a moment.",
    pdfFailed: "The PDF could not be generated.",
    pdfOpenFailed: "Could not open the PDF.",
    shareFailed: "Could not create a share link.",
    signFailed: "Could not sign the document. Try again.",
    keyInvalid: "Choose a Key-6.dat, .pfx, .p12, .pk8, or .jks file.",
  },
  mutation: {
    error: "Could not update the document. Try again.",
    offline: "No connection. Try again when you are online.",
    permission: "You do not have permission to change documents.",
  },
  form: enForm,
  shared: {
    title: "Document",
    loadingLabel: "Loading document",
    download: "Download PDF",
    downloadSigned: "Download signed file",
    refresh:
      "The file is not ready or the download expired. Ask the sender to refresh the link.",
    notFoundTitle: "Link is not valid",
    notFoundDescription: "This link is invalid or has expired.",
    offlineTitle: "No connection",
    offlineDescription: "Check your network and try again.",
    errorTitle: "Could not open the document",
    errorDescription: "Try again in a moment.",
    retry: "Retry",
    backLabel: "Back",
  },
  signing: {
    title: "Sign document",
    hint: "Choose a qualified-signature key (Key-6.dat, .pfx, .p12, .pk8, .jks) to sign this document.",
    lock: "The key is processed only on this device and is never sent to the server.",
    pickKey: "Choose key file",
    pickKeyA11y: "Choose key file",
    passwordLabel: "Key password",
    passwordPlaceholder: "Enter the key container password",
    passwordA11y: "Key password",
    submit: "Sign",
    submitBusy: "Signing…",
    close: "Close",
    signedBadge: "Signed",
    pendingBadge: "Signature pending",
    banners: {
      password: "The key password is incorrect.",
      validation: "Could not sign this document. Check the PDF and try again.",
      permission: "You do not have permission to sign documents.",
      network: "Could not sign the document. Try again.",
      offline: "No connection. Try again when you are online.",
      unavailable: "Could not sign the document. Try again.",
      native: "Signing needs the native app rebuild that includes Nitro.",
      key: "Choose a Key-6.dat, .pfx, .p12, .pk8, or .jks file.",
    },
  },
};

const uk: SharedDocumentsCopy = {
  title: "Документи",
  createLabel: "Новий документ",
  backLabel: "Назад",
  optionsLabel: "Опції для {{number}}",
  optionsButton: "Опції",
  signButton: "Підписати",
  signedBadge: "Підписано",
  loadingLabel: "Завантаження документів",
  loadingMoreLabel: "Завантаження наступної сторінки",
  cancelledBadge: "Скасовано",
  filters: {
    all: "Усі",
    payment_invoice: "Рахунок",
    delivery_note: "Видаткова",
  },
  types: {
    payment_invoice: "Рахунок",
    delivery_note: "Видаткова",
  },
  empty: {
    offlineTitle: "Немає з’єднання",
    offlineDescription: "Перевірте мережу і спробуйте ще раз.",
    errorTitle: "Не вдалося завантажити документи",
    errorDescription: "Спробуйте ще раз за мить.",
    retry: "Повторити",
    filteredTitle: "Нічого не знайдено",
    filteredDescription: "Змініть фільтр типу.",
    filteredOrderDescription: "Для цього замовлення документів немає.",
    filteredTypeAndOrderDescription:
      "Змініть фільтр типу. Список залишиться в межах цього замовлення.",
    reset: "Скинути",
    catalogTitle: "Документів ще немає",
    catalogDescription: "Створіть перший рахунок або видаткову накладну.",
    create: "Новий документ",
  },
  options: {
    share: "Поділитися",
    qr: "QR-код",
    print: "Друк",
    openPdf: "Відкрити PDF",
    sign: "Підписати",
    cancel: "Скасувати документ",
    close: "Закрити",
  },
  optionsGet: {
    loading: "Завантаження статусу PDF",
    offline: "Немає з’єднання. Відкрийте PDF, щоб повторити.",
    error: "Не вдалося завантажити статус PDF. Відкрийте PDF, щоб повторити.",
  },
  generation: {
    pending: "PDF готується",
    ready: "PDF готовий",
    failed: "PDF не вдалося створити",
  },
  confirm: {
    cancelTitle: "Скасувати документ?",
    cancelDescription:
      "Документ змінить статус на «Скасовано». Номер залишиться використаним.",
    cancelConfirm: "Скасувати документ",
    signTitle: "Підписати документ?",
    signDescription:
      "Ви підтвердите кваліфікований електронний підпис. Ключ залишиться на цьому пристрої — підтвердження не замінює володіння ключем.",
    signConfirm: "Продовжити",
    dismiss: "Залишити",
  },
  handover: {
    title: "Посилання на документ",
    copy: "Копіювати посилання",
    copied: "Скопійовано",
    copyFailed: "Не вдалося скопіювати посилання.",
    share: "Поділитися",
    hint: "Надішліть це посилання. Контрагенту не потрібен акаунт Showzy.",
    close: "Закрити",
  },
  toast: {
    pdfNotReady: "PDF ще не готовий. Спробуйте пізніше.",
    pdfFailed: "Не вдалося згенерувати PDF.",
    pdfOpenFailed: "Не вдалося відкрити PDF.",
    shareFailed: "Не вдалося створити посилання.",
    signFailed: "Не вдалося підписати документ. Спробуйте ще раз.",
    keyInvalid: "Оберіть файл Key-6.dat, .pfx, .p12, .pk8 або .jks.",
  },
  mutation: {
    error: "Не вдалося оновити документ. Спробуйте ще раз.",
    offline: "Немає з’єднання. Спробуйте, коли з’явиться мережа.",
    permission: "У вас немає дозволу змінювати документи.",
  },
  form: ukForm,
  shared: {
    title: "Документ",
    loadingLabel: "Завантаження документа",
    download: "Завантажити PDF",
    downloadSigned: "Завантажити підписаний файл",
    refresh:
      "Файл ще не готовий або строк завантаження минув. Попросіть відправника оновити посилання.",
    notFoundTitle: "Посилання недійсне",
    notFoundDescription: "Посилання недійсне або строк його дії минув.",
    offlineTitle: "Немає з’єднання",
    offlineDescription: "Перевірте мережу і спробуйте ще раз.",
    errorTitle: "Не вдалося відкрити документ",
    errorDescription: "Спробуйте ще раз за мить.",
    retry: "Повторити",
    backLabel: "Назад",
  },
  signing: {
    title: "Підписання документа",
    hint: "Завантажте ключ електронного підпису (Key-6.dat, .pfx, .p12, .pk8, .jks) для підписання цього документа.",
    lock: "Ключ обробляється лише на цьому пристрої і ніколи не надсилається на сервер.",
    pickKey: "Обрати файл ключа",
    pickKeyA11y: "Обрати файл ключа",
    passwordLabel: "Пароль ключа",
    passwordPlaceholder: "Введіть пароль ключового контейнера",
    passwordA11y: "Пароль ключа",
    submit: "Підписати",
    submitBusy: "Підписання…",
    close: "Закрити",
    signedBadge: "Підписано",
    pendingBadge: "Очікує підпис",
    banners: {
      password: "Неправильний пароль ключа.",
      validation:
        "Не вдалося підписати документ. Перевірте PDF і спробуйте ще раз.",
      permission: "Немає права підписувати документи.",
      network: "Не вдалося підписати документ. Спробуйте ще раз.",
      offline: "Немає з’єднання. Спробуйте, коли з’явиться мережа.",
      unavailable: "Не вдалося підписати документ. Спробуйте ще раз.",
      native: "Підписання потребує нативного застосунку з Nitro.",
      key: "Оберіть файл Key-6.dat, .pfx, .p12, .pk8 або .jks.",
    },
  },
};

export function sharedDocumentsCopy(locale: Locale): SharedDocumentsCopy {
  return selectCopy(locale, { uk, en });
}
