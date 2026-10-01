export const COMMAND_CONNECTORS: ReadonlySet<string> = new Set(["і", "й", "та", "и", "а", "потім", "потом", "ще", "еще", "заодно", "ну", "також", "затем"]);

// D81: the words that join a second command to the first («… і створи для нього замовлення», «… потім підтверди», «… а також додай»): a verb of
// COMMAND_VERBS said right after one of these (or after «а також», «а потім») may start a command the segmenter left inside the first.
export const CUE_CONNECTORS: ReadonlySet<string> = new Set(["і", "й", "та", "и", "потім", "потом", "затем", "також", "также"]);

// D81: verbs that open a staff command, uk and ru, as said (imperative, infinitive, the «-ть» a recogniser writes for «-ти»). Only a cue for a command
// left over: the rule never cuts where the command before holds a param said after the verb.
export const COMMAND_VERBS: ReadonlySet<string> = new Set([
  // create, register («зроби» / «сделай» are not: «і зроби його основним», «і зроби Z-звіт» say more of the same command)
  "створи", "створіть", "створити", "створить", "создай", "создайте", "создать", "оформи", "оформіть", "оформити", "оформить", "оформь", "заведи", "заведіть", "завести",
  // add
  "додай", "додайте", "додати", "добав", "добавь", "добавьте", "добавить", "внеси", "внесіть", "внести",
  // confirm
  "підтверди", "підтвердь", "підтвердіть", "підтвердити", "підтвердить", "подтверди", "подтвердите", "подтвердить",
  // send, invoice, receipt
  "відправ", "відправте", "відправити", "відправить", "отправь", "отправьте", "отправить", "надішли", "надішліть", "надіслати", "скинь", "скиньте",
  "вишли", "вийшли", "вышли", "пошли", "вистав", "виставте", "виставити", "выстави", "выставь", "выставить", "пробий", "пробийте", "пробити", "пробей",
  // cancel, delete, archive
  "скасуй", "скасуйте", "скасувати", "отмени", "отмените", "отменить", "видали", "видаліть", "видалити", "удали", "удалите", "удалить",
  "архівуй", "заархівуй", "архивируй", "заархивируй",
  // change, move
  "онови", "оновіть", "оновити", "обнови", "обновите", "обновить", "зміни", "змініть", "змінити", "измени", "измените", "изменить", "поміняй",
  "поменяй", "переведи", "переведіть", "перенеси",
  // show
  "покажи", "покажіть", "показати", "відкрий", "відкрийте", "открой", "откройте",
]);

// D95 (Q2 of the v3.5 served report): «зроби» / «сделай», left out of COMMAND_VERBS («і зроби його основним», «і зроби Z-звіт» say more of the same
// command), are a cue only after a connector and before a product the command does not hold, when it holds none («створи клієнта … і зроби для неї
// замовлення два торти»): an order said after the first command (`leftover.ts`).
export const WEAK_COMMAND_VERBS: ReadonlySet<string> = new Set(["зроби", "зробіть", "зробити", "зробить", "сделай", "сделайте", "сделать"]);

// D81: the verbs of COMMAND_VERBS that are a whole command said alone at the end («… і підтверди», «… і скасуй»: the record is the one just named); an
// «і додай», «і створи» said last with nothing after it is a phrase left unfinished, not a command.
export const BARE_COMMAND_VERBS: ReadonlySet<string> = new Set([
  "підтверди", "підтвердь", "підтвердіть", "підтвердити", "підтвердить", "подтверди", "подтвердите", "подтвердить",
  "відправ", "відправте", "відправити", "відправить", "отправь", "отправьте", "отправить", "надішли", "надішліть", "надіслати", "вишли", "вийшли", "вышли",
  "вистав", "виставте", "виставити", "выстави", "выставь", "выставить", "пробий", "пробийте", "пробити", "пробей",
  "скасуй", "скасуйте", "скасувати", "отмени", "отмените", "отменить", "видали", "видаліть", "видалити", "удали", "удалите", "удалить",
  "архівуй", "заархівуй", "архивируй", "заархивируй",
]);
