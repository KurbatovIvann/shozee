// D79: the words that say a group or a price list is named next («переведи … в групу установи», «запрошення для салонів», «поло … з опту прибери»).
// Lowercase, as the normalised text writes them.

// A group said as one: «в групу установи», «групі салони», ru «в группу геймеры».
export const GROUP_NOUNS: ReadonlySet<string> = new Set([
  "група", "групу", "групи", "групі", "групою", "груп", "групах", "групам", "группа", "группу", "группы", "группе", "группой", "групп", "группах", "группам",
]);
// Prepositions a group is said after without its noun: «для салонів», «для геймеров», «в установи», «до постійних».
export const GROUP_PREPOSITIONS: ReadonlySet<string> = new Set(["для", "в", "у", "до", "во"]);
// Prepositions a price list is said after: «з опту», «в оптовий», «по опту», «для партнерського».
export const PRICE_LIST_PREPOSITIONS: ReadonlySet<string> = new Set(["з", "із", "зі", "с", "со", "из", "в", "у", "во", "до", "для", "по", "на"]);
// The words that name a price list itself: «прайс», «прайс-лист», «прайсу», ru «прайса», «прайсе».
export const PRICE_LIST_NOUNS: ReadonlySet<string> = new Set([
  "прайс", "прайсу", "прайсі", "прайса", "прайсом", "прайсе", "прайс-лист", "прайс-листа", "прайс-листі", "прайс-листу", "прайс-листом", "прайс-листе",
  "прайслист", "прайслиста", "прайслисті", "прайслисту",
]);
