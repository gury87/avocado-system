export type ExcelSheet = { name: string; rows: (string | number | null)[][] };
const xml = (value: string) => value.replace(/[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD]/g, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const encode = (value: string) => new TextEncoder().encode(value);
function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
function header(length: number) {
  const bytes = new Uint8Array(length), view = new DataView(bytes.buffer);
  return { bytes, u16: (at: number, value: number) => view.setUint16(at, value, true), u32: (at: number, value: number) => view.setUint32(at, value, true) };
}
function concatenate(parts: Uint8Array[]) {
  const result = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
  let offset = 0; for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}
// Small standards-based XLSX writer: ZIP (stored) + inline strings, never formulas.
export function workbook(sheets: ExcelSheet[]) {
  const files: [string, string][] = [
    ["[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`],
    ["_rels/.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
    ["xl/workbook.xml", `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView/></bookViews><sheets>${sheets.map((sheet, i) => `<sheet name="${xml(sheet.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`],
    ["xl/_rels/workbook.xml.rels", `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}</Relationships>`],
  ];
  sheets.forEach((sheet, i) => {
    files.push([`xl/worksheets/sheet${i + 1}.xml`, `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0" rightToLeft="1"/></sheetViews><sheetData>${sheet.rows.map((row, index) => `<row r="${index + 1}">${row.map((value) => typeof value === "number" && Number.isFinite(value) ? `<c><v>${value}</v></c>` : `<c t="inlineStr"><is><t xml:space="preserve">${xml(String(value ?? ""))}</t></is></c>`).join("")}</row>`).join("")}</sheetData></worksheet>`]);
  });
  const local: Uint8Array[] = [], central: Uint8Array[] = [];
  let offset = 0;
  for (const [path, content] of files) {
    const name = encode(path), data = encode(content), crc = crc32(data);
    const l = header(30); l.u32(0, 0x04034b50); l.u16(4, 20); l.u16(6, 0x800); l.u16(12, 33); l.u32(14, crc); l.u32(18, data.length); l.u32(22, data.length); l.u16(26, name.length);
    const c = header(46); c.u32(0, 0x02014b50); c.u16(4, 20); c.u16(6, 20); c.u16(8, 0x800); c.u16(14, 33); c.u32(16, crc); c.u32(20, data.length); c.u32(24, data.length); c.u16(28, name.length); c.u32(42, offset);
    local.push(l.bytes, name, data); central.push(c.bytes, name); offset += l.bytes.length + name.length + data.length;
  }
  const directory = concatenate(central), end = header(22);
  end.u32(0, 0x06054b50); end.u16(8, files.length); end.u16(10, files.length); end.u32(12, directory.length); end.u32(16, offset);
  return concatenate([...local, directory, end.bytes]);
}

export function downloadExcel(sheets: ExcelSheet[], filename: string) {
  const url = URL.createObjectURL(new Blob([workbook(sheets)], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
  const link = document.createElement("a"); link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
