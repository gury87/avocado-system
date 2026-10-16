"use client";
import { useState } from "react";
import { monthlyVarietyPrices, type ReportRow } from "../lib/reports";

const colors = ["#15803d", "#1d4ed8", "#b45309", "#a21caf", "#0e7490", "#be123c", "#6d28d9", "#4d7c0f"];
function color(id: string) { return colors[([...id].reduce((n,c)=>n*31+c.charCodeAt(0),0) >>> 0) % colors.length]; }
const number = (n:number)=>n.toLocaleString("he-IL",{maximumFractionDigits:2});
export default function MonthlyPriceChart({ rows, varieties }: { rows: ReportRow[]; varieties: Record<string,string> }) {
  const chart=monthlyVarietyPrices(rows);
  const [selected,setSelected]=useState("");
  const points=chart.series.flatMap(s=>s.points.flatMap(p=>p?[{...p,id:s.id,key:s.id+":"+p.month}]:[]));
  const detail=points.find(p=>p.key===selected);
  const max=Math.max(1,...points.map(p=>p.price))*1.1;
  const x=(i:number)=>48+(chart.months.length===1?142:i/(chart.months.length-1)*284);
  const y=(price:number)=>210-price/max*166;
  return <section className="min-w-0 rounded-xl bg-white p-3" aria-label="גרף מחיר חודשי לפי זן">
    <h4 className="font-semibold">מחיר ממוצע לק״ג לפי זן וחודש</h4>
    <p className="mt-1 text-xs text-zinc-600">ממוצע משוקלל לפי תאריך השיווק. חודש ללא נתונים מוצג כהפסקה בקו. לחצו על נקודה לפירוט.</p>
    {!points.length ? <p className="py-4 text-sm">אין נתוני מחיר בסינון הנוכחי.</p> : <>
      <svg viewBox="0 0 350 290" className="mt-3 w-full" role="group" aria-label="ציר X חודש; ציר Y מחיר ממוצע לקילוגרם בשקלים" direction="ltr">
        <text x="48" y="19" fontSize="16" textAnchor="start">מחיר ממוצע לק״ג (₪)</text>
        {[0,1,2,3,4].map(i=><g key={i}><line x1="48" x2="332" y1={y(max*i/4)} y2={y(max*i/4)} stroke="#e4e4e7"/><text x="40" y={y(max*i/4)+4} fontSize="14" textAnchor="end">{number(max*i/4)}</text></g>)}
        {chart.months.map((month,i)=>(i===0||i===chart.months.length-1||i%Math.max(1,Math.ceil(chart.months.length/3))===0)&&<text key={month} x={x(i)} y="232" textAnchor="end" transform={`rotate(-30 ${x(i)} 232)`} fontSize="14">{month}</text>)}
        <text x="190" y="282" fontSize="16" textAnchor="middle">חודש</text>
        {chart.series.map(s=><g key={s.id}>
          <path d={s.points.map((p,i)=>p?`${i>0&&s.points[i-1]?"L":"M"}${x(i)},${y(p.price)}`:"").join(" ")} fill="none" stroke={color(s.id)} strokeWidth="2.5"/>
          {s.points.map((p,i)=>p&&<g key={p.month}>
            <circle cx={x(i)} cy={y(p.price)} r="4" fill={color(s.id)}/>
            <circle cx={x(i)} cy={y(p.price)} r="12" fill="transparent" tabIndex={0} role="button" aria-label={`${varieties[s.id]||s.id}, ${p.month}: ${number(p.price)} ₪ לק״ג, ${number(p.kg)} ק״ג`} onClick={()=>setSelected(s.id+":"+p.month)} onFocus={()=>setSelected(s.id+":"+p.month)} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();setSelected(s.id+":"+p.month);}}}><title>{varieties[s.id]||s.id} · {p.month} · {number(p.price)} ₪ לק״ג · {number(p.kg)} ק״ג</title></circle>
          </g>)}
        </g>)}
      </svg>
      <ul className="flex flex-wrap gap-x-4 gap-y-2 text-xs">{chart.series.map(s=><li key={s.id} className="flex items-center gap-1"><span className="inline-block h-1 w-5" style={{backgroundColor:color(s.id)}}/>{varieties[s.id]||s.id}</li>)}</ul>
      <label className="mt-3 block text-sm">פירוט נקודה<select value={detail?selected:""} onChange={e=>setSelected(e.target.value)} className="mt-1 min-h-11 w-full rounded-lg border p-2 text-base"><option value="">בחרו חודש וזן</option>{points.map(p=><option key={p.key} value={p.key}>{p.month} · {varieties[p.id]||p.id}</option>)}</select></label>
      <p aria-live="polite" className="mt-2 min-h-10 text-sm">{detail?`${varieties[detail.id]||detail.id} · ${detail.month}: ${number(detail.price)} ₪ לק״ג · ${number(detail.kg)} ק״ג`:"בחרו נקודה בגרף או ברשימה להצגת המחיר והמשקל."}</p>
    </>}
  </section>;
}
