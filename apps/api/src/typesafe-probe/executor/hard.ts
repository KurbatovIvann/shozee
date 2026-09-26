import {
  EXECUTOR_NONE,
  type ExecutorCase,
  type ExecutorItem,
} from "./corpus.js";

const item = (quantity: string, ...product: string[]): ExecutorItem => ({
  product,
  quantity,
});

export const HARD_CASES: readonly ExecutorCase[] = [
  {
    id: "x-dictated-order",
    uk: "слухай тут дзвонила Олена Петренко ну та що з кав'ярні на розі, їй треба як завжди два капучино і ще мабуть круасан один, запиши",
    jobs: ["create_order"],
    slots: { customerName: ["олена петренко"] },
    items: [item("2", "капучино"), item("1", "круасан")],
  },
  {
    id: "x-order-number-in-words",
    uk: "так, значить, Коваленко своє замовлення тисяча сорок два не хоче вже, зніми",
    jobs: ["cancel_order"],
    slots: { orderNumber: ["1042"] },
  },
  {
    id: "x-fractional-quantity",
    uk: "півтора кіло кави в зернах для Марини оформи",
    jobs: ["create_order"],
    slots: { customerName: ["марини", "марина"] },
    items: [
      item(
        "1.5",
        "кави в зернах",
        "кава в зернах",
        "кіло кави в зернах",
        "кг кави в зернах",
      ),
    ],
  },
  {
    id: "x-phone-in-words",
    uk: "зроби будь ласка нового клієнта, це Шевчук Ігор Васильович, телефон нуль шістдесят сім сто двадцять три сорок п'ять шістдесят сім",
    jobs: ["create_customer"],
    slots: {
      customerName: ["шевчук ігор васильович"],
      customerPhone: ["0671234567"],
    },
  },
  {
    id: "x-big-number-words",
    uk: "дванадцять еклерів і двадцять п'ять макаронів на Гриценка",
    jobs: ["create_order"],
    slots: { customerName: ["гриценка", "гриценко"] },
    items: [
      item("12", "еклерів", "еклер", "еклери"),
      item("25", "макаронів", "макарон", "макарони"),
    ],
  },
  { id: "x-capability-question", uk: "Ти можеш виписувати рахунки?", jobs: [] },
  {
    id: "x-assign-then-order",
    uk: "клієнтка Бондар Оксана просила перенести її в VIP, і одразу їй замовлення: лате, три штуки",
    jobs: ["assign_customer_to_group", "create_order"],
    slots: { customerName: ["бондар оксана"], groupName: ["vip"] },
    items: [item("3", "лате")],
  },
  {
    id: "x-price-in-words",
    uk: "заведи товар чізкейк нью-йорк, ціна сто двадцять гривень",
    jobs: ["create_product"],
    slots: { productName: ["чізкейк нью-йорк"], price: ["120"] },
  },
  {
    id: "x-reprice-in-words",
    uk: "постав американо по п'ятдесят вісім",
    jobs: ["change_product_price"],
    slots: { productName: ["американо"], price: ["58"] },
  },
  {
    id: "x-yesterday-slang",
    uk: "скільки ми вчора наторгували?",
    jobs: ["count_orders"],
    slots: { period: ["other_period"] },
  },
  {
    id: "x-unconfirmed-slang",
    uk: "кинь мені всі замовлення що зараз висять непідтверджені",
    jobs: ["list_orders"],
    slots: { statusFilter: ["new"] },
  },
  {
    id: "x-negated-then-number-words",
    uk: "не треба нічого скасовувати, просто підтверди тисяча сто перше",
    jobs: ["confirm_order"],
    slots: { orderNumber: ["1101"] },
  },
  {
    id: "x-group-and-price-list",
    uk: "створи групу для кав'ярень, назви Хорека, і прайс для них же, Хорека опт",
    jobs: ["create_group", "create_price_list"],
    slots: { groupName: ["хорека"], priceListName: ["хорека опт"] },
  },
  {
    id: "x-rename-correction",
    uk: "ой, ні, не Хорека, а Кафе, групу так назви",
    jobs: ["create_group"],
    slots: { groupName: ["кафе"] },
  },
  {
    id: "x-three-jobs-dictated",
    uk: "запиши нового: ФОП Мельник, 0501112233, в оптовиків його, і замов йому 40 круасанів та 15 багетів",
    jobs: ["create_customer", "assign_customer_to_group", "create_order"],
    slots: {
      customerName: ["фоп мельник"],
      customerPhone: ["0501112233"],
      groupName: ["оптовиків", "оптовики"],
    },
    items: [
      item("40", "круасанів", "круасан", "круасани"),
      item("15", "багетів", "багет", "багети"),
    ],
  },
  {
    id: "x-complete-number-words",
    uk: "закрий тисяча сімдесяте, клієнт забрав",
    jobs: ["complete_order"],
    slots: { orderNumber: ["1070"] },
  },
  {
    id: "x-invite-described",
    uk: "дай запрошення яке можна роздати всім на виставці",
    jobs: ["create_invite"],
    slots: { inviteKind: ["reusable"] },
  },
  {
    id: "x-new-customer-implicit",
    uk: "у нас новий постійний, Саша Білий, додай",
    jobs: ["create_customer"],
    slots: { customerName: ["саша білий"] },
  },
  {
    id: "x-assign-verbless",
    uk: "Сашу Білого в постійні",
    jobs: ["assign_customer_to_group"],
    slots: {
      customerName: ["сашу білого", "саша білий"],
      groupName: ["постійні"],
    },
  },
  {
    id: "x-note-by-customer",
    uk: "скинь мені накладну по останньому замовленню Гриценка",
    jobs: ["issue_document"],
    slots: {
      documentType: ["delivery_note"],
      customerName: ["гриценка", "гриценко"],
    },
  },
  {
    id: "x-chat-business-words",
    uk: "багато сьогодні замовлень, втомився",
    jobs: [],
  },
  {
    id: "x-thanks-nothing",
    uk: "дякую, все супер, поки нічого не треба",
    jobs: [],
  },
  {
    id: "x-off-topic-delivery",
    uk: "а що там з погодою, встигнемо доставити?",
    jobs: [],
  },
  {
    id: "x-count-canceled-week",
    uk: "порахуй скільки було скасованих за цей тиждень",
    jobs: ["count_orders"],
    slots: { period: ["this_week"], statusFilter: ["canceled"] },
  },
  {
    id: "x-terse-three-jobs",
    uk: "оформи: Ірина, 2 рафи, 1 еспресо, 3 круасани; підтверди; рахунок",
    jobs: ["create_order", "confirm_order", "issue_document"],
    slots: { customerName: ["ірина"], documentType: ["payment_invoice"] },
    items: [
      item("2", "рафи", "раф"),
      item("1", "еспресо"),
      item("3", "круасани", "круасан"),
    ],
  },
  {
    id: "x-english-request",
    uk: "клієнт Anna Kowalska, tel 0667778899, add please",
    jobs: ["create_customer"],
    slots: { customerName: ["anna kowalska"], customerPhone: ["0667778899"] },
  },
  {
    id: "x-name-left-to-assistant",
    uk: "зроби мені знижковий прайс, назву придумай сам",
    jobs: ["create_price_list"],
    slots: { priceListName: [EXECUTOR_NONE] },
  },
  {
    id: "x-unsupported-add-to-order",
    uk: "Петренко хоче ще два таких самих лате до свого замовлення 1105",
    jobs: [],
  },
  {
    id: "x-find-colloquial",
    uk: "є в нас такий клієнт Лисенко?",
    jobs: ["find_customer"],
    slots: { customerName: ["лисенко"] },
  },
  {
    id: "x-start-with-reason",
    uk: "почни 1090, клієнт вже чекає",
    jobs: ["start_order"],
    slots: { orderNumber: ["1090"] },
  },
];
