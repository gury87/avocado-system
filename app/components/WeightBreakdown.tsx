"use client";
import { weightBreakdown } from "../lib/analysis";
import type { ReceiptLine } from "../lib/receipts";
import { useCatalog } from "./FarmCatalog";
const n=(v:number)=>v.toLocaleString("he-IL",{maximumFractionDigits:3});
export default function WeightBreakdown({line}:{line:ReceiptLine}){
  const {catalog}=useCatalog(),data=weightBreakdown(line);if(!data)return null;
  const flagged=data.invalid||(data.percent!==null&&data.percent>catalog.settings.loss_warning_percent);
  return <div data-weight-breakdown className={`rounded-xl border p-3 text-sm ${flagged?"border-amber-300 bg-amber-50":"border-zinc-200 bg-zinc-50"}`}>
    <h4 className="font-semibold">בדיקת משקל ופחת</h4>
    <p>ברוטו: {n(data.gross)} · משקל מיכלים: {n(data.tare)} · נטו: {n(data.net)} ק״ג</p>
    <p>פחת: {n(data.loss)} ק״ג · {data.percent===null?"לא ניתן לחשב אחוז":n(data.percent)+"% ממשקל הפרי ברוטו"}</p>
    {flagged&&<p className="font-medium text-amber-900">{data.invalid?"פער משקל לא תקין — יש לבדוק את הנתונים.":`מעל סף הפחת שהוגדר (${catalog.settings.loss_warning_percent}%). כדאי לבדוק מול מסמך הסוחר.`}</p>}
  </div>;
}
