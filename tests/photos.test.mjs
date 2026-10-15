import { test } from "node:test";
import assert from "node:assert/strict";
import { cropPixels, fullCrop, moveCrop } from "../app/lib/photos.ts";

test("Crop coordinates stay inside the image and keep at least one output pixel", () => {
  assert.deepEqual(cropPixels(fullCrop, 400, 600), { x: 0, y: 0, width: 400, height: 600 });
  assert.deepEqual(cropPixels({ x: 0.25, y: 0.1, width: 0.5, height: 0.5 }, 400, 600), { x: 100, y: 60, width: 200, height: 300 });
  assert.deepEqual(cropPixels({ x: 1, y: 1, width: 0, height: 0 }, 400, 600), { x: 399, y: 599, width: 1, height: 1 });
  assert.deepEqual(cropPixels({ x: -1, y: -1, width: 4, height: 4 }, 400, 600), { x: 0, y: 0, width: 400, height: 600 });
});
test("Dragging crop corners and moving the selection cannot cross boundaries", () => {
  const crop = { x: 0.2, y: 0.2, width: 0.5, height: 0.5 };
  const moved = moveCrop(crop, 3, -3, "move");
  assert.equal(moved.x, 0.5); assert.equal(moved.y, 0); assert.equal(moved.width, 0.5);
  for (const corner of ["nw", "ne", "sw", "se"]) {
    for (const dx of [-5, 5]) for (const dy of [-5, 5]) {
      const result = moveCrop(crop, dx, dy, corner);
      assert.ok(result.x >= 0 && result.y >= 0);
      assert.ok(result.width >= 0.02999 && result.height >= 0.02999);
      assert.ok(result.x + result.width <= 1.00001 && result.y + result.height <= 1.00001);
    }
  }
  assert.deepEqual(crop, { x: 0.2, y: 0.2, width: 0.5, height: 0.5 });
});
