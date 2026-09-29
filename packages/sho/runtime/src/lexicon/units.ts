// Units, general for any shop (D64): what a quantity is counted or measured in, and what only measures a product or a variant.

// Containers a product is counted in (D66): «три баночки», «п'ять тюбиків», «флаконів», «пакетиків», «примірник», ru «экземпляр». Each holds one piece of
// the product, so they count pieces. Since D68 a jar or can («банка», «баночка») is the sale unit `can`, as a bottle is `bottle` (D67).
const CANS = "баночка баночки баночок баночку баночкою банка банки банок банку банкою";
const CONTAINERS: readonly string[] = [
  CANS,
  "тюбик тюбики тюбиків тюбика тюбиков",
  "флакон флакони флаконів флакона флаконы флаконов",
  "пакетик пакетики пакетиків пакетика пакетиков",
  "пляшка пляшки пляшок пляшку бутылка бутылки бутылок бутылку",
  "примірник примірники примірників примірника экземпляр экземпляра экземпляры экземпляров",
].flatMap((forms) => forms.split(" "));

// Units that only count pieces: a sum of two quantities drops them («дві штуки» + «3» is «5», D60). A pair counts pieces the way a piece does: shoes and
// socks are sold by the pair («2 пари» + «1» is «3»); so does a container (D66).
export const PIECE_UNITS: ReadonlySet<string> = new Set(["штука", "штуки", "штук", "штуку", "штучка", "штучки", "штучок", "штучку", "шт", "пара", "пари", "пар", "пару", "парі", "пары", ...CONTAINERS]);

// Every spelling of a unit, uk, ru and Latin, by one key, so that «256 гігабайт» names the variant «256 ГБ» and «50ml» the variant «50 мл» (D64). Only a
// word right after a number is read as a unit (`nameTokens.ts`). Lengths, the tonne, amperes, volts, kilowatts, megapixels and hertz since D66; the oblique
// cases («кілограму», «літром», «граму», «метрі»), square and cubic metres («м²», «квадратів», «кубів», «кубометр») since D67. A Cyrillic «а» or «в»
// after a number is not in this table: the capital «А» and «В» a catalogue writes are amperes and volts, and so is a lowercase one that ends the words,
// but «2 а ні 3», «2 в коробці» keep the word (`nameTokens.ts`, `CAPITAL_UNITS`, D67).
const UNIT_SPELLINGS: Readonly<Record<string, string>> = {
  ml: "мл ml мілілітр мілілітри мілілітрів мілілітра мілілітру мілілітром миллилитр миллилитра миллилитров миллилитру миллилитром",
  l: "л l літр літра літри літрів літру літром літрі литр литра литров литру литром литре литры",
  g: "г g гр грам грами грамів грама граму грамом грамі грамм грамма граммов грамму граммом грамме граммы",
  kg: "кг kg кіло кило кіла кила кілограм кілограми кілограмів кілограма кілограму кілограмом кілограмі килограмм килограмма килограммов килограмму килограммом килограмме килограммы",
  t: "т t тонна тонни тонн тонну тонною тонні тонны тонной тонне",
  mm: "мм mm міліметр міліметри міліметрів міліметра міліметру міліметром миллиметр миллиметра миллиметров миллиметру миллиметром",
  cm: "см cm сантиметр сантиметри сантиметрів сантиметра сантиметру сантиметром сантиметров сантиметре",
  m: "м m метр метри метрів метра метру метром метрі метров метре метры",
  m2: "м² m² квадрат квадрати квадратів квадрата квадратов квадраты",
  m3: "м³ m³ куб куби кубів куба кубов кубы кубометр кубометри кубометрів кубометра кубометру кубометров кубометры",
  gb: "гб gb гіг гіга гіги гігів гиг гига гигов гігабайт гігабайти гігабайтів гигабайт гигабайта гигабайтов",
  tb: "тб tb терабайт терабайти терабайтів терабайта терабайтов",
  mb: "мб mb мегабайт мегабайти мегабайтів мегабайта мегабайтов",
  in: "дюйм дюйми дюймів дюйма дюймов inch inches",
  w: "вт w ват вати ватів вата ватт ватта ваттов ватти",
  kw: "квт kw кіловат кіловати кіловатів кіловата киловатт киловатта киловаттов кіловатт",
  a: "a ампер ампери амперів ампера амперы",
  v: "v вольт вольти вольтів вольта вольты",
  mah: "мач mah",
  mp: "мп mp мегапіксель мегапікселі мегапікселів мегапікселя мегапиксель мегапикселя мегапикселей",
  hz: "гц hz герц",
};

// A count and a percent in a value (D71): «9 шт» is said «дев'ять штук», «20%» «двадцять відсотків». Only an attr's words are compared so
// (`records.ts` `ProductValues`); the catalogue pass keeps «десять штук» a quantity and «2,5» the value «2,5%».
export const COUNT_WORDS: ReadonlySet<string> = new Set(["шт", "штук", "штуки", "штука", "штуку", "штучок", "штучки"]);
export const COUNT_KEY = "шт";
export const PERCENT_SIGNS: ReadonlySet<string> = new Set(["%", "відсоток", "відсотки", "відсотків", "відсотка", "процент", "проценти", "процентів", "процента", "процентов", "проц"]);

// The capital Cyrillic letters a catalogue writes for a unit after a number (D67): «16 А» is 16 amperes, «220 В» 220 volts, «50 А·год» 50 A·h. Speech is
// lowercased (`normalise`): a spoken «а» or «в» after a number is the unit only when it ends the words («16 а»), else a word («2 а ні 3»).
export const CAPITAL_UNITS: ReadonlyMap<string, string> = new Map([
  ["А", "a"],
  ["В", "v"],
]);

// Two words that say one unit after a number (D67): «35 квадратних метрів» is «35 м²», «2 кубічних метри» «2 м³», «10 погонних метрів» «10 м», «кв. м»
// «м²». The first word by its start («кв» of «квадратних», «куб» of «кубічних», «кубических», «пог» of «погонних»), then a word of the metre.
export const UNIT_PHRASES: readonly (readonly [start: string, unit: string])[] = [
  ["кв", "м²"],
  ["куб", "м³"],
  ["пог", "м"],
];

export const UNIT_KEYS: ReadonlyMap<string, string> = new Map(Object.entries(UNIT_SPELLINGS).flatMap(([key, forms]) => forms.split(" ").map((form) => [form, key] as const)));

// Units that measure a product or a variant and never count one: a number said with one is part of a name or a variant, not a quantity («256 гб», «1200 Вт»,
// «65 дюймів», «120 см», «40 ампер»).
export const SPEC_UNITS: ReadonlySet<string> = new Set([...UNIT_KEYS].filter(([, key]) => ["gb", "tb", "mb", "in", "w", "kw", "mah", "mm", "cm", "a", "v", "mp", "hz"].includes(key)).map(([form]) => form));

// Measures of one dimension, by their scale to the smallest unit: «0,5 кг» and «500 г» are one weight, «1,2 м» and «120 см» one length (D66); «1 м³» and
// «1000 л» one volume, «м²» an area (D67).
export const MEASURE_SCALES: ReadonlyMap<string, readonly [dimension: string, scale: number]> = new Map([
  ["g", ["mass", 1]],
  ["kg", ["mass", 1000]],
  ["t", ["mass", 1_000_000]],
  ["ml", ["volume", 1]],
  ["l", ["volume", 1000]],
  ["m3", ["volume", 1_000_000]],
  ["mm", ["length", 1]],
  ["cm", ["length", 10]],
  ["m", ["length", 1000]],
  ["m2", ["area", 1]],
  ["w", ["power", 1]],
  ["kw", ["power", 1000]],
]);

// Unit words said as words, not symbols: said alone they mean one of the unit («кіло печива», «літр молока», «метр кабелю», «кубометр піску»); a symbol
// alone («г», «л», «м») is a letter, and «куб», «квадрат» alone are the shapes.
export const SPELLED_MEASURES: ReadonlySet<string> = new Set(
  [...UNIT_KEYS]
    .filter(([form, key]) => (["g", "kg", "t", "l", "ml", "m", "cm", "mm"].includes(key) && Array.from(form).length >= 4) || (key === "m3" && form.startsWith("кубометр")))
    .map(([form]) => form),
);

// The first words of two-word units (`UNIT_PHRASES`) by the unit key they say, all forms: a quantity is said in them («10 квадратних метрів»).
const PHRASE_WORDS: Readonly<Record<string, string>> = {
  m2: "квадратних квадратні квадратний квадратного квадратну квадратных квадратные квадратный",
  m3: "кубічних кубічні кубічний кубічного кубических кубические кубический",
  m: "погонних погонні погонний погонного погонных погонные погонный",
};

// Packs a quantity is counted in, by sale unit (D64, D67): «три коробки», «п'ять пачок», «два рулони», «мішок цементу»; since D68 «два пакети молока», and
// the other units of a shop that sells by the bucket, sheet, portion, service or hour («два відра фарби», «три листи фанери», «дві порції вареників»,
// «дві послуги», «три години прокату»).
const PACK_SPELLINGS: Readonly<Record<"pack" | "box" | "set" | "roll" | "bag" | "bucket" | "sheet" | "portion" | "service" | "hour", string>> = {
  pack: "упаковки упаковка упаковку упаковок пачки пачка пачку пачок пачек пакет пакети пакетів пакета пакету пакеты пакетов",
  box: "коробки коробка коробку коробок ящик ящика ящики ящиків ящиков",
  set: "комплект комплекти комплектів комплекта комплектов комплекты набір набори наборів набора наборов наборы",
  roll: "рулон рулони рулонів рулона рулонов рулоны",
  bag: "мішок мішки мішків мішка мешок мешки мешков мешка",
  bucket: "відро відра відер відром ведро ведра ведер вёдер ведром",
  sheet: "лист листи листів листа листом аркуш аркуші аркушів аркуша аркушем листы листов",
  portion: "порція порції порцій порцію порцією порция порции порций порцию порцией",
  service: "послуга послуги послуг послугу послугою услуга услуги услуг услугу услугой",
  hour: "година години годин годину годиною час часа часов",
};

const BOTTLES = "пляшка пляшки пляшок пляшку бутылка бутылки бутылок бутылку";

// Containers and pieces the stage-1 data counts in (D71): a cylinder, a canister, a spool, a container, a strip, a deck, a bunch; each is one piece of
// what it holds, as a bottle is. Their words also name products («Балон газовий», «Каністра 20 л», «Котушка коропова»), so only a quantity span the model
// tagged reads them, as the D68 units (`SPAN_SINGLE_UNITS`), and a line's own product word after a number counts pieces too (`resolve.ts`).
const SPAN_CONTAINERS: readonly string[] = [
  "балон балони балонів балона балону баллон баллона баллоны баллонов баллончик баллончика баллончики баллончиков балончик балончики балончиків",
  "каністра каністри каністр каністру канистра канистры канистр канистру",
  "котушка котушки котушок котушку катушка катушки катушек катушку",
  "контейнер контейнери контейнерів контейнера контейнеры контейнеров",
  "планка планки планок планку",
  "колода колоди колод колоду колоды",
  "пучок пучки пучків пучка пучков",
  "бутылочка бутылочки бутылочек бутылочку пляшечка пляшечки пляшечок пляшечку",
].flatMap((forms) => forms.split(" "));
// A coil of cable or hose («дві бухти кабелю»): a roll (D71).
const COILS = "бухта бухти бухт бухту";

function forms(text: string | undefined): string[] {
  return (text ?? "").split(" ").filter(Boolean);
}

// Weights, volumes, lengths and areas a quantity is said in («2 кг», «пів літра», «тонну», «5 метрів», «10 квадратних метрів», «два куби»), and packs
// («три коробки», «два рулони»). Lengths below the metre and the short «м» never are (`SPEC_UNITS`; «2 м» is two of size M).
// The D68 units (buckets, sheets, portions, services, hours) are not among them: their words also name products and variants («відро», «лист»,
// «порції 250 г»), so the catalogue pass does not read them; a quantity span the model tags reads them (`QUANTITY_UNIT_KEYS`).
const MEASURE_UNITS: readonly string[] = [
  ...[...UNIT_KEYS].filter(([form, key]) => ["g", "kg", "t", "l", "ml", "m2", "m3"].includes(key) || (key === "m" && form !== "м" && form !== "m")).map(([form]) => form),
  ...Object.values(PHRASE_WORDS).flatMap(forms),
  ...(["pack", "box", "set", "roll", "bag"] as const).flatMap((unit) => forms(PACK_SPELLINGS[unit])),
];

export const UNITS: ReadonlySet<string> = new Set([...PIECE_UNITS, ...MEASURE_UNITS]);

// A unit word said alone that means one of it («коробку еклерів», «кіло печива», «тонну піску», «банку огірків», «мішок цементу», «рулон плівки»): its value
// is 1 (D67; D60 read a pack alone as no number). «пару» is not one: it is also «a couple»; nor are «комплект» and «набір», which start product names,
// «пакет» and «лист», which name products, or «годину», which says a time («через годину»).
export const SINGLE_UNITS: ReadonlySet<string> = new Set([
  "пачку", "пачка", "коробку", "коробка", "упаковку", "упаковка", "ящик", "ящика", "мішок", "мешок", "рулон",
  "кіло", "кило", "кілограм", "килограмм", "літр", "литр", "тонну", "тонна", "метр", "кубометр",
  "баночку", "банку", "пляшку", "бутылку", "флакон", "тюбик", "пакетик", "примірник", "экземпляр",
]);

// A quantity span the model tagged that is a D68 unit said alone is one of it too («відро фарби», «порцію вареників»); the catalogue pass does not read
// these words (they name products: «Відро пластикове»), so they are not `SINGLE_UNITS`.
// Since D71 also the stage-1 containers said alone («каністру», «балон», «пучок», «бухту»).
export const SPAN_SINGLE_UNITS: ReadonlySet<string> = new Set([
  ...SINGLE_UNITS, "відро", "ведро", "порцію", "порцию",
  "балон", "баллон", "каністру", "канистру", "котушку", "катушку", "контейнер", "планку", "колоду", "пучок", "бухту",
]);

// The units a shop sells a product in (context v2 `products[].unit`, D65): pieces, pairs, packs, boxes, weights and volumes; since D67 also tonnes,
// metres, square and cubic metres, sets, rolls, bags and bottles; since D68 cans, buckets, sheets, portions, services and hours.
export type SaleUnit =
  | "pcs" | "pair" | "pack" | "box" | "set" | "roll" | "bag" | "bottle" | "can" | "bucket" | "sheet" | "portion" | "service" | "hour"
  | "kg" | "g" | "t" | "l" | "ml" | "m" | "m2" | "m3";
export const SALE_UNITS: readonly SaleUnit[] = [
  "pcs", "pair", "pack", "box", "set", "roll", "bag", "bottle", "can", "bucket", "sheet", "portion", "service", "hour", "kg", "g", "t", "l", "ml", "m", "m2", "m3",
];

const SALE_UNIT_SPELLINGS: readonly (readonly [unit: SaleUnit, forms: readonly string[]])[] = [
  ["pcs", [...forms("штука штуки штук штуку штучка штучки штучок штучку шт"), ...CONTAINERS.filter((form) => !forms(BOTTLES).includes(form) && !forms(CANS).includes(form)), ...SPAN_CONTAINERS]],
  ["pair", forms("пара пари пар пару парі пары")],
  ["bottle", forms(BOTTLES)],
  ["can", forms(CANS)],
  ["pack", forms(PACK_SPELLINGS.pack)],
  ["box", forms(PACK_SPELLINGS.box)],
  ["set", forms(PACK_SPELLINGS.set)],
  ["roll", [...forms(PACK_SPELLINGS.roll), ...forms(COILS)]],
  ["bag", forms(PACK_SPELLINGS.bag)],
  ["bucket", forms(PACK_SPELLINGS.bucket)],
  ["sheet", forms(PACK_SPELLINGS.sheet)],
  ["portion", forms(PACK_SPELLINGS.portion)],
  ["service", forms(PACK_SPELLINGS.service)],
  ["hour", forms(PACK_SPELLINGS.hour)],
  ["kg", forms(UNIT_SPELLINGS["kg"])],
  ["g", forms(UNIT_SPELLINGS["g"])],
  ["t", forms(UNIT_SPELLINGS["t"])],
  ["l", forms(UNIT_SPELLINGS["l"])],
  ["ml", forms(UNIT_SPELLINGS["ml"])],
  ["m", [...forms(UNIT_SPELLINGS["m"]).filter((form) => form !== "м" && form !== "m"), ...forms(PHRASE_WORDS["m"])]],
  ["m2", [...forms(UNIT_SPELLINGS["m2"]), ...forms(PHRASE_WORDS["m2"])]],
  ["m3", [...forms(UNIT_SPELLINGS["m3"]), ...forms(PHRASE_WORDS["m3"])]],
];

// The sale unit a quantity's unit word says («штуки» pcs, «пари» pair, «кіло» kg, «баночки» pcs, «пляшки» bottle, «тонну» t, «квадратних» m2); the first
// unit word of a span says it («10 квадратних метрів» is m2).
export const QUANTITY_UNIT_KEYS: ReadonlyMap<string, SaleUnit> = new Map(SALE_UNIT_SPELLINGS.flatMap(([unit, spelled]) => spelled.map((form) => [form, unit] as const)));

// Units that count pieces: they fit a product sold in any unit (§4.2 of docs/design/sho-api-v2.md). A bottle is one piece of what it holds, as the
// containers are (D66); since D67 it is a sale unit of its own, and since D68 so is a can («банка»).
export const COUNTING_UNITS: ReadonlySet<SaleUnit> = new Set(["pcs", "pair", "bottle", "can"]);

// Containers that hold one piece (D68, the orchestrator's decision): said for a product sold by the piece they count its pieces, with no blocking need
// («шесть пачек молока» is 6 pcs; the card shows «6 пачок»). A box, a set, a bag or a roll holds several and stays a blocking `unit_mismatch` there.
export const PIECE_CONTAINERS: ReadonlySet<SaleUnit> = new Set(["pack", "bottle", "can", "bucket"]);

// Weights, volumes, lengths and areas in their smallest unit: «500 г» of a product sold by the kilo is 0.5 kg (D65, owner's answer to Q7); a tonne of a
// product sold by the kilo is 1000 kg, and of one sold by the tonne one tonne (D67: a tonne converts only into the product's own unit).
export const UNIT_SCALES: ReadonlyMap<SaleUnit, readonly [dimension: string, scale: number]> = new Map([
  ["g", ["mass", 1]],
  ["kg", ["mass", 1000]],
  ["t", ["mass", 1_000_000]],
  ["ml", ["volume", 1]],
  ["l", ["volume", 1000]],
  ["m3", ["volume", 1_000_000]],
  ["m", ["length", 1000]],
  ["m2", ["area", 1]],
]);

// Words a half is glued to («півлітра», «полкило», «полтонны», «півметра»): the half and the unit word after it (D66).
export const HALF_GLUED: readonly string[] = ["пів", "пол"];

// Adjectives of a unit, by their stem: «метровий кабель» is a cable of 1 m, «літрова банка» a jar of 1 l, «півлітрова» of 0.5 l (D66). The stem takes an
// adjective ending: ru «литров» and «метров» alone are the nouns («пять литров»).
export const UNIT_ADJECTIVES: ReadonlyMap<string, readonly [value: number, key: string]> = new Map([
  ["метров", [1, "m"]],
  ["півметров", [0.5, "m"]],
  ["літров", [1, "l"]],
  ["литров", [1, "l"]],
  ["півлітров", [0.5, "l"]],
  ["поллитров", [0.5, "l"]],
  ["кілограмов", [1, "kg"]],
  ["килограммов", [1, "kg"]],
]);

// «метр двадцять» is 1.2 m, «кіло двісті» 1.2 kg: a unit said first, then the smaller units in it (D66).
export const SUBUNITS: ReadonlyMap<string, number> = new Map([
  ["m", 100],
  ["kg", 1000],
  ["l", 1000],
]);

// Words between two numbers of one size: «50 на 70», «60 x 60» (D66).
export const BY_WORDS: ReadonlySet<string> = new Set(["на", "x", "х"]);

// Words that say a tyre's rim: «радіус 16» is «R16» (D66).
export const RIM_WORDS: ReadonlySet<string> = new Set(["радіус", "радиус", "радіуса", "радиуса"]);
