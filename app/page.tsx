"use client";

import { useEffect, useState } from "react";

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

  const addShipment = () => {
    const newShipment: Shipment = {
      ...form,
      id: crypto.randomUUID(),
    };

    const updated = [newShipment, ...shipments];

    setShipments(updated);

    setForm({
      date: today,
      variety: "אטינגר",
      plot: "בית העלמין",
      containers: 1,
      size: "קטן",
      picker: "נביל",
    });
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
        <h1 className="text-3xl font-bold text-zinc-900 mb-6">
          🥑 מערכת שיווק אבוקדו
        </h1>

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

            <div className="bg-white rounded-2xl border border-zinc-200 p-4">
              <h2 className="text-lg font-semibold text-zinc-900 mb-3">
                שיווקים אחרונים
              </h2>

              <div className="space-y-2">
                {shipments.slice(0, 5).map((shipment) => (
                  <div
                    key={shipment.id}
                    className="border border-zinc-200 rounded-xl p-3"
                  >
                    <div className="font-semibold text-zinc-900">
                      {shipment.variety}
                    </div>

                    <div className="text-zinc-700">
                      {shipment.plot}
                    </div>

                    <div className="text-zinc-700">
                      {shipment.containers} מיכלים
                    </div>

                    <div className="text-zinc-900 text-sm mt-1">
                      {shipment.date}
                    </div>
                  </div>
                ))}
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

            <div className="bg-white rounded-2xl border border-zinc-200 p-4">
              <div className="flex justify-between mb-4">
                <h2 className="font-semibold text-zinc-900">
                  כל השיווקים
                </h2>

                <button
                  onClick={() => {
                    localStorage.removeItem("shipments");
                    setShipments([]);
                  }}
                  className="text-red-600 text-sm"
                >
                  נקה הכל
                </button>
              </div>

              <div className="space-y-3">
                {shipments.map((shipment) => (
                  <div
                    key={shipment.id}
                    className="border border-zinc-200 rounded-xl p-3"
                  >
                    <div className="font-semibold text-zinc-900">
                      {shipment.variety}
                    </div>

                    <div className="text-zinc-700">
                      {shipment.plot}
                    </div>

                    <div className="text-zinc-700">
                      {shipment.containers} מיכלים
                    </div>

                    <div className="text-zinc-700">
                      גודל: {shipment.size}
                    </div>

                    <div className="text-zinc-900 text-sm mt-2 mb-3">
                      {shipment.date}
                    </div>

                    <button
                      onClick={() =>
                        deleteShipment(shipment.id)
                      }
                      className="text-red-600 text-sm"
                    >
                      מחק שיווק
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    </main>
  );
}