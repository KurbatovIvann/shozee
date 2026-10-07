import { formatMoneyUah } from "@showzy/module-kit/money-format";

import type { BuyerFace, DocumentPdfModel, SellerFace } from "./model.js";

/** Hardcoded unit: `document_items` has no unit column (SHO-362). */
export const PIECE_UNIT = "шт";

export function isCustomerFace(
  face: SellerFace | BuyerFace,
): face is Extract<BuyerFace, { kind: "customer" }> {
  return "kind" in face && face.kind === "customer";
}

export function legalCodeLabel(companyType: SellerFace["companyType"]): string {
  return companyType === "fop" ? "ІПН" : "ЄДРПОУ";
}

export function tradeNameInitials(name: string): string {
  const words = name
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0);
  const first = words[0];
  if (first === undefined) {
    return "";
  }
  const second = words[1];
  const firstLetter = first[0];
  const secondLetter = second?.[0];
  if (secondLetter !== undefined && firstLetter !== undefined) {
    return `${firstLetter}${secondLetter}`.toLocaleUpperCase("uk-UA");
  }
  return first.slice(0, 2).toLocaleUpperCase("uk-UA");
}

export function showFopVatExemptFootnote(model: DocumentPdfModel): boolean {
  if (model.supplier.companyType !== "fop") {
    return false;
  }
  if (model.totalTaxMinor !== "0") {
    return false;
  }
  return model.items.every(
    (item) => item.netAmountMinor === item.grossAmountMinor,
  );
}

export function bankLine(
  bankName: string | null,
  bankMfo: string | null,
): string | null {
  if (bankName === null && bankMfo === null) {
    return null;
  }
  if (bankName !== null && bankMfo !== null) {
    return `${bankName}, МФО ${bankMfo}`;
  }
  return bankName ?? `МФО ${bankMfo ?? ""}`;
}

export function pushIfPresent(
  rows: string[],
  label: string,
  value: string | null,
): void {
  if (value !== null && value.length > 0) {
    rows.push(`${label}: ${value}`);
  }
}

export function supplierHeaderLines(face: SellerFace): string[] {
  const rows: string[] = [];
  if (face.legalName !== null && face.legalName.length > 0) {
    rows.push(face.legalName);
  }
  pushIfPresent(rows, legalCodeLabel(face.companyType), face.edrpou);
  if (face.legalAddress !== null && face.legalAddress.length > 0) {
    rows.push(face.legalAddress);
  }
  pushIfPresent(rows, "IBAN", face.iban);
  const bank = bankLine(face.bankName, face.bankMfo);
  if (bank !== null) {
    rows.push(`в ${bank}`);
  }
  pushIfPresent(rows, "Тел.", face.phone);
  return rows;
}

export function payerLines(face: BuyerFace): string[] {
  if (isCustomerFace(face)) {
    return [face.displayName];
  }
  const rows: string[] = [face.name];
  pushIfPresent(rows, "ЄДРПОУ", face.edrpou);
  pushIfPresent(rows, "Адреса", face.legalAddress);
  pushIfPresent(rows, "Тел.", face.phone);
  pushIfPresent(rows, "Email", face.email);
  return rows;
}

export function supplierPartyLines(face: SellerFace): string[] {
  const rows: string[] = [];
  rows.push(face.legalName ?? face.name);
  if (face.legalName !== null && face.legalName !== face.name) {
    rows.push(`(торгова марка «${face.name}»)`);
  }
  pushIfPresent(rows, legalCodeLabel(face.companyType), face.edrpou);
  pushIfPresent(rows, "Адреса", face.legalAddress);
  pushIfPresent(rows, "IBAN", face.iban);
  pushIfPresent(rows, "Банк", bankLine(face.bankName, face.bankMfo));
  pushIfPresent(rows, "Тел.", face.phone);
  return rows;
}

export function buyerPartyLines(face: BuyerFace): string[] {
  if (isCustomerFace(face)) {
    return [face.displayName];
  }
  const rows: string[] = [face.name];
  pushIfPresent(rows, "ЄДРПОУ", face.edrpou);
  pushIfPresent(rows, "Адреса", face.legalAddress);
  pushIfPresent(rows, "IBAN", face.iban);
  pushIfPresent(rows, "Банк", bankLine(face.bankName, face.bankMfo));
  pushIfPresent(rows, "Тел.", face.phone);
  return rows;
}

export function releasedPosition(
  companyType: SellerFace["companyType"],
): string | null {
  return companyType === "fop" ? "ФОП" : null;
}

export function releasedPersonName(face: SellerFace): string | null {
  if (face.legalName !== null && face.legalName.length > 0) {
    return face.legalName;
  }
  return null;
}

export function receivedPersonName(face: BuyerFace): string | null {
  switch (face.kind) {
    case "counterparty":
    case "customer":
      // Entity label / display name is not ПІБ. Buyer snapshots have no
      // person legalName; Magic Patterns WaybillDocument leaves this blank.
      return null;
  }
}

export function invoiceVatFootnote(model: DocumentPdfModel): string | null {
  if (!showFopVatExemptFootnote(model)) {
    return null;
  }
  const who = model.supplier.legalName ?? model.supplier.name;
  return `* ${who}, платник єдиного податку, неплатник ПДВ.`;
}

export function waybillVatFootnote(model: DocumentPdfModel): string | null {
  if (!showFopVatExemptFootnote(model)) {
    return null;
  }
  return "* Постачальник — платник єдиного податку, неплатник ПДВ.";
}

export function taxAmountLabel(
  totalTaxMinor: string,
  markedExempt: boolean,
): string {
  if (totalTaxMinor === "0") {
    return markedExempt ? "Без ПДВ *" : "Без ПДВ";
  }
  return formatMoneyUah(totalTaxMinor);
}
