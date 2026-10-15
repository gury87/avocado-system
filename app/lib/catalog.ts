export type CatalogEntry = { id: string; name: string; active: boolean; version: number; dunam?: number | null };
export type CatalogKind = "plots" | "traders" | "varieties";
export type FarmCatalog = { plots: CatalogEntry[]; traders: CatalogEntry[]; varieties: CatalogEntry[]; settings: { overdue_days: number; loss_warning_percent: number; version: number } };
export function catalogNames(entries: CatalogEntry[]) { return Object.fromEntries(entries.map((e) => [e.id, e.name])); }
export function catalogOptions(entries: CatalogEntry[], current = "") { return entries.filter((e) => e.active || e.id === current); }
export function defaultEntry(entries: CatalogEntry[], preferred: string) { return entries.find((e) => e.active && e.id === preferred)?.id || entries.find((e) => e.active)?.id || ""; }
export function shipmentAge(date: string, today: string) { return date ? Math.floor((Date.parse(today + "T00:00:00Z") - Date.parse(date + "T00:00:00Z")) / 86400000) : NaN; }
export function isOverdue(date: string, containers: number, paid: number, days: number, today: string) {
  return containers - paid > 0.0005 && shipmentAge(date, today) > days;
}
