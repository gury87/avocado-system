"use client";
import { useCallback, useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { dateLabel, localToday, money, normalizeWorkspace, type ReceiptWorkspace } from "../lib/receipts";
import { useCatalog } from "./FarmCatalog";
import { groupLoss, lossReport, yieldByPlot } from "../lib/analysis";
import { buildReport, groupReport, type GroupRow, type ReportData, type ReportFilters } from "../lib/reports";
import { downloadExcel, type ExcelSheet } from "../lib/excel";
import { useAuth } from "./AuthGate";

const num = (value: number) => value.toLocaleString("he-IL", { maximumFractionDigits: 3 });
const emptyFilters: ReportFilters = { from: "", to: "", trader: "", variety: "", plot: "" };
const control = "mt-1 min-h-11 w-full min-w-0 rounded-lg border border-zinc-300 bg-white p-2 text-base";
const previousDate = (date: string) => {
  const [year, month, day] = date.split("-").map(Number);
  const last = new Date(Date.UTC(year - 1, month, 0)).getUTCDate();
  return `${year - 1}-${String(month).padStart(2, "0")}-${String(Math.min(day, last)).padStart(2, "0")}`;
};
export default function Reports() {
  const { profile } = useAuth();
  const {catalog,plots,varieties}=useCatalog();
  const [data, setData] = useState<ReportData | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState("");
  const [filters, setFilters] = useState<ReportFilters>(emptyFilters);
  const [tab, setTab] = useState<"balances" | "prices" | "season" | "loss" | "yield">("balances");
  const [season, setSeason] = useState("all");
  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const result = await supabase.rpc("get_farm_reports"); if (result.error) throw result.error;
      const raw = result.data as ReportData;
      const normalized = normalizeWorkspace({ ...raw, shipments: [] } as ReceiptWorkspace);
      setData({ ...normalized, shipments: raw.shipments.map((s) => ({ ...s, id: String(s.id), trader_id: String(s.trader_id ?? ""), variety_id: String(s.variety_id ?? ""), plot_id: String(s.plot_id ?? ""), harvest_date: s.harvest_date || "", containers: Number(s.containers) })) });
    } catch { setData(null); setError("לא ניתן לטעון דוחות. בדוק את החיבור ונסה שוב."); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => {
    if (profile.role !== "admin") return;
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timer);
  }, [load, profile.role]);
  if (profile.role !== "admin") return null;
  const invalid = Boolean(filters.from && filters.to && filters.from > filters.to);
  const today = localToday();
  const rows = data ? buildReport(data, filters, today) : [];
  const total = groupReport(rows, () => "all")[0];
  const traders = groupReport(rows, (row) => row.shipment.trader_id).sort((a, b) => b.unpaid - a.unpaid);
  const prices = groupReport(rows, (row) => JSON.stringify([row.shipment.trader_id, row.shipment.variety_id])).filter((row) => row.kg > 0);
  const months = groupReport(rows, (row) => row.shipment.harvest_date?.slice(0, 7) || "לא ידוע").filter((row) => row.kg > 0);
  const groups = groupReport(rows, (row) => JSON.stringify([row.shipment.plot_id, row.shipment.variety_id]));
  const losses=data?lossReport(data,rows):[],lossGroups=groupLoss(losses),yields=yieldByPlot(rows,catalog.plots);
  const previousRows = data && filters.from && filters.to && !invalid ? buildReport(data, { ...filters, from: previousDate(filters.from), to: previousDate(filters.to) }, today) : [];
  const previous = groupReport(previousRows, () => "all")[0];
  const traderName = (id: string) => data?.traders.find((item) => String(item.id) === id)?.name || "סוחר לא משויך";
  const years = [...new Set([Number(today.slice(0, 4)) - (today.slice(5, 7) < "09" ? 1 : 0), ...(data?.shipments || []).filter((s) => s.harvest_date).map((s) => Number(s.harvest_date.slice(0, 4)) - (s.harvest_date.slice(5, 7) < "09" ? 1 : 0))])].sort((a, b) => b - a);
  const status = loading ? "טוען דוחות…" : invalid ? "יש לתקן את טווח התאריכים" : !rows.length ? "אין שיווקים התואמים לסינון" : "";
  const average = (row: GroupRow) => row.kg ? money(row.revenue / row.kg) : "—";
  const summary = (row?: GroupRow) => [row?.containers || 0, row?.unpaid || 0, row?.kg || 0, (row?.revenue || 0) / 100, row?.missingCost ? null : (row?.cost || 0) / 100];
  const exportReport = () => {
    if (!data || loading || invalid) return;
    const sheets: ExcelSheet[] = [
      { name: "סיכום", rows: [
        ["דוח שיווקים", "נוצר בתאריך", today], ["טווח תאריכי שיווק", filters.from || "הכל", filters.to || "הכל"],
        ["סוחר", filters.trader ? traderName(filters.trader) : "הכל"], ["זן", varieties[filters.variety] || "הכל"], ["חלקה", plots[filters.plot] || "הכל"],
        ["הכנסות משיוכים בתקבולים מאושרים בלבד. הפרשי תשלום ברמת התקבול אינם מיוחסים לחלקות. עלות חסרה נשארת ריקה."],
        ["תקופה", "מיכלים", "טרם שולמו", "נטו ששולם ק״ג", "הכנסות משויכות ₪", "עלות קטיף ₪"],
        ["נוכחית", ...summary(total)], ...(filters.from && filters.to ? [["מקבילה בשנה הקודמת", ...summary(previous)]] : []),
      ] },
      { name: "יתרות לפי סוחר", rows: [["סוחר", "מיכלים ששווקו", "טרם שולמו", "שיווק פתוח מוקדם ביותר"], ...traders.map((g) => [traderName(g.key), g.containers, g.unpaid, rows.filter((r) => r.shipment.trader_id === g.key && r.unpaid > 0).map((r) => r.shipment.harvest_date).filter(Boolean).sort()[0] || ""]) ] },
      { name: "מחיר לפי סוחר וזן", rows: [["סוחר", "זן", "נטו ק״ג", "הכנסות משויכות ₪", "ממוצע ₪ לק״ג"], ...prices.map((g) => { const [trader, variety] = JSON.parse(g.key); return [traderName(trader), varieties[variety] || "לא ידוע", g.kg, g.revenue / 100, g.revenue / 100 / g.kg]; })] },
      { name: "מגמה חודשית", rows: [["חודש שיווק", "נטו ק״ג", "הכנסות משויכות ₪", "ממוצע ₪ לק״ג"], ...months.map((g) => [g.key, g.kg, g.revenue / 100, g.revenue / 100 / g.kg])] },
      { name: "עונה לפי חלקה וזן", rows: [["חלקה", "זן", "מיכלים", "טרם שולמו", "נטו ק״ג", "הכנסות משויכות ₪", "עלות קטיף ₪"], ...groups.map((g) => { const [plot, variety] = JSON.parse(g.key); return [plots[plot] || "לא ידוע", varieties[variety] || "לא ידוע", ...summary(g)]; })] },
      { name: "פירוט שיווקים", rows: [["מזהה", "תאריך שיווק", "סוחר", "זן", "חלקה", "מיכלים", "שויכו לתשלום", "טרם שולמו", "ימים משיווק", "נטו ק״ג", "הכנסות משויכות ₪", "עלות קטיף ₪"], ...rows.map((r) => [r.shipment.id, r.shipment.harvest_date, traderName(r.shipment.trader_id), varieties[r.shipment.variety_id] || "לא ידוע", plots[r.shipment.plot_id] || "לא ידוע", Number(r.shipment.containers), r.paid, r.unpaid, r.age, r.kg, r.revenue / 100, r.cost === null ? null : r.cost / 100])] },
    ];
    sheets.push({name:"משקל ופחת",rows:[["סוחר","זן","ברוטו ק״ג","משקל מיכלים ק״ג","נטו ק״ג","פחת ק״ג","פחת %"],...lossGroups.map((g)=>{const[t,v]=JSON.parse(g.key);return[traderName(t),varieties[v]||"לא ידוע",g.gross,g.tare,g.net,g.loss,g.percent];}),[],["בדיקה לפי שורת תקבול · פער חיובי = תאריך הסוחר מאוחר מתאריך השיווק"],["תקבול","שורה","סוחר","זן","תאריך סוחר","תאריכי שיווק","פערי ימים בהתאמה לתאריכי השיווק","פחת ק״ג","פחת %","מעל הסף"],...losses.map(g=>[g.receiptId,g.id,traderName(g.trader),varieties[g.variety]||"לא ידוע",g.date,g.shipments.map(s=>s.date||"חסר").join("; "),g.shipments.map(s=>s.days===null?"חסר":String(s.days)).join("; "),g.loss,g.percent,g.percent!==null&&g.percent>catalog.settings.loss_warning_percent?"כן":"לא"])]});
    sheets.push({name:"יבול לדונם",rows:[["חלקה","דונם","מיכלים","מיכלים לדונם","נטו ששולם ק״ג","ק״ג לדונם","הכנסות משויכות ₪","הכנסות לדונם ₪","נתוני משקל חלקיים"],...yields.map((g)=>[g.name,g.area,g.containers,g.containersPerDunam,g.net,g.netPerDunam,g.revenue/100,g.revenuePerDunam===null?null:g.revenuePerDunam/100,g.partial?"כן":"לא"])]});
    downloadExcel(sheets, `avocado-report-${today}.xlsx`);
  };
  return <section className="space-y-4 text-zinc-900" aria-label="דוחות ומעקב">
    <h2 className="text-2xl font-bold">דוחות ומעקב</h2>
    <div className="rounded-2xl border border-zinc-200 bg-white p-4">
      <div className="grid grid-cols-1 gap-3 min-[360px]:grid-cols-2 lg:grid-cols-3">
        <label className="min-w-0 text-sm">עונה<select value={season} className={control} onChange={(e) => {
          const value = e.target.value; setSeason(value);
          setFilters({ ...filters, from: value === "all" ? "" : `${value}-09-01`, to: value === "all" ? "" : `${Number(value) + 1}-08-31` });
        }}><option value="all">כל העונות / טווח ידני</option>{years.map((year) => <option key={year} value={year}>{year}–{year + 1}</option>)}</select></label>
        {([{ key: "from", label: "מתאריך שיווק" }, { key: "to", label: "עד תאריך שיווק" }] as const).map(({ key, label }) => <label key={key} className="min-w-0 text-sm">{label}<input type="date" value={filters[key]} aria-invalid={invalid} className={control} onChange={(e) => { setSeason("all"); setFilters({ ...filters, [key]: e.target.value }); }} /></label>)}
        <label className="min-w-0 text-sm">סוחר<select className={control} value={filters.trader} onChange={(e) => setFilters({ ...filters, trader: e.target.value })}><option value="">כל הסוחרים</option>{data?.traders.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
        {([{ key: "variety", label: "זן", values: varieties }, { key: "plot", label: "חלקה", values: plots }] as const).map(({ key, label, values }) => <label key={key} className="min-w-0 text-sm">{label}<select className={control} value={filters[key]} onChange={(e) => setFilters({ ...filters, [key]: e.target.value })}><option value="">הכל</option>{Object.entries(values).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>)}
      </div>
      <p className="mt-3 text-xs text-zinc-500">עונה: ספטמבר–אוגוסט; אפשר לשנות תאריכים. כל הדוחות לפי תאריך השיווק המקורי.</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" className="min-h-11 rounded-lg border px-3" onClick={() => { setFilters(emptyFilters); setSeason("all"); }}>נקה סינון</button>
        <button type="button" disabled={loading} className="min-h-11 rounded-lg border px-3" onClick={() => { void load(); }}>רענון דוחות</button>
        <button type="button" disabled={loading || !data || invalid || !rows.length} className="min-h-11 rounded-lg bg-green-800 px-3 text-white disabled:opacity-50" onClick={exportReport}>ייצוא לאקסל</button>
      </div>
    </div>
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3" aria-label="סוג דוח">{([{ key: "balances", name: "יתרות סוחרים" }, { key: "prices", name: "מחירים ומגמות" }, { key: "season", name: "סיכום עונה" },{key:"loss",name:"משקל ופחת"},{key:"yield",name:"יבול לדונם"}] as const).map(({ key, name }) => <button key={key} type="button" aria-pressed={tab === key} className={`min-h-11 min-w-0 rounded-xl p-2 text-sm ${tab === key ? "bg-zinc-900 text-white" : "bg-white"}`} onClick={() => setTab(key)}>{name}</button>)}</div>
    {error && <p role="alert" className="rounded-xl bg-white p-4 text-red-700">{error}</p>}
    {status && <p role="status" className="rounded-xl bg-white p-4">{status}</p>}
    {!loading && data && !invalid && <>
      {tab==="loss"&&<div className="space-y-3"><h3 className="text-xl font-semibold">השוואת משקל ופחת לפי סוחר וזן</h3><p className="text-xs text-zinc-600">פחת = ברוטו פחות משקל המיכלים ופחות נטו. האחוז מחושב ממשקל הפרי לאחר ניכוי המיכלים. כולל תקבולים מאושרים בלבד; בשיוך מפוצל הפחת מחולק לפי מספר המיכלים. סף הסימון: {catalog.settings.loss_warning_percent}%.</p>
        {!lossGroups.length&&<p>אין נתוני שקילה מאושרים בסינון הנוכחי.</p>}
        {lossGroups.map((g)=>{const[t,v]=JSON.parse(g.key);return <div key={g.key} data-loss-group className="rounded-xl border border-zinc-200 bg-white p-4"><h4 className="font-semibold">{traderName(t)} · {varieties[v]||"לא ידוע"}</h4><p className="text-sm">ברוטו {num(g.gross)} · מיכלים {num(g.tare)} · נטו {num(g.net)} ק״ג</p><p className="font-bold">פחת {num(g.loss)} ק״ג · {g.percent===null?"—":num(g.percent)+"%"}</p></div>;})}
        <h4 className="font-semibold">בדיקה לפי שורת תקבול</h4>{losses.map((g)=>{const above=g.percent!==null&&g.percent>catalog.settings.loss_warning_percent,invalid=g.loss< -0.0005;return <div key={g.id} data-loss-line data-loss-warning={above||invalid||undefined} className={`rounded-xl border p-3 text-sm ${above||invalid?"border-amber-300 bg-amber-50":"border-zinc-200 bg-white"}`}><p>{traderName(g.trader)} · {varieties[g.variety]}</p><p>תאריך הסוחר: {dateLabel(g.date)}</p>{g.shipments.map((s,i)=><p key={s.id} className="mt-1">תאריך שיווק{g.shipments.length>1?` (${i+1})`:""}: {dateLabel(s.date)} · {s.days===null?"הפרש ימים לא זמין — חסר תאריך":s.days===0?"באותו יום":`פער: ${Math.abs(s.days)} ימים (${s.days>0?"תאריך הסוחר מאוחר יותר":"תאריך הסוחר מוקדם מתאריך השיווק"})`}</p>)}<p className="mt-2 font-semibold">פחת {num(g.loss)} ק״ג · {g.percent===null?"—":num(g.percent)+"%"}</p>{(above||invalid)&&<p className="font-medium text-amber-900">{invalid?"פער לא תקין — יש לבדוק נתונים":"מעל סף הפחת שהוגדר"}</p>}</div>;})}
      </div>}
      {tab==="yield"&&<div className="space-y-3"><h3 className="text-xl font-semibold">השוואת יבול בין חלקות לפי שטח</h3><p className="text-xs text-zinc-600">לפי שטח החלקה הנוכחי בדונמים והסינון שנבחר. מומלץ לבחור עונה להשוואה. ק״ג והכנסות מבוססים רק על שיוכים מאושרים; כשנותרו מיכלים פתוחים, נתונים אלה חלקיים.</p>{yields.map((g)=><div key={g.id} className="rounded-xl border border-zinc-200 bg-white p-4"><h4 className="font-semibold">{g.name} · {g.area?num(g.area)+" דונם":"שטח חסר"}</h4><p className="text-sm">{num(g.containers)} מיכלים · {num(g.net)} ק״ג נטו ששולם · {money(g.revenue)}</p>{g.area?<dl className="mt-2 grid grid-cols-1 gap-2 text-sm min-[360px]:grid-cols-2"><div><dt>מיכלים לדונם</dt><dd className="font-bold">{num(g.containersPerDunam!)}</dd></div><div><dt>ק״ג ששולם לדונם</dt><dd className="font-bold">{num(g.netPerDunam!)}</dd></div><div><dt>הכנסות משויכות לדונם</dt><dd className="font-bold">{money(g.revenuePerDunam!)}</dd></div></dl>:<p className="mt-2 text-sm text-amber-900">יש להשלים שטח בהגדרות כדי לחשב נתונים לדונם.</p>}{g.partial&&<p className="mt-2 text-xs text-amber-900">נתוני המשקל וההכנסות חלקיים — טרם שולמו כל המיכלים.</p>}</div>)}</div>}
      {tab === "balances" && <div className="space-y-3">
        <h3 className="text-xl font-semibold">יתרות פתוחות לפי סוחר</h3>
        <p className="text-sm text-zinc-600">{num(total?.unpaid || 0)} מיכלים טרם שויכו לתקבול מאושר. אין אומדן כספי למיכלים שטרם תומחרו.</p>
        {traders.map((g) => {
          const open = rows.filter((r) => r.shipment.trader_id === g.key && r.unpaid > 0).sort((a, b) => a.shipment.harvest_date.localeCompare(b.shipment.harvest_date));
          return <details key={g.key} className="rounded-xl border border-zinc-200 bg-white p-3"><summary className="min-h-11 cursor-pointer"><strong>{traderName(g.key)}</strong><span className="block text-sm">{num(g.unpaid)} מיכלים פתוחים מתוך {num(g.containers)}{open[0] ? ` · הוותיק ביותר: ${open[0].age ?? "—"} ימים` : " · הכל שויך לתשלום"}</span></summary>
            {open.map((r) => <div key={r.shipment.id} className="border-t border-zinc-100 py-3 text-sm"><p>{dateLabel(r.shipment.harvest_date)} · {varieties[r.shipment.variety_id] || "לא ידוע"} · {plots[r.shipment.plot_id] || "לא ידוע"}</p><p>{num(r.unpaid)} פתוחים מתוך {num(Number(r.shipment.containers))} · שויכו {num(r.paid)} · {r.age ?? "—"} ימים משיווק</p></div>)}
          </details>;
        })}
      </div>}
      {tab === "prices" && <div className="space-y-4">
        <h3 className="text-xl font-semibold">מחיר ממוצע לק״ג לפי סוחר וזן</h3>
        <p className="text-xs text-zinc-600">סכומי שורות מאושרות חלקי הנטו ששויך — ממוצע משוקלל, כולל תיקוני סכום בשורה. הפרשים ברמת התקבול אינם נכללים.</p>
        {!prices.length && <p>אין נתוני תשלום מאושרים בסינון הנוכחי.</p>}
        {prices.map((g) => { const [trader, variety] = JSON.parse(g.key); return <div key={g.key} className="flex items-center justify-between gap-3 rounded-xl bg-white p-4"><div className="min-w-0"><h4 className="font-semibold">{traderName(trader)} · {varieties[variety] || "לא ידוע"}</h4><p className="text-xs">{num(g.kg)} ק״ג · {money(g.revenue)}</p></div><p className="shrink-0 text-lg font-bold">{average(g)}<span className="block text-xs font-normal">לק״ג</span></p></div>; })}
        <div className="rounded-xl bg-white p-4"><h4 className="mb-3 font-semibold">מגמה חודשית לפי תאריך שיווק</h4>{months.map((g) => <div key={g.key} className="mb-3"><div className="flex justify-between gap-2 text-sm"><span>{g.key}</span><span>{average(g)} לק״ג · {num(g.kg)} ק״ג</span></div><div className="mt-1 h-2 rounded bg-zinc-100"><div className="h-2 rounded bg-green-700" style={{ width: `${Math.max(0, g.revenue / g.kg) / Math.max(1, ...months.map((m) => m.revenue / m.kg)) * 100}%` }} /></div></div>)}</div>
      </div>}
      {tab === "season" && <div className="space-y-4">
        <h3 className="text-xl font-semibold">סיכום עונה</h3>
        <div className="grid grid-cols-1 gap-3 min-[360px]:grid-cols-2">
          {[["מיכלים ששווקו", num(total?.containers || 0)], ["מיכלים פתוחים", num(total?.unpaid || 0)], ["נטו ששולם (ק״ג)", num(total?.kg || 0)], ["הכנסות משויכות", money(total?.revenue || 0)], ["עלות קטיף", total?.missingCost ? `${money(total.cost)} · נתון חלקי` : money(total?.cost || 0)], ["הכנסות משויכות פחות קטיף", total?.missingCost ? "חסרים נתוני עלות" : money((total?.revenue || 0) - (total?.cost || 0))]].map(([label, value]) => <div key={label} className="rounded-xl bg-white p-4"><h4 className="text-sm text-zinc-500">{label}</h4><p className="mt-2 break-words text-xl font-bold">{value}</p></div>)}
        </div>
        <p className="text-xs text-zinc-600">הכנסות משויכות מבוססות על שורות תקבולים מאושרים. ההפרש לאחר קטיף אינו רווח סופי: יתרות פתוחות והוצאות נוספות אינן כלולות. עלויות חסרות אינן נחשבות אפס.</p>
        {filters.from && filters.to ? <div className="rounded-xl bg-white p-4"><h4 className="font-semibold">השוואה לתקופה המקבילה בשנה הקודמת</h4><p className="text-sm">{dateLabel(previousDate(filters.from))}–{dateLabel(previousDate(filters.to))}</p>{previousRows.length ? <p className="mt-2 text-sm">{num(previous?.containers || 0)} מיכלים · {money(previous?.revenue || 0)} הכנסות משויכות · {num(previous?.unpaid || 0)} מיכלים פתוחים</p> : <p className="mt-2 text-sm">אין נתונים לתקופה המקבילה.</p>}</div> : <p className="text-sm">בחר עונה או טווח תאריכים מלא להשוואה לשנה הקודמת.</p>}
        <h4 className="font-semibold">פירוט לפי חלקה וזן</h4>
        {groups.map((g) => { const [plot, variety] = JSON.parse(g.key); return <div key={g.key} className="rounded-xl bg-white p-4 text-sm"><h5 className="font-semibold">{plots[plot] || "לא ידוע"} · {varieties[variety] || "לא ידוע"}</h5><p>{num(g.containers)} מיכלים · {num(g.unpaid)} פתוחים · {num(g.kg)} ק״ג ששולמו</p><p>הכנסות משויכות: {money(g.revenue)}</p><p>קטיף: {money(g.cost)}{g.missingCost ? ` · עלות חסרה ב־${g.missingCost} שיווקים` : ""}</p></div>; })}
      </div>}
    </>}
  </section>;
}
