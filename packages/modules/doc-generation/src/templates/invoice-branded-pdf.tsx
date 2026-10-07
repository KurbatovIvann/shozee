import { Document, Page, StyleSheet, Text, View } from "@react-pdf/renderer";

import {
  formatMoneyUah,
  formatQuantityMilli,
} from "@showzy/module-kit/money-format";

import { uahAmountInWords } from "../services/amount-in-words.js";
import { formatIssuedOn } from "../services/format-pdf-text.js";
import { ensureLiberationSans, LIBERATION_SANS } from "./liberation-sans.js";
import type { DocumentPdfModel } from "./model.js";
import {
  PIECE_UNIT,
  invoiceVatFootnote,
  payerLines,
  showFopVatExemptFootnote,
  supplierHeaderLines,
  taxAmountLabel,
  tradeNameInitials,
} from "./pdf-faces.js";

const styles = StyleSheet.create({
  page: {
    fontFamily: LIBERATION_SANS,
    fontSize: 10,
    paddingTop: 40,
    paddingBottom: 40,
    paddingHorizontal: 40,
    color: "#0f172a",
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 28,
    gap: 16,
  },
  headerLeft: {
    flex: 1,
  },
  markRow: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 10,
    gap: 8,
  },
  mark: {
    width: 28,
    height: 28,
    backgroundColor: "#3b82f6",
    alignItems: "center",
    justifyContent: "center",
  },
  markText: {
    color: "#ffffff",
    fontSize: 11,
    fontWeight: 700,
  },
  tradeName: {
    fontSize: 13,
    fontWeight: 700,
  },
  headerLine: {
    fontSize: 9,
    color: "#475569",
    marginBottom: 2,
  },
  headerRight: {
    alignItems: "flex-end",
    maxWidth: "45%",
  },
  title: {
    fontSize: 18,
    fontWeight: 700,
    marginBottom: 4,
    textAlign: "right",
  },
  number: {
    fontSize: 12,
    fontWeight: 700,
    textAlign: "right",
  },
  date: {
    fontSize: 9,
    color: "#64748b",
    marginTop: 4,
    textAlign: "right",
  },
  payer: {
    marginBottom: 20,
  },
  payerTitle: {
    fontSize: 10,
    fontWeight: 700,
    borderBottomWidth: 1,
    borderBottomColor: "#e2e8f0",
    paddingBottom: 4,
    marginBottom: 6,
  },
  payerLine: {
    marginBottom: 2,
  },
  tableHeader: {
    flexDirection: "row",
    backgroundColor: "#f1f5f9",
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: "#cbd5e1",
    paddingVertical: 6,
    paddingHorizontal: 6,
  },
  tableRow: {
    flexDirection: "row",
    borderBottomWidth: 1,
    borderBottomColor: "#e2e8f0",
    paddingVertical: 6,
    paddingHorizontal: 6,
  },
  colIndex: { width: "8%" },
  colTitle: { width: "44%" },
  colQty: { width: "16%", textAlign: "right" },
  colPrice: { width: "16%", textAlign: "right" },
  colSum: { width: "16%", textAlign: "right" },
  headerCell: { fontSize: 9, fontWeight: 700 },
  totals: {
    marginTop: 16,
    alignItems: "flex-end",
  },
  totalsBox: {
    width: 220,
  },
  totalRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 4,
  },
  totalMuted: { color: "#475569" },
  dueRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    borderTopWidth: 2,
    borderTopColor: "#0f172a",
    paddingTop: 6,
    marginTop: 4,
  },
  dueLabel: { fontSize: 12, fontWeight: 700 },
  amountInWords: {
    marginTop: 16,
    marginBottom: 16,
  },
  footnote: {
    fontSize: 8,
    color: "#64748b",
    fontStyle: "italic",
  },
});

export function InvoiceBrandedPdf({
  model,
}: {
  readonly model: DocumentPdfModel;
}) {
  ensureLiberationSans();
  const footnote = invoiceVatFootnote(model);
  const markedExempt = showFopVatExemptFootnote(model);
  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <View style={styles.header}>
          <View style={styles.headerLeft}>
            <View style={styles.markRow}>
              <View style={styles.mark}>
                <Text style={styles.markText}>
                  {tradeNameInitials(model.supplier.name)}
                </Text>
              </View>
              <Text style={styles.tradeName}>{model.supplier.name}</Text>
            </View>
            {supplierHeaderLines(model.supplier).map((line, index) => (
              <Text key={`${String(index)}:${line}`} style={styles.headerLine}>
                {line}
              </Text>
            ))}
          </View>
          <View style={styles.headerRight}>
            <Text style={styles.title}>РАХУНОК-ФАКТУРА</Text>
            <Text style={styles.number}>№ {model.documentNumber}</Text>
            <Text style={styles.date}>
              від {formatIssuedOn(model.issuedOn)} р.
            </Text>
          </View>
        </View>
        <View style={styles.payer}>
          <Text style={styles.payerTitle}>ПЛАТНИК:</Text>
          {payerLines(model.buyer).map((line, index) => (
            <Text key={`${String(index)}:${line}`} style={styles.payerLine}>
              {line}
            </Text>
          ))}
        </View>
        <View style={styles.tableHeader}>
          <Text style={[styles.headerCell, styles.colIndex]}>№</Text>
          <Text style={[styles.headerCell, styles.colTitle]}>Найменування</Text>
          <Text style={[styles.headerCell, styles.colQty]}>К-сть</Text>
          <Text style={[styles.headerCell, styles.colPrice]}>Ціна</Text>
          <Text style={[styles.headerCell, styles.colSum]}>Сума</Text>
        </View>
        {model.items.map((item, index) => (
          <View key={item.itemId} style={styles.tableRow} wrap={false}>
            <Text style={styles.colIndex}>{String(index + 1)}</Text>
            <Text style={styles.colTitle}>{item.title}</Text>
            <Text style={styles.colQty}>
              {formatQuantityMilli(item.quantityMilli)} {PIECE_UNIT}
            </Text>
            <Text style={styles.colPrice}>
              {formatMoneyUah(item.unitPriceMinor)}
            </Text>
            <Text style={styles.colSum}>
              {formatMoneyUah(item.grossAmountMinor)}
            </Text>
          </View>
        ))}
        <View style={styles.totals}>
          <View style={styles.totalsBox}>
            <View style={styles.totalRow}>
              <Text style={styles.totalMuted}>Всього без ПДВ:</Text>
              <Text>{formatMoneyUah(model.totalNetMinor)}</Text>
            </View>
            <View style={styles.totalRow}>
              <Text style={styles.totalMuted}>ПДВ:</Text>
              <Text>{taxAmountLabel(model.totalTaxMinor, markedExempt)}</Text>
            </View>
            <View style={styles.dueRow}>
              <Text style={styles.dueLabel}>До сплати:</Text>
              <Text style={styles.dueLabel}>
                {formatMoneyUah(model.totalGrossMinor)}
              </Text>
            </View>
          </View>
        </View>
        <Text style={styles.amountInWords}>
          Сума прописом: {uahAmountInWords(model.totalGrossMinor)}
        </Text>
        {footnote !== null ? (
          <Text style={styles.footnote}>{footnote}</Text>
        ) : null}
      </Page>
    </Document>
  );
}
