export { VERSION } from "./version.ts";
export { BundleError, InputError, ModelError } from "./errors.ts";
export { clockMarks, isNormalised, normalise, percentMarks, punctuationBreaks, rawMarks, type RawMarks } from "./text/normalise.ts";
export { Tokenizer, parseTokenizerSpec, type Encoding, type Offset, type TokenizerLimits, type TokenizerSpec } from "./tokenizer.ts";
export { argmax, softmax } from "./math.ts";
export { Dates, type DateToken, type Period, type PeriodMatch, type RangePeriod, type Span } from "./dates.ts";
export { DATES, MONTH_LENGTHS, SEASONS, type DatesSpec } from "./lexicon/dates.ts";
export { parseWhen, type Bound, type Now, type When } from "./when.ts";
export { periodDates, type Day, type PeriodDates } from "./periods.ts";
export { rollingPeriod, yearPeriod } from "./yearPeriods.ts";
export {
  addressValue,
  bankValue,
  branchValue,
  cityValue,
  countValue,
  emailValue,
  fitsPostomat,
  ibanValid,
  measureTexts,
  measureValue,
  methodOf,
  moneyAmount,
  percentAmount,
  taxIdValid,
  ttnValue,
  type Address,
  type Branch,
  type City,
  type MeasureValue,
  type Money,
  type Ttn,
  type V3Value,
} from "./values.ts";
export { assignRoles, type RoleAsk, type Roles } from "./roles.ts";
export { ASKED_ROLES, LINE_CUES, METHOD_STEMS, PARAM_CUES, type Cue, type LineRole, type PaymentMethodKey } from "./lexicon/roles.ts";
export {
  NUMBER_WORDS,
  canonicalNumber,
  cardinalCuts,
  canonicalOf,
  cleanNumber,
  digitString,
  halvesJoined,
  ibanValue,
  lastDays,
  moneyValue,
  numberRange,
  numberTokens,
  numberValue,
  numberWordKind,
  ordinalValue,
  percentValue,
  roundHalfEven,
  valueFromCanonical,
  valueOf,
  wordNumberAt,
  type LastDays,
  type NumberKind,
  type NumberToken,
} from "./numbers.ts";
export { COUPLE_PIECES, COUPLE_WORDS, ORDINAL_ENDINGS, ORDINAL_STEMS, PERCENT_WORDS, ZERO_WORDS, type NumberWordKind } from "./lexicon/numbers.ts";
export {
  BUNDLE_FORMAT,
  CATALOGUE_V3,
  ORDER_LINES,
  intentOfAction,
  isV3,
  LIST_THRESHOLD,
  listHeadOf,
  listItemType,
  spanKindsOf,
  parseBundle,
  type ActionName,
  type Bundle,
  type BundleId,
  type EnumKey,
  type Intent,
  type IntentKind,
  type LineFields,
  type ParamType,
} from "./bundle.ts";
export { bestSpans, collectSpans, joinsNumber, leadJoined, moneyApart, wordBounds, type BestSpans, type TaggedSpan } from "./spans.ts";
export { adjectiveLike, commonPrefix, lettersOnly, wordMatch } from "./words.ts";
export { PREPOSITION_FORMS, crossForms, exonymPartners, isCyrillic, isLatin, isNumber, latinLetters, nameFit, nameTokens, soundKey, soundKeys, soundStems, spelledSize, tokenMatch, tokensMatch, withoutApostrophes, type NameFit, type TokenMatch } from "./names.ts";
export { homoglyphs, isCode, lettersAlike, soundsLike } from "./sounds.ts";
export { familyTails, formKeys, sameWord, undoubled, wordForms, type WordForms } from "./morphology.ts";
export { measureAt, sameMeasure, type Measure } from "./measures.ts";
export { tyreParts, withRim } from "./tyres.ts";
export { NameIndex } from "./nameIndex.ts";
export { NameList, nameMatch, nameWords } from "./nameList.ts";
export { AND_NAMES, ASR_SLIPS, BRAND_EXONYMS, CASE_ENDINGS, CROSS_STEMS, CYRILLIC_LATIN, HOMOGLYPHS, LETTER_NAMES, SIZE_LETTERS, SOUND_READINGS, type SoundRule } from "./lexicon/names.ts";
export { MOST_ATTRS, linesBySide, mergedItems, pairLines, shapeOf, spanPieces, type LineKind, type LinePiece, type OrderLine, type SideLines } from "./lines.ts";
export { REPAIR_WORDS, additive, markerEdges, markerRun, markerWords, pieceCount, repaired, sameAttrs, spanEdges, summed, takesBack, trailingMarkers, withoutHedges, type MarkerEdges, type SaidLine } from "./repair.ts";
export { ADD_CUES, ADD_JOINERS, BACK_MARKERS, COMBINED_MARKERS, HALT_WORDS, HEDGE_WORDS, ITEM_LEAD_WORDS, LONE_MARKERS, REPAIR_MARKERS } from "./lexicon/repair.ts";
export { headKey, isLines, isNames, lastDaysValue, listValue, paramValue, paramValues, present, type EnumLogits, type LineValue, type ParamValue, type Params, type Value, type Values } from "./params.ts";
export { listedAction, numberlessOrder, singleGroupMove, type Moved } from "./rules.ts";
export {
  CUSTOMER_PARAM,
  Catalogue,
  ITEMS_PARAM,
  catalogueLines,
  compileContext,
  linesOf,
  mergedUnknowns,
  modelVariants,
  quantityAt,
  resegment,
  segment,
  trailingLines,
  variantContinues,
  type CatalogueHit,
  type CatalogueKind,
  type CompiledContext,
  type Merged,
  type MergedKind,
  type Piece,
  type PieceKind,
  type Quantity,
} from "./catalogue.ts";
export {
  CONTEXT_LIMITS,
  RECORD_LISTS,
  derivedValues,
  isContextV2,
  parseContext,
  shopOf,
  type AttrValues,
  type Context,
  type ContextV1,
  type ContextV2,
  type Capabilities,
  type ListName,
  type ProductV2,
  type RecordList,
  type RecordV2,
  type Shop,
  type ShopProduct,
  type ShopRecord,
  type ShopVariant,
  type VariantV2,
} from "./context.ts";
export { ProductValues, RecordIndex, Records, brandForms, decimalTokens, fullNames, productNames, type Hit, type Hits } from "./records.ts";
export {
  MOST_CANDIDATES,
  chooseVariant,
  customerRef,
  listRef,
  productRef,
  quantityOf,
  resolveItem,
  resolveVariant,
  type Confidences,
  type Lookup,
  type ParamNeed,
  type Outcome,
  type ProductFound,
  type VariantChoice,
} from "./resolve.ts";
export {
  RESULT_SCHEMA,
  type Attr,
  type Candidate,
  type CommandV2,
  type ConfidenceV2,
  type Confirmation,
  type ContextInfo,
  type Creates,
  type DebugV2,
  type Effect,
  type EnumParam,
  type EnumValues,
  type Match,
  type NearCandidate,
  type Need,
  type NeedReason,
  type OrderItem,
  type Param,
  type PaymentPart,
  type Quantity as QuantityV2,
  type Ref,
  type RefStatus,
  type ResultV2,
  type SpanParam,
  type Suggestion,
  type VariantParam,
  type VariantRef,
  type VariantStatus,
  type CityValue,
  type MoneyValue,
  type SpanValue,
} from "./result.ts";
export { commandV2, parseRequirements, type Decision, type Requirement, type Requirements } from "./command.ts";
export { commandV1, quantityText, toV1, type Command, type OrderLineV1, type ParamValueV1, type ParamsV1, type Result } from "./v1.ts";
export { CALIBRATION_FORMAT, UNCALIBRATED, confidenceOf, parseCalibration, tempered, type Calibration, type Confidence } from "./confidence.ts";
export { ADJECTIVE_ENDINGS, COLOUR_COUNTS, CONNECTORS, COUNTED_ENDINGS, LABEL_WORDS, LINE_WITH, LIST_LABELS, LIST_WORDS, PREPOSITIONS, WITH, WITHOUT } from "./lexicon/catalogue.ts";
export { CUSTOMER_LEADS, CUSTOMER_WORD_STEMS, LEGAL_FORMS, NAME_ENDINGS, NAME_FOLDS, PLACE_NOUNS } from "./lexicon/customers.ts";
export { CAPITAL_UNITS, COUNT_KEY, COUNT_WORDS, COUNTING_UNITS, PERCENT_SIGNS, SPAN_SINGLE_UNITS, MEASURE_SCALES, PIECE_CONTAINERS, PIECE_UNITS, QUANTITY_UNIT_KEYS, SALE_UNITS, SINGLE_UNITS, SPEC_UNITS, UNITS, UNIT_KEYS, UNIT_PHRASES, UNIT_SCALES, type SaleUnit } from "./lexicon/units.ts";
export { chosenCustomer, customerFirst, knownNameAt, leadingCustomer, outsideCustomer, resolveCustomer, resolveCustomerList, resolveCustomers, spansOutsideCustomer, surnameAfter, surnameLike, type CustomerFirst, type CustomerMatch, type CustomerResolution, type ListResolution, type ResolvedName } from "./customers.ts";
export { narrowedProduct, productReading, widenedProduct, type ProductReading } from "./products.ts";
export { variantNumbers } from "./variantNumbers.ts";
export { decode, decoded, readCommand, resolve, unresolved, type Decoded, type Heads, type Logits, type Reading, type Resolution } from "./decode.ts";
export { BARE_COMMAND_VERBS, COMMAND_CONNECTORS, COMMAND_VERBS, CUE_CONNECTORS } from "./lexicon/segment.ts";
export { MAX_COMMANDS, segmentStarts, splitCommands } from "./segment.ts";
export { DEICTICS, ORDER_FOLLOW_UPS, ORDER_REFS, PRONOUNS, RECORD_REFS, REF_FRAME_WORDS, REF_PHRASES, type DeicticTarget, type RecordReference } from "./lexicon/references.ts";
export {
  CUSTOMER_UPDATE,
  ELLIPSIS_TYPES,
  FRAGMENT_ACTIONS,
  GROUP_MOVE,
  NEW_CUSTOMER,
  NO_COMMAND,
  ORDER_CREATE,
  containsPhrase,
  customerParam,
  customerSource,
  ellipsis,
  fillFrom,
  fillReferences,
  groupMoves,
  isPronoun,
  lostCommand,
  mergedOrders,
  orderFollowUp,
  recordReference,
  refPhrase,
  withoutFragments,
  type CustomerSource,
  type Filling,
  type NameOf,
  type Referenced,
  type References,
  type Referencing,
  type Resolved,
  type Segment,
} from "./references.ts";
export { headsOf, type ModelRunner, type RawOutputs, type RawTensor } from "./model.ts";
export { createRuntime, kyivNow, nowOf, type HeldPass, type Inference, type Input, type RunOptions, type Runtime, type RuntimeOptions, type Timing } from "./pipeline.ts";
export { stockless, type Stockless, type Unsupported } from "./stockless.ts";
export { PREVIOUS_PERIOD, REFINE, REFINE_WINDOW, ageOf, epochOf, parsePrevious, previousPeriod, refined, type Previous, type RefineClock } from "./refine.ts";
export { withSuggestions } from "./suggest.ts";
export { MOST_NEAREST, NEAREST_FLOOR, NearIndex, productIndex, recordIndex, variantIndex, wordSimilarity } from "./nearest.ts";
export { attrApart, attrKind, type AttrKind } from "./attrKinds.ts";
export { ADJECTIVE_TAILS, ATTR_ENDINGS, COLOUR_STEMS, LATIN_COLOURS, SIZE_STEMS } from "./lexicon/attrs.ts";
export { nameAcross, namedLists, type Listed } from "./lists.ts";
export { fromPrevious, nameGender } from "./pronouns.ts";
export { FOCUS_LIVE, MOST_FOCUS, parseFocus, withCreates, withFocus, type FocusEntry, type FocusHow, type FocusType } from "./focus.ts";
export { LEFTOVER_KINDS, LEFTOVER_SURE, UNPARSED, leftoverOf, type Leftover } from "./leftover.ts";
export {
  CONTINUATION_LEADS,
  CONTINUATION_MORE,
  FOCUS_CONTAINER_PARAMS,
  FOCUS_CONTAINERS,
  FOCUS_HERE,
  FOCUS_NEW,
  FOCUS_NOUNS,
  FOCUS_PARAM_TYPES,
  FOCUS_PREPOSITIONS,
  FOCUS_THIS,
  PRONOUN_FORMS,
  type PronounForm,
} from "./lexicon/references.ts";
export { GROUP_NOUNS, GROUP_PREPOSITIONS, PRICE_LIST_NOUNS, PRICE_LIST_PREPOSITIONS } from "./lexicon/lists.ts";
export { DECIMAL_JOINERS } from "./lexicon/numbers.ts";
