/** Customers list + confirm + empty copy (uk/en). Wholesale mobile tree (SHO-476). */
import type { CountForms } from "../plural.js";

export type CustomersCountForms = CountForms;

export type CustomersMutationCopy = {
  readonly error: string;
  readonly offline: string;
  readonly permission: string;
};

export type CustomersConfirmCopy = {
  readonly archiveTitle: string;
  readonly archiveDescription: string;
  readonly archiveConfirm: string;
  readonly deleteTitle: string;
  readonly deleteDescription: string;
  readonly deleteConfirm: string;
  readonly deleteGroupTitle: string;
  readonly deleteGroupDescription: CustomersCountForms;
  readonly deleteGroupDescriptionEmpty: string;
  readonly deleteGroupConfirm: string;
  readonly deleteCounterpartyTitle: string;
  readonly deleteCounterpartyDescription: string;
  readonly deleteCounterpartyConfirm: string;
  readonly revokeInviteTitle: string;
  readonly revokeInviteDescription: string;
  readonly revokeInviteConfirm: string;
  readonly cancel: string;
};

export type CustomersEmptyCopy = {
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
  readonly showArchived: string;
  readonly groupsTitle: string;
  readonly groupsDescription: string;
  readonly groupsSearchTitle: string;
  readonly groupsSearchDescription: string;
  readonly groupsCreate: string;
  readonly counterpartiesTitle: string;
  readonly counterpartiesDescription: string;
  readonly counterpartiesSearchTitle: string;
  readonly counterpartiesSearchDescription: string;
  readonly counterpartiesCreate: string;
  readonly invitationsTitle: string;
  readonly invitationsDescription: string;
  readonly invitationsCreate: string;
};

export type CustomersInviteStatusCopy = {
  readonly pending: string;
  readonly revoked: string;
  readonly expired: string;
  readonly exhausted: string;
};

export type CustomersEditorStubCopy = {
  readonly clientCreateTitle: string;
  readonly clientEditTitle: string;
  readonly groupCreateTitle: string;
  readonly groupEditTitle: string;
  readonly counterpartyCreateTitle: string;
  readonly counterpartyEditTitle: string;
  readonly invitationCreateTitle: string;
};

export type CustomersListCopy = {
  readonly title: string;
  readonly searchLabel: string;
  readonly clientsSearchPlaceholder: string;
  readonly groupsSearchPlaceholder: string;
  readonly counterpartiesSearchPlaceholder: string;
  readonly createClientLabel: string;
  readonly createGroupLabel: string;
  readonly createCounterpartyLabel: string;
  readonly createInviteLabel: string;
  readonly backLabel: string;
  readonly tabs: {
    readonly clients: string;
    readonly groups: string;
    readonly counterparties: string;
    readonly invitations: string;
  };
  readonly filters: {
    readonly all: string;
    readonly archived: string;
  };
  readonly archivedBadge: string;
  readonly editLabel: string;
  readonly archiveLabel: string;
  readonly deleteLabel: string;
  readonly restoreLabel: string;
  readonly revokeLabel: string;
  readonly loadingLabel: string;
  readonly loadingMoreLabel: string;
  readonly edrpouBadge: string;
  readonly counterparties: CustomersCountForms;
  readonly members: CustomersCountForms;
  readonly inviteStatus: CustomersInviteStatusCopy;
  readonly inviteUses: string;
  readonly inviteUsesUnlimited: string;
  readonly inviteExpires: string;
  readonly inviteExpired: string;
  readonly inviteUntitledReusable: string;
  readonly inviteUntitledPersonal: string;
  readonly empty: CustomersEmptyCopy;
  readonly confirm: CustomersConfirmCopy;
  readonly mutation: CustomersMutationCopy;
  readonly editorStub: CustomersEditorStubCopy;
};

export const en: CustomersListCopy = {
  title: "Customers",
  searchLabel: "Search",
  clientsSearchPlaceholder: "Name, phone, or email",
  groupsSearchPlaceholder: "Group name",
  counterpartiesSearchPlaceholder: "Name or EDRPOU",
  createClientLabel: "New client",
  createGroupLabel: "New group",
  createCounterpartyLabel: "New counterparty",
  createInviteLabel: "New invitation",
  backLabel: "Back",
  tabs: {
    clients: "Clients",
    groups: "Groups",
    counterparties: "Counterparties",
    invitations: "Invitations",
  },
  filters: {
    all: "All",
    archived: "Archive",
  },
  archivedBadge: "Archived",
  editLabel: "Edit",
  archiveLabel: "Archive {{name}}",
  deleteLabel: "Delete {{name}}",
  restoreLabel: "Restore",
  revokeLabel: "Revoke {{name}}",
  loadingLabel: "Loading customers",
  loadingMoreLabel: "Loading more",
  edrpouBadge: "EDRPOU {{edrpou}}",
  counterparties: {
    one: "{{count}} counterparty",
    few: "{{count}} counterparties",
    many: "{{count}} counterparties",
  },
  members: {
    one: "{{count}} client",
    few: "{{count}} clients",
    many: "{{count}} clients",
  },
  inviteStatus: {
    pending: "Active",
    revoked: "Revoked",
    expired: "Expired",
    exhausted: "Exhausted",
  },
  inviteUses: "Used {{used}} of {{max}}",
  inviteUsesUnlimited: "Used {{used}} (unlimited)",
  inviteExpires: "Valid until {{date}}",
  inviteExpired: "Ended {{date}}",
  inviteUntitledReusable: "Reusable invite",
  inviteUntitledPersonal: "Invitation",
  empty: {
    offlineTitle: "No connection",
    offlineDescription:
      "The customer list is unavailable offline. Connect and try again.",
    errorTitle: "Could not load customers",
    errorDescription: "Check your connection and try again.",
    retry: "Retry",
    searchTitle: "Nothing found",
    searchDescription: "Change the query or reset the filters.",
    reset: "Reset",
    archivedTitle: "The archive is empty",
    archivedDescription: "Archive first, then delete. Delete is archive-only.",
    catalogTitle: "No clients yet",
    catalogDescription: "Add the first client to speed up order checkout.",
    create: "New client",
    activeTitle: "No active clients",
    activeDescription: "Restore a client from the archive or view the archive.",
    showArchived: "Show archive",
    groupsTitle: "No groups yet",
    groupsDescription:
      "Groups segment clients only. A group's price list is inherited when the client has none.",
    groupsSearchTitle: "No groups found",
    groupsSearchDescription: "Try a different query.",
    groupsCreate: "New group",
    counterpartiesTitle: "No counterparties yet",
    counterpartiesDescription:
      "A legal face for invoices and QES. It can stand alone — for example a supplier — without a CRM client.",
    counterpartiesSearchTitle: "No counterparties found",
    counterpartiesSearchDescription: "Try a different query.",
    counterpartiesCreate: "New counterparty",
    invitationsTitle: "No invitations yet",
    invitationsDescription:
      "Links for customers. After accept, a CRM client appears with the group and price list.",
    invitationsCreate: "New invitation",
  },
  confirm: {
    archiveTitle: "Archive this client?",
    archiveDescription:
      "Archive first, then delete. The client leaves the active list. Orders stay. Delete is only available from the archive.",
    archiveConfirm: "Archive",
    deleteTitle: "Delete this client?",
    deleteDescription:
      "The client will be deleted forever. Counterparties stay unlinked. This cannot be undone.",
    deleteConfirm: "Delete",
    deleteGroupTitle: "Delete this group?",
    deleteGroupDescription: {
      one: "{{count}} client will stay with no group. Their price lists do not change.",
      few: "{{count}} clients will stay with no group. Their price lists do not change.",
      many: "{{count}} clients will stay with no group. Their price lists do not change.",
    },
    deleteGroupDescriptionEmpty:
      "The group will be deleted. Clients are not removed.",
    deleteGroupConfirm: "Delete group",
    deleteCounterpartyTitle: "Delete this counterparty?",
    deleteCounterpartyDescription:
      "The counterparty will be deleted forever. A linked client stays. This cannot be undone.",
    deleteCounterpartyConfirm: "Delete counterparty",
    revokeInviteTitle: "Revoke this invitation?",
    revokeInviteDescription:
      "The invite link will stop working. The row stays in invitation history.",
    revokeInviteConfirm: "Revoke",
    cancel: "Cancel",
  },
  mutation: {
    error: "Could not update. Try again.",
    offline: "No connection. Connect and try again.",
    permission: "You do not have permission to change this.",
  },
  editorStub: {
    clientCreateTitle: "New client",
    clientEditTitle: "Edit client",
    groupCreateTitle: "New group",
    groupEditTitle: "Edit group",
    counterpartyCreateTitle: "New counterparty",
    counterpartyEditTitle: "Edit counterparty",
    invitationCreateTitle: "Create invitation",
  },
};

export const uk: CustomersListCopy = {
  title: "Клієнти",
  searchLabel: "Пошук",
  clientsSearchPlaceholder: "Ім’я, телефон або email",
  groupsSearchPlaceholder: "Назва групи",
  counterpartiesSearchPlaceholder: "Назва або ЄДРПОУ",
  createClientLabel: "Новий клієнт",
  createGroupLabel: "Нова група",
  createCounterpartyLabel: "Новий контрагент",
  createInviteLabel: "Нове запрошення",
  backLabel: "Назад",
  tabs: {
    clients: "Клієнти",
    groups: "Групи",
    counterparties: "Контрагенти",
    invitations: "Запрошення",
  },
  filters: {
    all: "Усі",
    archived: "Архів",
  },
  archivedBadge: "В архіві",
  editLabel: "Редагувати",
  archiveLabel: "Архівувати {{name}}",
  deleteLabel: "Видалити {{name}}",
  restoreLabel: "Відновити",
  revokeLabel: "Відкликати {{name}}",
  loadingLabel: "Завантаження клієнтів",
  loadingMoreLabel: "Завантаження наступних",
  edrpouBadge: "ЄДРПОУ {{edrpou}}",
  counterparties: {
    one: "{{count}} контрагент",
    few: "{{count}} контрагенти",
    many: "{{count}} контрагентів",
  },
  members: {
    one: "{{count}} клієнт",
    few: "{{count}} клієнти",
    many: "{{count}} клієнтів",
  },
  inviteStatus: {
    pending: "Активне",
    revoked: "Відкликане",
    expired: "Протерміноване",
    exhausted: "Вичерпане",
  },
  inviteUses: "Використано {{used}} з {{max}}",
  inviteUsesUnlimited: "Використано {{used}} (без ліміту)",
  inviteExpires: "Діє до {{date}}",
  inviteExpired: "Завершилось {{date}}",
  inviteUntitledReusable: "Спільне посилання",
  inviteUntitledPersonal: "Запрошення",
  empty: {
    offlineTitle: "Немає зʼєднання",
    offlineDescription:
      "Список клієнтів недоступний офлайн. Підключіться і спробуйте ще раз.",
    errorTitle: "Не вдалося завантажити клієнтів",
    errorDescription: "Перевірте з’єднання та спробуйте ще раз.",
    retry: "Повторити",
    searchTitle: "Нічого не знайдено",
    searchDescription: "Змініть запит або скиньте фільтри.",
    reset: "Скинути",
    archivedTitle: "Архів порожній",
    archivedDescription:
      "Спочатку архів, потім видалення. Видалити можна лише з архіву.",
    catalogTitle: "Клієнтів ще немає",
    catalogDescription:
      "Додайте першого клієнта, щоб швидше оформлювати замовлення.",
    create: "Новий клієнт",
    activeTitle: "Активних клієнтів немає",
    activeDescription: "Поверніть клієнта з архіву або відкрийте архів.",
    showArchived: "Показати архів",
    groupsTitle: "Груп ще немає",
    groupsDescription:
      "Групи сегментують лише клієнтів. Прайс групи успадковується, якщо в клієнта немає власного.",
    groupsSearchTitle: "Групи не знайдено",
    groupsSearchDescription: "Спробуйте інший запит.",
    groupsCreate: "Нова група",
    counterpartiesTitle: "Контрагентів ще немає",
    counterpartiesDescription:
      "Юрособа для рахунків і КЕП. Може бути без клієнта — наприклад, постачальник.",
    counterpartiesSearchTitle: "Контрагентів не знайдено",
    counterpartiesSearchDescription: "Спробуйте інший запит.",
    counterpartiesCreate: "Новий контрагент",
    invitationsTitle: "Запрошень ще немає",
    invitationsDescription:
      "Посилання для клієнтів. Після прийняття з’явиться клієнт у CRM з групою та прайсом.",
    invitationsCreate: "Нове запрошення",
  },
  confirm: {
    archiveTitle: "Архівувати клієнта?",
    archiveDescription:
      "Спочатку архів, потім видалення. Клієнт зникне з активного списку. Замовлення залишаться. Видалити можна буде лише з архіву.",
    archiveConfirm: "Архівувати",
    deleteTitle: "Видалити клієнта?",
    deleteDescription:
      "Клієнта буде видалено назавжди. Контрагенти залишаться без прив’язки. Цю дію не можна скасувати.",
    deleteConfirm: "Видалити",
    deleteGroupTitle: "Видалити групу?",
    deleteGroupDescription: {
      one: "{{count}} клієнт залишиться без групи. Їхні прайс-листи не зміняться.",
      few: "{{count}} клієнти залишаться без групи. Їхні прайс-листи не зміняться.",
      many: "{{count}} клієнтів залишаться без групи. Їхні прайс-листи не зміняться.",
    },
    deleteGroupDescriptionEmpty:
      "Групу буде видалено. Клієнти не постраждають.",
    deleteGroupConfirm: "Видалити групу",
    deleteCounterpartyTitle: "Видалити контрагента?",
    deleteCounterpartyDescription:
      "Контрагента буде видалено назавжди. Клієнт (якщо був прив’язаний) залишиться. Цю дію не можна скасувати.",
    deleteCounterpartyConfirm: "Видалити контрагента",
    revokeInviteTitle: "Відкликати запрошення?",
    revokeInviteDescription:
      "Посилання перестане працювати, але запис залишиться в історії запрошень.",
    revokeInviteConfirm: "Відкликати",
    cancel: "Скасувати",
  },
  mutation: {
    error: "Не вдалося оновити. Спробуйте ще раз.",
    offline: "Немає зʼєднання. Підключіться і спробуйте ще раз.",
    permission: "Немає права змінювати цей запис.",
  },
  editorStub: {
    clientCreateTitle: "Новий клієнт",
    clientEditTitle: "Редагувати клієнта",
    groupCreateTitle: "Нова група",
    groupEditTitle: "Редагувати групу",
    counterpartyCreateTitle: "Новий контрагент",
    counterpartyEditTitle: "Редагувати контрагента",
    invitationCreateTitle: "Нове запрошення",
  },
};
