"use client";

import { useCallback, useEffect, useState } from "react";
import { supabase } from "./lib/supabase";
import Dashboard from "./components/Dashboard";
import AuthGate, { useAuth } from "./components/AuthGate";
import Receipts from "./components/Receipts";
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
};

export default function Home() {
  return <AuthGate><FarmApp /></AuthGate>;
}

function FarmApp() {
  const { profile, setUnsavedChanges } = useAuth();
  const canCreate = profile.role === "admin" || profile.role === "worker";
  const canDelete = profile.role === "admin";
  const [activeTab, setActiveTab] = useState<
    "dashboard" | "shipments" | "shipment-list" | "receipts"
  >("shipments");

  const [shipments, setShipments] = useState<Shipment[]>([]);
  const [editingShipment, setEditingShipment] = useState<Shipment | null>(null);
  const [shipmentEditDirty, setShipmentEditDirty] = useState(false);
  const [listSort, setListSort] = useState<ShipmentSort>({ key: "date", direction: "desc" });
  const toggleSort = (key: ShipmentSortKey) => setListSort((current) => ({ key, direction: current.key === key && current.direction === "asc" ? "desc" : "asc" }));
  const sortIndicator = (key: ShipmentSortKey) => listSort.key === key ? (listSort.direction === "asc" ? " ↑" : " ↓") : " ↕";
  const [paidWeights, setPaidWeights] = useState<PaidWeight[] | null>(null);
  const [weightsError, setWeightsError] = useState(false);
  const [receiptsDirty, setReceiptsDirty] = useState(false);
  const selectTab = (tab: typeof activeTab) => {
    if (tab === activeTab) return;
    if ((receiptsDirty || shipmentEditDirty) && !window.confirm("יש שינויים שלא נשמרו. לעזוב אותם?")) return;
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
    variety: "אטינגר",
    plot: "בית העלמין",
    containers: 1,
    picker: "נביל",
  });

  // Reusable function to load shipments from Supabase
  const loadShipments = useCallback(async () => {
    const records: {
      id: string | number; harvest_date: string; variety_id: number; plot_id: number;
      containers: number; container_size: string; edit_version?: number;
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
  
    const varietyMapping: Record<number, string> = {
      1: "אטינגר",
      2: "גליל",
      3: "הס",
      4: "פוארטה",
    };
  
    const plotMapping: Record<number, string> = {
      1: "כביש 70",
      2: "חלקה א",
      3: "בית העלמין",
    };
  
    const uniqueRecords = [...new Map(records.map((record) => [String(record.id), record])).values()];
    const mappedShipments = uniqueRecords.map((record) => ({
      id: String(record.id),
      date: record.harvest_date,
      variety: varietyMapping[record.variety_id] || "",
      plot: plotMapping[record.plot_id] || "",
      containers: Number(record.containers),
      size: record.container_size, // Use the value directly from Supabase
      picker: "נביל", // Assuming picker is static for now
      varietyId: Number(record.variety_id),
      plotId: Number(record.plot_id),
      editVersion: record.edit_version ?? 0,
    }));
  
    setShipments(mappedShipments);
  }, []);

  // Load shipments on page load
  useEffect(() => {
    // Defer the async load to avoid synchronous state updates inside an effect.
    const timer = window.setTimeout(() => { void loadShipments(); void loadPaidWeights(); }, 0);
    return () => window.clearTimeout(timer);
  }, [loadShipments, loadPaidWeights]);

  const addShipment = async () => {
    if (!canCreate) return;
    const pickingCost = form.containers * 130;
    const confirmationMessage = [
      "האם לשמור את השיווק הבא?",
      "",
      `תאריך: ${form.date.split("-").reverse().join("/")}`,
      `זן: ${form.variety}`,
      `חלקה: ${form.plot}`,
      `מספר מיכלים: ${form.containers}`,
    ].join("\n");

    if (!window.confirm(confirmationMessage)) {
      return;
    }

    const varietyMapping: Record<string, number> = {
      אטינגר: 1,
      גליל: 2,
      הס: 3,
      פוארטה: 4,
    };

    const plotMapping: Record<string, number> = {
      "כביש 70": 1,
      "חלקה א": 2,
      "בית העלמין": 3,
    };

    const newShipment = {
      harvest_date: form.date,
      trader_id: 1,
      variety_id: varietyMapping[form.variety],
      plot_id: plotMapping[form.plot],
      picker_id: 1,
      containers: form.containers,
      container_size: "קטן",
      picking_cost: pickingCost,
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
        variety: "אטינגר",
        plot: "בית העלמין",
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
        alert(error?.code === "23503" ? "לא ניתן למחוק שיווק המשויך לתקבול, כדי לשמור את היסטוריית הנתונים." : "השיווק לא נמחק. נסה שוב או בדוק את הרשאות המחיקה.");
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
        </div>

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
              <table className="w-full text-right text-xs text-zinc-700">
                <caption className="sr-only">רשימת שיווקים עם סינון ומיון לפי עמודות</caption>
                <thead className="bg-zinc-50 text-zinc-900">
                  <tr>
                    <th scope="col" aria-sort={listSort.key === "date" ? (listSort.direction === "asc" ? "ascending" : "descending") : "none"} className="px-2 py-2">
                      <button type="button" onClick={() => toggleSort("date")} className="min-h-11 whitespace-nowrap" aria-label="מיון לפי תאריך">תאריך<span aria-hidden="true">{sortIndicator("date")}</span></button>
                    </th>
                    {listColumns.map(({ key, label }) => (
                      <th key={key} scope="col" aria-sort={listSort.key === key ? (listSort.direction === "asc" ? "ascending" : "descending") : "none"} className="px-2 py-2">
                        <button type="button" onClick={() => toggleSort(key)} className="min-h-11 whitespace-nowrap" aria-label={`מיון לפי ${label}`}>{label}<span aria-hidden="true">{sortIndicator(key)}</span></button>
                        <label htmlFor={`list-${key}`} className="sr-only">סינון לפי {label}</label>
                        <select
                          id={`list-${key}`}
                          value={listFilters[key]}
                          onChange={(e) => setListFilters((current) => ({ ...current, [key]: e.target.value }))}
                          className="min-h-11 min-w-20 w-full rounded-lg border border-zinc-300 bg-white p-2 text-base font-normal"
                        >
                          <option value="">הכל</option>
                          {[...new Set(shipments.map((shipment) => shipment[key]))]
                            .filter((value) => value !== "")
                            .sort((a, b) => key === "containers"
                              ? Number(a) - Number(b)
                              : String(a).localeCompare(String(b), "he"))
                            .map((value) => (
                              <option key={value} value={value}>{value}</option>
                            ))}
                        </select>
                      </th>
                    ))}
                    {canCreate && <th scope="col" className="px-1 py-2"><span className="sr-only">פעולות</span></th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100">
                  {listShipments.map((shipment) => (
                    <tr key={shipment.id}>
                      <td className="whitespace-nowrap px-2 py-2">
                        <span dir="ltr">{shipment.date.split("-").reverse().join("/")}</span>
                      </td>
                      <td className="px-2 py-2">{shipment.variety}</td>
                      <td className="px-2 py-2">{shipment.plot}</td>
                      <td className="px-2 py-2">{shipment.containers}</td>
                      {canCreate && <td className="px-1 py-2">
                        <button type="button" disabled={deletingId !== null} onClick={() => setEditingShipment(shipment)} aria-label={`ערוך שיווק מתאריך ${shipment.date.split("-").reverse().join("/")}`} className="min-h-11 min-w-11 rounded-lg px-2 text-sm text-blue-700 disabled:opacity-40">עריכה</button>
                        {canDelete && <button
                          type="button"
                          onClick={() => deleteShipment(shipment)}
                          disabled={deletingId !== null}
                          aria-label={`מחק שיווק ${shipment.variety} מחלקת ${shipment.plot} בתאריך ${shipment.date.split("-").reverse().join("/")}`}
                          className="flex min-h-11 min-w-11 items-center justify-center rounded-lg text-red-600 hover:bg-red-50 disabled:opacity-40"
                        >
                          <span aria-hidden="true" className="text-sm font-bold">✕</span>
                        </button>}
                      </td>}
                    </tr>
                  ))}
                  {listShipments.length === 0 && (
                    <tr><td colSpan={canCreate ? 5 : 4} className="p-4 text-center text-zinc-500">אין שיווקים התואמים לסינון</td></tr>
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
                  <option>אטינגר</option>
                  <option>גליל</option>
                  <option>הס</option>
                  <option>פוארטה</option>
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
                  <option>בית העלמין</option>
                  <option>חלקה א</option>
                  <option>כביש 70</option>
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
                      <tr key={shipment.id}>
                        <td className="whitespace-nowrap px-3 py-3">
                          <span dir="ltr">
                            {shipment.date.split("-").reverse().join("/")}
                          </span>
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
