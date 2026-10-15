export type ShipmentSortKey = "date" | "variety" | "plot" | "containers";
export type ShipmentSort = { key: ShipmentSortKey; direction: "asc" | "desc" };
export function sortShipments<T extends { id: string; date: string; variety: string; plot: string; containers: number }>(rows: T[], sort: ShipmentSort): T[] {
  return [...rows].sort((a, b) => {
    const difference = sort.key === "containers" ? a.containers - b.containers : a[sort.key].localeCompare(b[sort.key], "he");
    return difference * (sort.direction === "asc" ? 1 : -1) || b.date.localeCompare(a.date) || a.id.localeCompare(b.id, "en", { numeric: true });
  });
}
