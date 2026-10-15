import { test } from "node:test";
import assert from "node:assert/strict";
import { sortShipments } from "../app/lib/shipments.ts";

test("Shipment table sorts each data column in both directions without changing source rows", () => {
  const rows = [
    { id: "1", date: "2026-10-01", variety: "גליל", plot: "חלקה א", containers: 10 },
    { id: "2", date: "2026-09-30", variety: "אטינגר", plot: "בית העלמין", containers: 2 },
    { id: "3", date: "2026-10-02", variety: "הס", plot: "כביש 70", containers: 50 },
  ];
  const original = structuredClone(rows);
  for (const key of ["date", "variety", "plot", "containers"]) {
    const ascending = sortShipments(rows, { key, direction: "asc" });
    const descending = sortShipments(rows, { key, direction: "desc" });
    assert.deepEqual(descending.map((row) => row.id), ascending.map((row) => row.id).reverse());
  }
  assert.deepEqual(sortShipments(rows, { key: "containers", direction: "asc" }).map((row) => row.containers), [2,10,50]);
  assert.deepEqual(sortShipments(rows, { key: "date", direction: "asc" }).map((row) => row.id), ["2","1","3"]);
  assert.deepEqual(rows, original);
});
