import { Document, Page, StyleSheet, Text, View } from "@react-pdf/renderer";

import {
  formatMinorUnits,
  formatMoneyUah,
  formatQuantityMilli,
} from "@showzy/module-kit/money-format";

import { uahAmountInWords } from "../services/amount-in-words.js";
import { formatIssuedOn } from "../services/format-pdf-text.js";
import { ensureLiberationSans, LIBERATION_SANS } from "./liberation-sans.js";
import type { DocumentPdfModel } from "./model.js";
import {
  PIECE_UNIT,
  buyerPartyLines,
  receivedPersonName,
  releasedPersonName,
  releasedPosition,
  showFopVatExemptFootnote,
  supplierPartyLines,
  taxAmountLabel,
  waybillVatFootnote,
} from "./pdf-faces.js";

const styles = StyleSheet.create({
  page: {
    fontFamily: LIBERATION_SANS,
    fontSize: 9,
    paddingTop: 36,
    paddingBottom: 36,
    paddingHorizontal: 36,
    color: "#0f172a",
  },
  titleBlock: {
    alignItems: "center",
    marginBottom: 22,
  },
  title: {
    fontSize: 18,
    fontWeight: 700,
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 12,
    fontWeight: 700,
  },
  parties: {
    flexDirection: "row",
    gap: 14,
    marginBottom: 16,
  },
  card: {
    flex: 1,
    borderWidth: 1,
    borderColor: "#e2e8f0",
    backgroundColor: "#f8fafc",
    padding: 10,
  },
  cardLabel: {
    fontSize: 8,
    fontWeight: 700,
    color: "#94a3b8",
    marginBottom: 6,
  },
  cardLine: {
    marginBottom: 2,
    fontSize: 9,
  },
  cardHeading: {
    fontSize: 10,
    fontWeight: 700,
    marginBottom: 4,
  },
  basis: {
    marginBottom: 12,
    fontSize: 10,
  },
  table: {
    borderWidth: 1,
    borderColor: "#cbd5e1",
    marginBottom: 12,
  },
  tableHeader: {
    flexDirection: "row",
    backgroundColor: "#f1f5f9",
    borderBottomWidth: 1,
    borderBottomColor: "#cbd5e1",
  },
  tableRow: {
    flexDirection: "row",
    borderBottomWidth: 1,
    borderBottomColor: "#e2e8f0",
  },
  cell: {
    paddingVertical: 5,
    paddingHorizontal: 4,
    borderRightWidth: 1,
    borderRightColor: "#e2e8f0",
  },
  cellLast: {
    paddingVertical: 5,
    paddingHorizontal: 4,
  },
  headerCell: { fontSize: 8, fontWeight: 700 },
  colIndex: { width: "7%", textAlign: "center" },
  colTitle: { width: "33%" },
  colUnit: { width: "12%", textAlign: "center" },
  colQty: { width: "12%", textAlign: "right" },
  colPrice: { width: "18%", textAlign: "right" },
  colSum: { width: "18%", textAlign: "right" },
  footerRow: {
    flexDirection: "row",
    borderTopWidth: 1,
    borderTopColor: "#cbd5e1",
  },
  footerLabel: {
    width: "82%",
    textAlign: "right",
    paddingVertical: 5,
    paddingHorizontal: 4,
    fontWeight: 700,
    borderRightWidth: 1,
    borderRightColor: "#e2e8f0",
  },
  footerValue: {
    width: "18%",
    textAlign: "right",
    paddingVertical: 5,
    paddingHorizontal: 4,
    fontWeight: 700,
  },
  amountInWords: {
    marginBottom: 8,
    fontSize: 10,
  },
  footnote: {
    fontSize: 8,
    color: "#64748b",
    fontStyle: "italic",
    marginBottom: 22,
  },
  signatures: {
    flexDirection: "row",
    gap: 24,
    borderTopWidth: 1,
    borderTopColor: "#e2e8f0",
    paddingTop: 16,
  },
  signCol: { flex: 1 },
  signTitle: { fontSize: 10, fontWeight: 700, marginBottom: 12 },
  signRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    marginBottom: 10,
    gap: 6,
  },
  signLabel: { fontSize: 9 },
  underline: {
    flex: 1,
    borderBottomWidth: 1,
    borderBottomColor: "#cbd5e1",
    minHeight: 12,
    textAlign: "center",
    fontSize: 9,
  },
  stamp: { fontSize: 9, color: "#64748b" },
  afterItems: { marginBottom: 22 },
});

function PartyCard({
  label,
  lines,
}: {
  readonly label: string;
  readonly lines: readonly string[];
}) {
  const heading = lines[0] ?? "";
  const rest = lines.slice(1);
  return (
    <View style={styles.card}>
      <Text style={styles.cardLabel}>{label}</Text>
      {heading.length > 0 ? (
        <Text style={styles.cardHeading}>{heading}</Text>
      ) : null}
      {rest.map((line, index) => (
        <Text key={`${String(index)}:${line}`} style={styles.cardLine}>
          {line}
        </Text>
      ))}
    </View>
  );
}

function SignLine({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string | null;
}) {
  return (
    <View style={styles.signRow}>
      <Text style={styles.signLabel}>{label}</Text>
      <Text style={styles.underline}>{value ?? ""}</Text>
    </View>
  );
}

export function WaybillPartiesPdf({
  model,
}: {
  readonly model: DocumentPdfModel;
}) {
  ensureLiberationSans();
  const footnote = waybillVatFootnote(model);
  const markedExempt = showFopVatExemptFootnote(model);
  const itemCount = String(model.items.length);
  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <View style={styles.titleBlock}>
          <Text style={styles.title}>ВИДАТКОВА НАКЛАДНА</Text>
          <Text style={styles.subtitle}>
            № {model.documentNumber} від {formatIssuedOn(model.issuedOn)} р.
          </Text>
        </View>
        <View style={styles.parties}>
          <PartyCard
            label="Постачальник"
            lines={supplierPartyLines(model.supplier)}
          />
          <PartyCard label="Покупець" lines={buyerPartyLines(model.buyer)} />
        </View>
        {model.basis !== null && model.basis.length > 0 ? (
          <Text style={styles.basis}>Підстава: {model.basis}</Text>
        ) : null}
        <View style={styles.table}>
          <View style={styles.tableHeader}>
            <Text style={[styles.cell, styles.headerCell, styles.colIndex]}>
              №
            </Text>
            <Text style={[styles.cell, styles.headerCell, styles.colTitle]}>
              Найменування товару
            </Text>
            <Text style={[styles.cell, styles.headerCell, styles.colUnit]}>
              Од. виміру
            </Text>
            <Text style={[styles.cell, styles.headerCell, styles.colQty]}>
              К-сть
            </Text>
            <Text style={[styles.cell, styles.headerCell, styles.colPrice]}>
              Ціна без ПДВ, грн
            </Text>
            <Text style={[styles.cellLast, styles.headerCell, styles.colSum]}>
              Сума без ПДВ, грн
            </Text>
          </View>
          {model.items.map((item, index) => (
            <View key={item.itemId} style={styles.tableRow} wrap={false}>
              <Text style={[styles.cell, styles.colIndex]}>
                {String(index + 1)}
              </Text>
              <Text style={[styles.cell, styles.colTitle]}>{item.title}</Text>
              <Text style={[styles.cell, styles.colUnit]}>{PIECE_UNIT}</Text>
              <Text style={[styles.cell, styles.colQty]}>
                {formatQuantityMilli(item.quantityMilli)}
              </Text>
              <Text style={[styles.cell, styles.colPrice]}>
                {formatMinorUnits(item.unitPriceMinor, 2)}
              </Text>
              <Text style={[styles.cellLast, styles.colSum]}>
                {formatMinorUnits(item.netAmountMinor, 2)}
              </Text>
            </View>
          ))}
          <View style={styles.footerRow}>
            <Text style={styles.footerLabel}>Всього без ПДВ:</Text>
            <Text style={styles.footerValue}>
              {formatMinorUnits(model.totalNetMinor, 2)}
            </Text>
          </View>
          <View style={styles.footerRow}>
            <Text style={styles.footerLabel}>ПДВ:</Text>
            <Text style={styles.footerValue}>
              {taxAmountLabel(model.totalTaxMinor, markedExempt)}
            </Text>
          </View>
          <View style={styles.footerRow}>
            <Text style={styles.footerLabel}>Всього до сплати:</Text>
            <Text style={styles.footerValue}>
              {formatMoneyUah(model.totalGrossMinor)}
            </Text>
          </View>
        </View>
        <Text style={styles.amountInWords}>
          Всього найменувань: {itemCount}, на суму{" "}
          {formatMoneyUah(model.totalGrossMinor)} (
          {uahAmountInWords(model.totalGrossMinor)})
        </Text>
        {footnote !== null ? (
          <Text style={styles.footnote}>{footnote}</Text>
        ) : (
          <View style={styles.afterItems} />
        )}
        <View style={styles.signatures}>
          <View style={styles.signCol}>
            <Text style={styles.signTitle}>Відпустив:</Text>
            <SignLine
              label="Посада:"
              value={releasedPosition(model.supplier.companyType)}
            />
            <View style={styles.signRow}>
              <Text style={styles.signLabel}>Підпис:</Text>
              <View style={styles.underline} />
              <Text style={styles.stamp}>/ М.П. /</Text>
            </View>
            <SignLine label="ПІБ:" value={releasedPersonName(model.supplier)} />
          </View>
          <View style={styles.signCol}>
            <Text style={styles.signTitle}>Отримав:</Text>
            <SignLine label="Посада:" value={null} />
            <View style={styles.signRow}>
              <Text style={styles.signLabel}>Підпис:</Text>
              <View style={styles.underline} />
              <Text style={styles.stamp}>/ М.П. /</Text>
            </View>
            <SignLine label="ПІБ:" value={receivedPersonName(model.buyer)} />
          </View>
        </View>
      </Page>
    </Document>
  );
}
