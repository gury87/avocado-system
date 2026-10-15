export type Crop = { x: number; y: number; width: number; height: number };
export const fullCrop: Crop = { x: 0, y: 0, width: 1, height: 1 };
export const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));
export function cropPixels(crop: Crop, width: number, height: number) {
  const x = clamp(Math.round(crop.x * width), 0, width - 1), y = clamp(Math.round(crop.y * height), 0, height - 1);
  return { x, y, width: clamp(Math.round(crop.width * width), 1, width - x), height: clamp(Math.round(crop.height * height), 1, height - y) };
}
export function moveCrop(crop: Crop, dx: number, dy: number, handle: string): Crop {
  if (handle === "move") return { ...crop, x: clamp(crop.x + dx, 0, 1 - crop.width), y: clamp(crop.y + dy, 0, 1 - crop.height) };
  let left = crop.x, top = crop.y, right = left + crop.width, bottom = top + crop.height;
  if (handle.includes("w")) left = clamp(left + dx, 0, right - 0.03);
  if (handle.includes("e")) right = clamp(right + dx, left + 0.03, 1);
  if (handle.includes("n")) top = clamp(top + dy, 0, bottom - 0.03);
  if (handle.includes("s")) bottom = clamp(bottom + dy, top + 0.03, 1);
  return { x: left, y: top, width: right - left, height: bottom - top };
}
export async function decodePhoto(file: File): Promise<HTMLCanvasElement> {
  const url = URL.createObjectURL(file);
  try {
    const image = new Image(); image.src = url; await image.decode();
    if (!image.naturalWidth || image.naturalWidth * image.naturalHeight > 64000000) throw new Error("התמונה גדולה מדי לעיבוד. בחר תמונה ברזולוציה נמוכה יותר.");
    const ratio = Math.min(1, 2400 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement("canvas"); canvas.width = Math.max(1, Math.round(image.naturalWidth * ratio)); canvas.height = Math.max(1, Math.round(image.naturalHeight * ratio));
    const context = canvas.getContext("2d"); if (!context) throw new Error("לא ניתן לעבד תמונות בדפדפן זה.");
    context.fillStyle = "white"; context.fillRect(0, 0, canvas.width, canvas.height);
    // Browser decoding applies camera EXIF orientation before drawing.
    context.drawImage(image, 0, 0, canvas.width, canvas.height); return canvas;
  } finally { URL.revokeObjectURL(url); }
}
export function rotatePhoto(source: HTMLCanvasElement, turns: number) {
  const rotation = ((turns % 4) + 4) % 4, canvas = document.createElement("canvas");
  canvas.width = rotation % 2 ? source.height : source.width; canvas.height = rotation % 2 ? source.width : source.height;
  const context = canvas.getContext("2d"); if (!context) throw new Error("לא ניתן לעבד תמונות.");
  context.translate(canvas.width / 2, canvas.height / 2); context.rotate(rotation * Math.PI / 2); context.drawImage(source, -source.width / 2, -source.height / 2);
  return canvas;
}
export async function exportPhoto(source: HTMLCanvasElement, crop: Crop, name: string) {
  const area = cropPixels(crop, source.width, source.height), canvas = document.createElement("canvas");
  canvas.width = area.width; canvas.height = area.height;
  const context = canvas.getContext("2d"); if (!context) throw new Error("לא ניתן לשמור תמונה.");
  context.drawImage(source, area.x, area.y, area.width, area.height, 0, 0, area.width, area.height);
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("שמירת התמונה נכשלה.")), "image/jpeg", 0.9));
  if (blob.size > 10485760) throw new Error("התמונה עדיין גדולה מדי. נסה לחתוך אזור קטן יותר.");
  return new File([blob], `${name.replace(/\.[^.]+$/, "").slice(0, 245)}.jpg`, { type: "image/jpeg" });
}
