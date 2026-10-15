export const varieties: Record<string, string> = { "1": "אטינגר", "2": "גליל", "3": "הס", "4": "פוארטה" };
export const plots: Record<string, string> = { "1": "כביש 70", "2": "חלקה א", "3": "בית העלמין" };
export const paymentMethods = { cheque: "המחאה", bank: "העברה בנקאית", cash: "מזומן" } as const;
export type Allocation = { harvest_event_id: string; containers: string; net_weight: string };
export type ReceiptLine = {
  id: string; trader_date: string; variety_id: string; gross_weight: string;
  containers: string; tare_weight: string; net_weight: string; price_per_kg: string;
  amount: string; allocations: Allocation[];
};
export type Receipt = {
  id: string; version: number; status: "draft" | "confirmed" | "cancelled";
  trader_id: string; payment_date: string; received_date: string;
  method: keyof typeof paymentMethods; amount: string; reference: string;
  notes: string; adjustment_reason: string; lines: ReceiptLine[];
  cancellation_reason?: string;
};
export type MatchShipment = {
  id: string; trader_id: string; variety_id: string; plot_id: string;
  harvest_date: string; containers: number; used_containers: number;
};
export type ReceiptWorkspace = {
  traders: { id: string; name: string }[];
  shipments: MatchShipment[];
  receipts: Receipt[];
};
export type PaidWeight = { harvest_event_id: string; net_weight: number; containers: number };

export function dateLabel(value: string) { return value ? value.split("-").reverse().join("/") : "—"; }
export function localToday() { return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem" }).format(new Date()); }
export function newLine(): ReceiptLine {
  return { id: crypto.randomUUID(), trader_date: "", variety_id: "1", gross_weight: "", containers: "", tare_weight: "40", net_weight: "", price_per_kg: "", amount: "", allocations: [] };
}
export function newReceipt(): Receipt {
  return { id: crypto.randomUUID(), version: 0, status: "draft", trader_id: "1", payment_date: localToday(), received_date: "", method: "cheque", amount: "", reference: "", notes: "", adjustment_reason: "", lines: [newLine()] };
}

// Decimal arithmetic: preserve cents exactly, including 387 × 3.5 = 1354.50.
function decimal(value: string) {
  if (!/^\d+(\.\d+)?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  return { value: BigInt(whole + fraction), scale: BigInt(10) ** BigInt(fraction.length) };
}
export function calculatedAmount(weight: string, price: string): string {
  const a = decimal(weight), b = decimal(price);
  if (!a || !b) return "";
  const denominator = a.scale * b.scale;
  const cents = (a.value * b.value * BigInt(100) + denominator / BigInt(2)) / denominator;
  return `${cents / BigInt(100)}.${(cents % BigInt(100)).toString().padStart(2, "0")}`;
}
export function cents(value: string): number {
  const result = calculatedAmount(value || "0", "1");
  return result ? Number(result.replace(".", "")) : 0;
}
export function totalLineCents(receipt: Receipt) { return receipt.lines.reduce((sum, line) => sum + cents(line.amount), 0); }
export function money(value: number) { return (value / 100).toLocaleString("he-IL", { style: "currency", currency: "ILS" }); }

export function availableContainers(shipment: MatchShipment, receipt: Receipt, original: Receipt | undefined, exceptLineId?: string) {
  const ownConfirmed = original?.status === "confirmed" ? original.lines.flatMap((line) => line.allocations)
    .filter((allocation) => allocation.harvest_event_id === shipment.id).reduce((sum, allocation) => sum + Number(allocation.containers), 0) : 0;
  const assignedElsewhere = receipt.lines.filter((line) => line.id !== exceptLineId).flatMap((line) => line.allocations)
    .filter((allocation) => allocation.harvest_event_id === shipment.id).reduce((sum, allocation) => sum + Number(allocation.containers || 0), 0);
  return Math.max(0, Math.round((shipment.containers - shipment.used_containers + ownConfirmed - assignedElsewhere) * 1000) / 1000);
}
export function matchCandidates(shipments: MatchShipment[], receipt: Receipt, line: ReceiptLine, original?: Receipt) {
  return shipments.filter((shipment) => shipment.trader_id === receipt.trader_id && shipment.variety_id === line.variety_id)
    .map((shipment) => {
      const available = availableContainers(shipment, receipt, original, line.id);
      const days = line.trader_date ? Math.round((Date.parse(`${line.trader_date}T00:00:00Z`) - Date.parse(`${shipment.harvest_date}T00:00:00Z`)) / 86400000) : null;
      const exact = Math.abs(available - Number(line.containers)) < 0.0005;
      const score = (exact ? 40 : 0) + (days === null ? 0 : Math.max(0, 30 - Math.abs(days) * 2)) + (days !== null && days >= 0 ? 5 : 0);
      return { ...shipment, available, days, exact, score };
    }).filter((shipment) => shipment.available > 0)
    .sort((a, b) => b.score - a.score || b.harvest_date.localeCompare(a.harvest_date) || a.id.localeCompare(b.id));
}

export function normalizeWorkspace(raw: ReceiptWorkspace): ReceiptWorkspace {
  return {
    traders: raw.traders.map((trader) => ({ ...trader, id: String(trader.id) })),
    shipments: raw.shipments.map((shipment) => ({ ...shipment, id: String(shipment.id), trader_id: String(shipment.trader_id), variety_id: String(shipment.variety_id), plot_id: String(shipment.plot_id), containers: Number(shipment.containers), used_containers: Number(shipment.used_containers) })),
    receipts: raw.receipts.map((receipt) => ({ ...receipt, trader_id: String(receipt.trader_id), amount: String(receipt.amount), received_date: receipt.received_date || "",
      lines: receipt.lines.map((line) => ({ ...line, trader_date: line.trader_date || "", variety_id: String(line.variety_id),
        gross_weight: String(line.gross_weight), containers: String(line.containers), tare_weight: String(line.tare_weight), net_weight: String(line.net_weight), price_per_kg: String(line.price_per_kg), amount: String(line.amount),
        allocations: line.allocations.map((allocation) => ({ ...allocation, harvest_event_id: String(allocation.harvest_event_id), containers: String(allocation.containers), net_weight: String(allocation.net_weight) })),
      })),
    })),
  };
}

export function receiptValidation(receipt: Receipt): string | null {
  if (!receipt.payment_date || !receipt.trader_id || cents(receipt.amount) <= 0 || receipt.lines.length === 0) return "יש להזין תאריך, סוחר, סכום תקבול חיובי ולפחות שורת פירוט אחת.";
  for (const [index, line] of receipt.lines.entries()) {
    const prefix = `שורה ${index + 1}: `;
    if (!line.trader_date || Number(line.containers) <= 0 || Number(line.net_weight) <= 0 || Number(line.price_per_kg) <= 0 || cents(line.amount) <= 0) return prefix + "יש להשלים תאריך סוחר, מיכלים, נטו, מחיר וסכום חיוביים.";
    if (Number(line.gross_weight) + 0.0000001 < Number(line.net_weight) + Number(line.containers) * Number(line.tare_weight)) return prefix + "הברוטו קטן מסכום הנטו ומשקל המיכלים. בדוק את הנתונים.";
    const count = line.allocations.reduce((sum, allocation) => sum + Number(allocation.containers), 0);
    const weight = line.allocations.reduce((sum, allocation) => sum + Number(allocation.net_weight), 0);
    if (!line.allocations.length || Math.abs(count - Number(line.containers)) > 0.0005 || Math.abs(weight - Number(line.net_weight)) > 0.0005) return prefix + "יש לשייך את מלוא המיכלים והמשקל לשיווקים.";
  }
  if (cents(receipt.amount) !== totalLineCents(receipt) && !receipt.adjustment_reason.trim()) return "יש להזין הסבר להפרש בין סכום התקבול לסכום שורות הפירוט.";
  return null;
}

export function receiptError(message: string) {
  const messages: Record<string, string> = {
    FORBIDDEN: "רק מנהל פעיל יכול לנהל תקבולים.",
    STALE_RECEIPT: "התקבול השתנה מאז שפתחת אותו, או שהשמירה הקודמת כבר הושלמה. רענן ופתח אותו מחדש לפני עריכה.",
    CANCELLED_RECEIPT: "התקבול בוטל ואינו ניתן לעריכה.",
    CANNOT_UNCONFIRM: "לא ניתן להפוך תקבול מאושר לטיוטה. אפשר לעדכן ולאשר או לבטל אותו.",
    INCOMPLETE_LINE: "חסרים נתונים בשורת פירוט או שהמשקלים אינם תקינים.",
    SHIPMENT_MISMATCH: "אחד השיווקים אינו קיים או שאינו תואם לסוחר ולזן. בדוק את השיוכים.",
    ALLOCATION_TOTAL_MISMATCH: "סכומי המיכלים והנטו בשיוכים חייבים להיות זהים לשורת הסוחר.",
    CONTAINER_CAPACITY_EXCEEDED: "שויכו יותר מיכלים מהכמות שנותרה באחד השיווקים. רענן את הנתונים ובדוק את השיוכים.",
    EXPLAIN_AMOUNT_DIFFERENCE: "יש להסביר את ההפרש בין סכום התקבול לסכום הפירוט.",
    EMPTY_RECEIPT: "יש להזין סכום חיובי ולפחות שורת פירוט אחת.",
    CANCELLATION_REASON_REQUIRED: "יש להזין סיבה לביטול התקבול.",
  };
  for (const [code, text] of Object.entries(messages)) if (message.includes(code)) return text;
  return "הפעולה נכשלה. בדוק את הנתונים ואת החיבור ונסה שוב. אם התקלה נמשכת, פנה לתמיכה.";
}
