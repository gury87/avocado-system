"use client";

import { useEffect, useState } from "react";
import { supabase } from "./lib/supabase";

const today = new Date().toISOString().split("T")[0];

type Shipment = {
  id: string;
  date: string;
  variety: string;
  plot: string;
  containers: number;
  size: string;
  picker: string;
};

export default function Home() {
  const [activeTab, setActiveTab] = useState<
    "dashboard" | "shipments"
  >("shipments");

  const [shipments, setShipments] = useState<Shipment[]>([]);

  const [form, setForm] = useState({
    date: today,
    variety: "אטינגר",
    plot: "בית העלמין",
    containers: 1,
    size: "קטן",
    picker: "נביל",
  });

  useEffect(() => {
    const saved = localStorage.getItem("shipments");

    if (saved) {
      setShipments(JSON.parse(saved));
    }
  }, []);

  useEffect(() => {
    localStorage.setItem(
      "shipments",
      JSON.stringify(shipments)
    );
  }, [shipments]);

  const testSupabaseConnection = async () => {
    const { error } = await supabase.from("harvest_events").insert({
      harvest_date: today,
      trader_id: 1,
      variety_id: 1,
      plot_id: 3,
      picker_id: 1,
      containers: 1,
      container_size: "קטן",
      picking_cost: 130,
      status: "test",
    });
  
    if (error) {
      alert(JSON.stringify(error, null, 2));
    } else {
      alert("Test row inserted successfully");
    }
  };

  const addShipment = async () => {
    const varietyMapping = {
      אטינגר: 1,
      גליל: 2,
      הס: 3,
      פוארטה: 4,
    };

    const plotMapping = {
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
      container_size: form.size,
      picking_cost:
        form.size === "קטן"
          ? form.containers * 130
          : form.containers * 150,
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

      // Clear form
      setForm({
        date: today,
        variety: "אטינגר",
        plot: "בית העלמין",
        containers: 1,
        size: "קטן",
        picker: "נביל",
      });
    }
  };

  const deleteShipment = (id: string) => {
    const updated = shipments.filter(
      (shipment) => shipment.id !== id
    );

    setShipments(updated);
  };

  const totalContainers = shipments.reduce(
    (sum, s) => sum + s.containers,
    0
  );

  const totalPickingCost = shipments.reduce(
    (sum, s) =>
      sum +
      s.containers *
        (s.size === "גדול" ? 150 : 130),
    0
  );

  return (
    <main
      dir="rtl"
      className="min-h-screen bg-zinc-100"
    >
      <div className="max-w-md mx-auto px-4 py-6 pb-24">
        <h1 className="text-3xl font-bold text-zinc-900 mb-4">
          🥑 מערכת שיווק אבוקדו
        </h1>

        <button
          onClick={testSupabaseConnection}
          className="mb-4 w-full bg-green-700 text-white rounded-xl py-3"
        >
          בדיקת חיבור ל‑Supabase
        </button>

        <div className="flex gap-2 mb-5">
          <button
            onClick={() => setActiveTab("shipments")}
            className={`flex-1 rounded-xl p-3 ${
              activeTab === "shipments"
                ? "bg-zinc-900 text-white"
                : "bg-white text-zinc-700"
            }`}
          >
            שיווקים
          </button>

          <button
            onClick={() => setActiveTab("dashboard")}
            className={`flex-1 rounded-xl p-3 ${
              activeTab === "dashboard"
                ? "bg-zinc-900 text-white"
                : "bg-white text-zinc-700"
            }`}
          >
            דשבורד
          </button>
        </div>

        {activeTab === "dashboard" && (
          <>
            <div className="grid grid-cols-2 gap-3 mb-4">
              <div className="bg-white rounded-2xl border border-zinc-200 p-4">
                <div className="text-sm text-zinc-500">
                  סה״כ מיכלים
                </div>
                <div className="text-3xl font-bold text-zinc-900">
                  {totalContainers}
                </div>
              </div>

              <div className="bg-white rounded-2xl border border-zinc-200 p-4">
                <div className="text-sm text-zinc-500">
                  מספר שיווקים
                </div>
                <div className="text-3xl font-bold text-zinc-900">
                  {shipments.length}
                </div>
              </div>

              <div className="bg-white rounded-2xl border border-zinc-200 p-4">
                <div className="text-sm text-zinc-500">
                  עלות קטיף
                </div>
                <div className="text-2xl font-bold text-zinc-900">
                  ₪{totalPickingCost}
                </div>
              </div>

              <div className="bg-white rounded-2xl border border-zinc-200 p-4">
                <div className="text-sm text-zinc-500">
                  קוטף ראשי
                </div>
                <div className="text-xl font-bold text-zinc-900">
                  נביל
                </div>
              </div>
            </div>
          </>
        )}

        {activeTab === "shipments" && (
          <>
            <div className="bg-white rounded-2xl border border-zinc-200 p-5 mb-4">
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

                <select
                  value={form.size}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      size: e.target.value,
                    })
                  }
                  className="w-full rounded-xl border border-zinc-300 p-3 text-zinc-900"
                >
                  <option>קטן</option>
                  <option>גדול</option>
                </select>

                <button
                  onClick={addShipment}
                  className="w-full bg-zinc-900 text-white rounded-xl py-3"
                >
                  שמור שיווק
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </main>
  );
}