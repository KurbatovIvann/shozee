/**
 * Bilingual product map shared by the mode classifier and the Shozik
 * system prompt. Action names stay English; staff messages are often
 * Ukrainian. Keep this the single translation table — do not fork a
 * second list in gate.ts or system-prompt.ts.
 */
export const STAFF_ASSISTANT_PRODUCT_GLOSSARY = `orders — замовлення, заказ
customers — клієнти, контрагенти; a person's name (Леха) is often a customer
catalog — товари, номенклатура, каталог
pricing — прайс, прайс-лист, прайс лист, ціни, націнка, знижка, «на N% дешевше/нижчі»
documents — документи, накладна, рахунок
files — файли, фото товарів
invites — запрошення, співробітники
company — компанія, ФОП, реквізити`;
