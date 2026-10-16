"use client";

import { useCallback, useEffect, useState } from "react";
import { Pencil } from "lucide-react";
import { supabase } from "./lib/supabase";
import Dashboard from "./components/Dashboard";
import AuthGate, { useAuth } from "./components/AuthGate";
import Receipts from "./components/Receipts";
import Reports from "./components/Reports";
import FarmCatalogProvider, { useCatalog, useFarmToday } from "./components/FarmCatalog";
import FarmSettings from "./components/FarmSettings";
import { defaultEntry, isOverdue, shipmentAge } from "./lib/catalog";
import type { PaidWeight } from "./lib/receipts";
import ShipmentEditor from "./components/ShipmentEditor";
import { sortShipments, type ShipmentSort, type ShipmentSortKey } from "./lib/shipments";

const today = new Date().toISOString().split("T")[0];

type Shipment = {
  id: string;
  date: string;
  variety: string;
  plot: string;
  containers: number;
  size: string;
  picker: string;
  varietyId: number;
  plotId: number;
  editVersion: number;
  traderId: string;
  pickingRate: number | null;
  pickingCost: number | null;
};

export default function Home() {
  return <AuthGate><FarmCatalogProvider><FarmApp /></FarmCatalogProvider></AuthGate>;
}

function FarmApp() {
  const { catalog, plots, varieties } = useCatalog();
  const farmToday=useFarmToday();
  const { profile, setUnsavedChanges, appDestination } = useAuth();
  const canCreate = profile.role === "admin" || profile.role === "worker";
  const canDelete = profile.role === "admin";
  const [activeTab, setActiveTab] = useState<
    "dashboard" | "shipments" | "shipment-list" | "receipts" | "reports" | "settings"
  >(appDestination);

  const [shipments, setShipments] = useState<Shipment[]>([]);
  const [editingShipment, setEditingShipment] = useState<Shipment | null>(null);
  const [shipmentEditDirty, setShipmentEditDirty] = useState(false);
  const [listSort, setListSort] = useState<ShipmentSort>({ key: "date", direction: "desc" });
  const toggleSort = (key: ShipmentSortKey) => setListSort((current) => ({ key, direction: current.key === key && current.direction === "asc" ? "desc" : "asc" }));
  const sortIndicator = (key: ShipmentSortKey) => listSort.key === key ? (listSort.direction === "asc" ? " ↑" : " ↓") : " ↕";
  const [paidWeights, setPaidWeights] = useState<PaidWeight[] | null>(null);
  const paidShipmentIds = new Set((paidWeights || []).filter((item) => item.containers > 0).map((item) => item.harvest_event_id));
  const [weightsError, setWeightsError] = useState(false);
  const paidByShipment=new Map(paidWeights?.map((p)=>[p.harvest_event_id,p.containers])||[]);
  const overdueIds=new Set(paidWeights&&!weightsError?shipments.filter((s)=>isOverdue(s.date,s.containers,paidByShipment.get(s.id)||0,catalog.settings.overdue_days,farmToday)).map((s)=>s.id):[]);
  const [receiptsDirty, setReceiptsDirty] = useState(false);
  const [settingsDirty, setSettingsDirty] = useState(false);
  const selectTab = (tab: typeof activeTab) => {
    if (tab === activeTab) return;
    if ((receiptsDirty || shipmentEditDirty || settingsDirty) && !window.confirm("יש שינויים שלא נשמרו. לעזוב אותם?")) return;
    setSettingsDirty(false);
    setEditingShipment(null);
    setShipmentEditDirty(false);
    setReceiptsDirty(false);
    setUnsavedChanges(false);
    setActiveTab(tab);
  };
  const loadPaidWeights = useCallback(async () => {
    try {
      const records: PaidWeight[] = [];
      for (let offset = 0; ; offset += 500) {
        const { data, error } = await supabase.rpc("get_paid_shipment_weights")
          .order("harvest_event_id", { ascending: true }).range(offset, offset + 499);
        if (error) throw error;
        records.push(...(data as PaidWeight[]));
        if (data.length < 500) break;
      }
      setPaidWeights(records.map((item) => ({ harvest_event_id: String(item.harvest_event_id), net_weight: Number(item.net_weight), containers: Number(item.containers) })));
      setWeightsError(false);
    } catch {
      setPaidWeights(null);
      setWeightsError(true);
    }
  }, []);
  useEffect(() => () => setUnsavedChanges(false), [setUnsavedChanges]);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [shipmentLimit, setShipmentLimit] = useState("5");
  const [varietyFilter, setVarietyFilter] = useState("");
  const [plotFilter, setPlotFilter] = useState("");
  const [listFilters, setListFilters] = useState({
    variety: "",
    plot: "",
    containers: "",
    fromDate: "",
    toDate: "",
  });
  const invalidDateRange = Boolean(
    listFilters.fromDate && listFilters.toDate && listFilters.fromDate > listFilters.toDate
  );
  const listShipments = sortShipments(shipments.filter((shipment) =>
    !invalidDateRange &&
    (!listFilters.variety || shipment.variety === listFilters.variety) &&
    (!listFilters.plot || shipment.plot === listFilters.plot) &&
    (!listFilters.containers || shipment.containers === Number(listFilters.containers)) &&
    (!listFilters.fromDate || shipment.date >= listFilters.fromDate) &&
    (!listFilters.toDate || shipment.date <= listFilters.toDate)
  ), listSort);
  const listColumns = [
    { key: "variety", label: "זן" },
    { key: "plot", label: "חלקה" },
    { key: "containers", label: "מיכלים" },
  ] as const;
  const varietyOptions = [...new Set(shipments.map((shipment) => shipment.variety))]
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, "he"));
  const plotOptions = [...new Set(shipments.map((shipment) => shipment.plot))]
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, "he"));
  const filteredShipments = shipments.filter(
    (shipment) =>
      (!varietyFilter || shipment.variety === varietyFilter) &&
      (!plotFilter || shipment.plot === plotFilter)
  );
  const visibleShipments =
    shipmentLimit === "all"
      ? filteredShipments
      : filteredShipments.slice(0, Number(shipmentLimit));

  const [form, setForm] = useState({
    date: today,
    variety: defaultEntry(catalog.varieties, "1"),
    plot: defaultEntry(catalog.plots, "3"),
    containers: 1,
    picker: "נביל",
  });

  // Reusable function to load shipments from Supabase
  const loadShipments = useCallback(async () => {
    const records: {
      id: string | number; harvest_date: string; variety_id: number; plot_id: number;
      containers: number; container_size: string; edit_version?: number; trader_id: string | number | null; picking_rate?: number | null; picking_cost?: number | null;
    }[] = [];
    // Fetch all pages so the dashboard is not limited by the REST row cap.
    for (let offset = 0; ; offset += 500) {
      const { data, error } = await supabase
        .from("harvest_events")
        .select("*")
        .order("harvest_date", { ascending: false, nullsFirst: false })
        .order("id", { ascending: false })
        .range(offset, offset + 499);

      console.log("RAW DATA", data);
      console.log("LOAD ERROR", error);
      if (error) {
        console.error("Error loading shipments:", error);
        return;
      }
      records.push(...data);
      if (data.length < 500) break;
    }
  
  
    const uniqueRecords = [...new Map(records.map((record) => [String(record.id), record])).values()];
    const mappedShipments = uniqueRecords.map((record) => ({
      id: String(record.id),
      date: record.harvest_date,
      variety: varieties[String(record.variety_id)] || "זן לא ידוע",
      plot: plots[String(record.plot_id)] || "חלקה לא ידועה",
      containers: Number(record.containers),
      size: record.container_size, // Use the value directly from Supabase
      picker: "נביל", // Assuming picker is static for now
      varietyId: Number(record.variety_id),
      plotId: Number(record.plot_id),
      editVersion: record.edit_version ?? 0,
      traderId: String(record.trader_id ?? ""),
      pickingRate: record.picking_rate == null ? null : Number(record.picking_rate),
      pickingCost: record.picking_cost == null ? null : Number(record.picking_cost),
    }));
  
    setShipments(mappedShipments);
  }, [plots, varieties]);

  // Load shipments on page load
  useEffect(() => {
    // Defer the async load to avoid synchronous state updates inside an effect.
    const timer = window.setTimeout(() => { void loadShipments(); void loadPaidWeights(); }, 0);
    return () => window.clearTimeout(timer);
  }, [loadShipments, loadPaidWeights]);

  const addShipment = async () => {
    if (!canCreate) return;
    if (!catalog.varieties.some((e)=>e.id===form.variety&&e.active)||!catalog.plots.some((e)=>e.id===form.plot&&e.active)) { alert("יש לבחור חלקה וזן פעילים."); return; }
    const confirmationMessage = [
      "האם לשמור את השיווק הבא?",
      "",
      `תאריך: ${form.date.split("-").reverse().join("/")}`,
      `זן: ${varieties[form.variety]}`,
      `חלקה: ${plots[form.plot]}`,
      `מספר מיכלים: ${form.containers}`,
    ].join("\n");

    if (!window.confirm(confirmationMessage)) {
      return;
    }


    const newShipment = {
      harvest_date: form.date,
      trader_id: Number(defaultEntry(catalog.traders, "1")),
      variety_id: Number(form.variety),
      plot_id: Number(form.plot),
      picker_id: 1,
      containers: form.containers,
      container_size: "קטן",
      status: "pending",
    };

    const { error } = await supabase
      .from("harvest_events")
      .insert(newShipment);

    if (error) {
      console.error("Error saving shipment:", error);
      alert("שגיאה בשמירת השיווק");
    } else {
      alert("השיווק נשמר בהצלחה");

      // Reload shipments after successful insert
      loadShipments();

      // Clear form
      setForm({
        date: today,
        variety: defaultEntry(catalog.varieties, "1"),
        plot: defaultEntry(catalog.plots, "3"),
        containers: 1,
        picker: "נביל",
      });
    }
  };

  const deleteShipment = async (shipment: Shipment) => {
    if (!canDelete) return;
    if (deletingId !== null) return;

    const confirmationMessage = [
      "האם למחוק את השיווק?",
      "",
      `תאריך: ${shipment.date.split("-").reverse().join("/")}`,
      `זן: ${shipment.variety}`,
      `חלקה: ${shipment.plot}`,
      `מספר מיכלים: ${shipment.containers}`,
    ].join("\n");

    if (!window.confirm(confirmationMessage)) return;

    setDeletingId(shipment.id);
    try {
      const { data, error } = await supabase
        .from("harvest_events")
        .delete()
        .eq("id", shipment.id)
        .select("id");

      if (error || !data?.some((record) => String(record.id) === shipment.id)) {
        console.error("Error deleting shipment:", error);
        alert(error?.message.includes("farm_documents") ? "לשיווק מצורפים מסמכים. יש להסיר אותם בחלון העריכה לפני מחיקת השיווק."
          : error?.code === "23503" ? "לא ניתן למחוק שיווק המשויך לתקבול, כדי לשמור את היסטוריית הנתונים." : "השיווק לא נמחק. נסה שוב או בדוק את הרשאות המחיקה.");
        return;
      }

      setShipments((current) => current.filter((record) => record.id !== shipment.id));
    } catch (error) {
      console.error("Error deleting shipment:", error);
      alert("שגיאה במחיקת השיווק. נסה שוב.");
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <main
      dir="rtl"
      className="min-h-screen bg-zinc-100"
    >
      <div className="max-w-md mx-auto px-4 py-6 pb-24">
        <h1 className="text-3xl font-bold text-zinc-900 mb-4">
          🥑 מערכת שיווק אבוקדו
        </h1>

        <div className={`grid gap-2 mb-5 text-sm ${canDelete ? "grid-cols-2 min-[400px]:grid-cols-4" : "grid-cols-3"}`}>
          <button
            onClick={() => selectTab("shipments")}
            className={`flex-1 rounded-xl p-3 ${
              activeTab === "shipments"
                ? "bg-zinc-900 text-white"
                : "bg-white text-zinc-700"
            }`}
          >
            ראשי
          </button>

          <button
            onClick={() => selectTab("shipment-list")}
            className={`flex-1 rounded-xl p-3 ${
              activeTab === "shipment-list"
                ? "bg-zinc-900 text-white"
                : "bg-white text-zinc-700"
            }`}
          >
            שיווקים
          </button>

          <button
            onClick={() => selectTab("dashboard")}
            className={`flex-1 rounded-xl p-3 ${
              activeTab === "dashboard"
                ? "bg-zinc-900 text-white"
                : "bg-white text-zinc-700"
            }`}
          >
            דשבורד
          </button>
          {canDelete && <button
            onClick={() => selectTab("receipts")}
            className={`min-h-11 rounded-xl p-3 ${activeTab === "receipts" ? "bg-zinc-900 text-white" : "bg-white text-zinc-700"}`}
          >תקבולים</button>}
          {canDelete && <button onClick={() => selectTab("reports")} className={`min-h-11 rounded-xl p-3 ${activeTab === "reports" ? "bg-zinc-900 text-white" : "bg-white text-zinc-700"}`}>דוחות ומעקב</button>}
        </div>

        {activeTab === "reports" && canDelete && <Reports />}
        {activeTab === "settings" && canDelete && <FarmSettings onDirtyChange={(dirty)=>{setSettingsDirty(dirty);setUnsavedChanges(dirty);}} />}
        {activeTab === "dashboard" && (
          <Dashboard shipments={shipments} paidWeights={paidWeights} weightsError={weightsError} />
        )}
        {activeTab === "receipts" && canDelete && (
          <Receipts onChanged={() => { void loadPaidWeights(); }} onDirtyChange={(dirty) => { setReceiptsDirty(dirty); setUnsavedChanges(dirty); }} />
        )}

        {activeTab === "shipment-list" && (
          <section className="bg-white rounded-2xl border border-zinc-200 overflow-hidden">
            <h2 className="p-4 text-lg font-semibold text-zinc-900">רשימת שיווקים</h2>
            <p className="px-4 pb-3 text-xs text-zinc-500">לחץ על כותרת עמודה למיון עולה או יורד.</p>
            <p className="px-4 pb-3 text-xs text-amber-900">סימון בצהוב: יתרה פתוחה בשיווק שגילו מעל {catalog.settings.overdue_days} ימים.</p>
            {editingShipment && canCreate && <ShipmentEditor
              key={editingShipment.id}
              shipment={editingShipment}
              onClose={() => { setEditingShipment(null); setShipmentEditDirty(false); setUnsavedChanges(false); }}
              onDirtyChange={(dirty) => { setShipmentEditDirty(dirty); setUnsavedChanges(dirty); }}
              onSaved={async (updated) => {
                setShipments((current) => current.map((item) => item.id === updated.id ? { ...item, ...updated } : item));
                await Promise.all([loadShipments(), loadPaidWeights()]);
              }}
            />}
            <div className="space-y-3 px-4 pb-4 text-sm text-zinc-700">
              <div className="grid grid-cols-3 gap-2">
                {listColumns.map(({ key, label }) => <label key={key} className="min-w-0 text-xs">{label}
                  <select id={`list-${key}`} value={listFilters[key]}
                    onChange={(e) => setListFilters((current) => ({ ...current, [key]: e.target.value }))}
                    className="mt-1 min-h-11 w-full min-w-0 rounded-lg border border-zinc-300 bg-white px-1 text-base">
                    <option value="">הכל</option>
                    {[...new Set(shipments.map((shipment) => shipment[key]))].filter((value) => value !== "")
                      .sort((a, b) => key === "containers" ? Number(a) - Number(b) : String(a).localeCompare(String(b), "he"))
                      .map((value) => <option key={value} value={value}>{value}</option>)}
                  </select>
                </label>)}
              </div>
              <fieldset className="grid grid-cols-1 gap-3 min-[360px]:grid-cols-2">
                <legend className="mb-2 font-medium">טווח תאריכי שיווק</legend>
                <label className="min-w-0">
                  <span className="mb-1 block">מתאריך</span>
                  <input
                    type="date"
                    value={listFilters.fromDate}
                    max={listFilters.toDate || undefined}
                    onChange={(e) => setListFilters((current) => ({ ...current, fromDate: e.target.value }))}
                    aria-invalid={invalidDateRange}
                    className="min-h-11 w-full min-w-0 rounded-lg border border-zinc-300 bg-white p-2 text-base"
                  />
                </label>
                <label className="min-w-0">
                  <span className="mb-1 block">עד תאריך</span>
                  <input
                    type="date"
                    value={listFilters.toDate}
                    min={listFilters.fromDate || undefined}
                    onChange={(e) => setListFilters((current) => ({ ...current, toDate: e.target.value }))}
                    aria-invalid={invalidDateRange}
                    className="min-h-11 w-full min-w-0 rounded-lg border border-zinc-300 bg-white p-2 text-base"
                  />
                </label>
              </fieldset>
              {invalidDateRange && (
                <p role="alert" className="text-red-600">תאריך הסיום חייב להיות בתאריך ההתחלה או אחריו.</p>
              )}
              <button
                type="button"
                onClick={() => setListFilters({ variety: "", plot: "", containers: "", fromDate: "", toDate: "" })}
                className="min-h-11 rounded-lg border border-zinc-300 px-3"
              >
                נקה סינון
              </button>
            </div>
            <div className="overflow-x-auto">
              <table data-shipment-list className="w-full table-fixed text-right text-[11px] text-zinc-700 sm:table-auto sm:text-xs [&_td]:px-1 [&_th]:px-1">
                <caption className="sr-only">רשימת שיווקים עם סינון ומיון לפי עמודות</caption>
                <colgroup>
                  <col style={{ width: canCreate ? "25%" : "30%" }} />
                  <col style={{ width: canCreate ? "14%" : "18%" }} />
                  <col style={{ width: canCreate ? "15%" : "26%" }} />
                  <col style={{ width: canCreate ? "14%" : "18%" }} />
                  <col style={{ width: "8%" }} />
                  {canCreate && <col style={{ width: "24%" }} />}
                </colgroup>
                <thead className="bg-zinc-50 text-zinc-900">
                  <tr>
                    <th scope="col" aria-sort={listSort.key === "date" ? (listSort.direction === "asc" ? "ascending" : "descending") : "none"} className="px-2 py-2">
                      <button type="button" onClick={() => toggleSort("date")} className="min-h-11 whitespace-nowrap" aria-label="מיון לפי תאריך">תאריך<span aria-hidden="true">{sortIndicator("date")}</span></button>
                    </th>
                    {listColumns.map(({ key, label }) => (
                      <th key={key} scope="col" aria-sort={listSort.key === key ? (listSort.direction === "asc" ? "ascending" : "descending") : "none"} className="px-2 py-2">
                        <button type="button" onClick={() => toggleSort(key)} className="min-h-11 max-w-full" aria-label={`מיון לפי ${label}`}>{label}<span aria-hidden="true">{sortIndicator(key)}</span></button>
                      </th>
                    ))}
                    <th scope="col" className="px-1 py-2"><span className="sr-only">שיוך תשלום</span></th>
                    {canCreate && <th scope="col" className="px-1 py-2"><span className="sr-only">פעולות</span></th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100">
                  {listShipments.map((shipment) => (
                    <tr key={shipment.id} data-overdue={overdueIds.has(shipment.id)||undefined} className={overdueIds.has(shipment.id) ? "bg-amber-50" : undefined}>
                      <td className="whitespace-nowrap px-2 py-2">
                        <span dir="ltr">{shipment.date.split("-").reverse().join("/")}</span>
                        {overdueIds.has(shipment.id) && <span className="block whitespace-normal text-[10px] font-semibold text-amber-900" title={`${shipmentAge(shipment.date,farmToday)} ימים משיווק · יתרה פתוחה מעל ${catalog.settings.overdue_days} ימים`}>ממתין לתשלום</span>}
                      </td>
                      <td className="px-2 py-2">{shipment.variety}</td>
                      <td className="break-words px-2 py-2">{shipment.plot}</td>
                      <td className="px-2 py-2">{shipment.containers}</td>
                      <td className="px-1 py-2 text-center">
                        {paidShipmentIds.has(shipment.id) && <span title="שויך תשלום מאושר לשיווק (מלא או חלקי)" className="text-lg font-bold text-green-700"><span aria-hidden="true">₪</span><span className="sr-only">שויך תשלום מאושר לשיווק (מלא או חלקי)</span></span>}
                      </td>
                      {canCreate && <td className="px-1 py-1"><div className="flex items-center justify-center">
                        <button type="button" disabled={deletingId !== null} onClick={() => setEditingShipment(shipment)} title="עריכת שיווק" aria-label={`ערוך שיווק מתאריך ${shipment.date.split("-").reverse().join("/")}`} className="inline-flex h-11 w-8 shrink-0 items-center justify-center rounded-lg text-blue-700 disabled:opacity-40"><Pencil size={16} aria-hidden="true" /></button>
                        {canDelete && <button
                          type="button"
                          onClick={() => deleteShipment(shipment)}
                          disabled={deletingId !== null}
                          aria-label={`מחק שיווק ${shipment.variety} מחלקת ${shipment.plot} בתאריך ${shipment.date.split("-").reverse().join("/")}`}
                          className="flex h-11 w-8 shrink-0 items-center justify-center rounded-lg text-red-600 hover:bg-red-50 disabled:opacity-40"
                        >
                          <span aria-hidden="true" className="text-sm font-bold">✕</span>
                        </button>}
                      </div></td>}
                    </tr>
                  ))}
                  {listShipments.length === 0 && (
                    <tr><td colSpan={canCreate ? 6 : 5} className="p-4 text-center text-zinc-500">אין שיווקים התואמים לסינון</td></tr>
                  )}
                </tbody>
              </table>
            </div>
            <p aria-live="polite" className="border-t border-zinc-200 px-4 py-3 text-xs text-zinc-500">
              {deletingId !== null ? "מוחק שיווק…" : `מוצגים ${listShipments.length} מתוך ${shipments.length} שיווקים`}
            </p>
          </section>
        )}

        {activeTab === "shipments" && (
          <>
            {canCreate && <div className="bg-white rounded-2xl border border-zinc-200 p-5 mb-4">
              <h2 className="text-xl font-semibold text-zinc-900 mb-3">
                שיווק חדש
              </h2>

              <div className="space-y-3">
                <input
                  type="date"
                  value={form.date}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      date: e.target.value,
                    })
                  }
                  className="w-full rounded-xl border border-zinc-300 p-3 text-zinc-900"
                />

                <select
                  value={form.variety}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      variety: e.target.value,
                    })
                  }
                  className="w-full rounded-xl border border-zinc-300 p-3 text-zinc-900"
                >
                  {!catalog.varieties.some((e)=>e.id===form.variety&&e.active)&&<option value="">בחר זן פעיל</option>}
                  {catalog.varieties.filter((e)=>e.active).map((e)=><option key={e.id} value={e.id}>{e.name}</option>)}
                </select>

                <select
                  value={form.plot}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      plot: e.target.value,
                    })
                  }
                  className="w-full rounded-xl border border-zinc-300 p-3 text-zinc-900"
                >
                  {!catalog.plots.some((e)=>e.id===form.plot&&e.active)&&<option value="">בחר חלקה פעילה</option>}
                  {catalog.plots.filter((e)=>e.active).map((e)=><option key={e.id} value={e.id}>{e.name}</option>)}
                </select>

                <input
                  type="number"
                  min="1"
                  value={form.containers}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      containers: Number(e.target.value),
                    })
                  }
                  className="w-full rounded-xl border border-zinc-300 p-3 text-zinc-900"
                />

                <button
                  onClick={addShipment}
                  className="w-full bg-zinc-900 text-white rounded-xl py-3"
                >
                  שמור שיווק
                </button>
              </div>
            </div>}

            <section className="bg-white rounded-2xl border border-zinc-200 overflow-hidden">
              <div className="flex flex-wrap items-center justify-between gap-3 p-4">
                <h2 className="text-lg font-semibold text-zinc-900">
                  שיווקים אחרונים
                </h2>
                <div className="flex items-center gap-2 text-sm text-zinc-700">
                  <label htmlFor="shipment-limit">הצג</label>
                  <select
                    id="shipment-limit"
                    value={shipmentLimit}
                    onChange={(e) => setShipmentLimit(e.target.value)}
                    className="rounded-lg border border-zinc-300 bg-white p-2 text-zinc-900"
                  >
                    <option value="5">5</option>
                    <option value="10">10</option>
                    <option value="20">20</option>
                    <option value="50">50</option>
                    <option value="all">הכל</option>
                  </select>
                </div>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-right text-xs text-zinc-700">
                  <caption className="sr-only">רשימת השיווקים האחרונים</caption>
                  <thead className="bg-zinc-50 text-zinc-900">
                    <tr>
                      <th scope="col" className="px-3 py-2">תאריך</th>
                      <th scope="col" className="px-3 py-2">
                        <label htmlFor="variety-filter" className="block mb-1">זן</label>
                        <select
                          id="variety-filter"
                          value={varietyFilter}
                          onChange={(e) => setVarietyFilter(e.target.value)}
                          className="w-full rounded-md border border-zinc-300 bg-white p-1 font-normal"
                        >
                          <option value="">כל הזנים</option>
                          {varietyOptions.map((variety) => (
                            <option key={variety} value={variety}>{variety}</option>
                          ))}
                        </select>
                      </th>
                      <th scope="col" className="px-3 py-2">
                        <label htmlFor="plot-filter" className="block mb-1">חלקה</label>
                        <select
                          id="plot-filter"
                          value={plotFilter}
                          onChange={(e) => setPlotFilter(e.target.value)}
                          className="w-full rounded-md border border-zinc-300 bg-white p-1 font-normal"
                        >
                          <option value="">כל החלקות</option>
                          {plotOptions.map((plot) => (
                            <option key={plot} value={plot}>{plot}</option>
                          ))}
                        </select>
                      </th>
                      <th scope="col" className="px-3 py-2">מיכלים</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-100">
                    {visibleShipments.map((shipment) => (
                      <tr key={shipment.id} className={overdueIds.has(shipment.id)?"bg-amber-50":undefined}>
                        <td className="whitespace-nowrap px-3 py-3">
                          <span dir="ltr">
                            {shipment.date.split("-").reverse().join("/")}
                          </span>
                          {overdueIds.has(shipment.id)&&<span className="block text-xs text-amber-900">ממתין לתשלום</span>}
                        </td>
                        <td className="px-3 py-3">{shipment.variety}</td>
                        <td className="px-3 py-3">{shipment.plot}</td>
                        <td className="px-3 py-3">{shipment.containers}</td>
                      </tr>
                    ))}
                    {visibleShipments.length === 0 && (
                      <tr>
                        <td colSpan={4} className="p-4 text-center text-zinc-500">
                          אין שיווקים להצגה
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              <p className="border-t border-zinc-200 px-4 py-3 text-xs text-zinc-500">
                מוצגים {visibleShipments.length} מתוך {filteredShipments.length} שיווקים
              </p>
            </section>
          </>
        )}
      </div>
    </main>
  );
}
