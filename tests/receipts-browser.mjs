// Production UI smoke test with browser-level mocked Supabase responses.
// Does not send requests to the real Supabase project or modify real data.
// Run after npm run build. Requires locally installed Chrome and Node 24+.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";

const root = resolve(import.meta.dirname, "..");
const env = await readFile(join(root, ".env.local"), "utf8");
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || env.match(/^NEXT_PUBLIC_SUPABASE_URL\s*=\s*["']?([^\s"']+)/m)?.[1];
if (!supabaseUrl) throw new Error("A local NEXT_PUBLIC_SUPABASE_URL is required");
const host = new URL(supabaseUrl).host;
const storageKey = `sb-${host.split(".")[0]}-auth-token`;
const temp = await mkdtemp(join(tmpdir(), "avocado-receipts-browser-"));
const browser = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const port = Number(process.env.RECEIPTS_TEST_PORT || 3155);
const origin = `http://localhost:${port}`;
const server = spawn(process.execPath, [join(root, "node_modules/next/dist/bin/next"), "start", "-p", String(port)], { cwd: root, windowsHide: true, stdio: "ignore" });
const chrome = spawn(browser, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${temp}`, "--no-first-run", "--disable-background-networking", "--disable-sync", "about:blank"], { windowsHide: true, stdio: "ignore" });
let ws;
let send;
let failureInfo = async () => null;
const waitFor = async (fn, label, timeout = 15000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const result = await fn(); if (result) return result; await new Promise((done) => setTimeout(done, 100)); }
  throw new Error(`Timed out: ${label}`);
};

try {
  await waitFor(async () => { try { return (await fetch(origin)).ok; } catch { return false; } }, "production server");
  const devTools = await waitFor(async () => { try { return await readFile(join(temp, "DevToolsActivePort"), "utf8"); } catch { return null; } }, "browser debugging port");
  const [debugPort, debugPath] = devTools.trim().split(/\r?\n/);
  ws = new WebSocket(`ws://127.0.0.1:${debugPort}${debugPath}`);
  await once(ws, "open");
  let nextId = 1;
  const pending = new Map();
  const handlers = new Map();
  send = (method, params = {}, sessionId) => new Promise((resolvePromise, reject) => {
    const id = nextId++;
    pending.set(id, { resolve: resolvePromise, reject });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id) {
      const callback = pending.get(message.id); pending.delete(message.id);
      if (message.error) callback?.reject(new Error(JSON.stringify(message.error)));
      else callback?.resolve(message.result);
    } else for (const handler of handlers.get(message.method) || []) handler(message.params);
  });
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  const page = (method, params) => send(method, params, sessionId);
  await page("Page.enable");
  await page("Runtime.enable");
  await page("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  let acceptDialog = true;
  handlers.set("Page.javascriptDialogOpening", [() => { void page("Page.handleJavaScriptDialog", { accept: acceptDialog }); }]);
  const errors = [];
  handlers.set("Runtime.exceptionThrown", [(event) => errors.push(event.exceptionDetails.text)]);

  let role = "admin";
  const userId = () => role === "admin" ? "00000000-0000-4000-8000-000000000001" : "00000000-0000-4000-8000-000000000002";
  const profile = () => ({ id: userId(), full_name: "משתמש בדיקה", email: "test@example.com", role, is_active: true, joined_at: "2026-10-15T00:00:00Z" });
  const user = () => ({ id: userId(), email: "test@example.com", role: "authenticated", aud: "authenticated", app_metadata: {}, user_metadata: {}, created_at: "2026-10-15T00:00:00Z" });
  const workspace = { traders: [{ id: "1", name: "ראובן יהודה" }], shipments: [{ id: "1", trader_id: "1", variety_id: "2", plot_id: "1", harvest_date: "2026-09-06", containers: 2, used_containers: 0 }], receipts: [] };
  const paidWeights = () => {
    const allocations = workspace.receipts.filter((item) => item.status === "confirmed").flatMap((item) => item.lines.flatMap((line) => line.allocations));
    return allocations.length ? [{ harvest_event_id: "1", containers: allocations.reduce((sum, item) => sum + Number(item.containers), 0), net_weight: allocations.reduce((sum, item) => sum + Number(item.net_weight), 0) }] : [];
  };
  let writes = 0;
  let shipmentVersion = 0;
  const requests = [];
  let documents = [];
  const storedFiles = new Set();
  let photoFixture = "";
  handlers.set("Fetch.requestPaused", [(event) => {
    void (async () => {
      const url = new URL(event.request.url);
      if (url.origin === origin) { await page("Fetch.continueRequest", { requestId: event.requestId }); return; }
      requests.push(`${event.request.method} ${url.pathname}`);
      if (url.host !== host) throw new Error(`Unexpected external test request to ${url.hostname}`);
      if (event.request.method === "OPTIONS") {
        await page("Fetch.fulfillRequest", { requestId: event.requestId, responseCode: 204, responseHeaders: [
          { name: "Access-Control-Allow-Origin", value: origin },
          { name: "Access-Control-Allow-Methods", value: "GET, POST, PATCH, DELETE, OPTIONS" },
          { name: "Access-Control-Allow-Headers", value: Object.entries(event.request.headers).find(([key]) => key.toLowerCase() === "access-control-request-headers")?.[1] || "authorization, apikey, x-client-info, content-type, prefer, range, range-unit, x-supabase-api-version" },
        ] });
        return;
      }
      let body;
      if (url.pathname === "/auth/v1/user") body = user();
      else if (url.pathname === "/rest/v1/profiles") body = profile();
      else if (url.pathname === "/rest/v1/harvest_events") body = [{ ...workspace.shipments[0], id: 1, edit_version: shipmentVersion, container_size: "קטן" }];
      else if (url.pathname.endsWith("/get_paid_shipment_weights")) body = paidWeights();
      else if (url.pathname.endsWith("/get_farm_reports")) {
        assert.equal(role, "admin");
        body = { ...workspace, traders: [...workspace.traders, { id: "2", name: "סוחר נוסף" }], shipments: [
          { ...workspace.shipments[0], containers: 4, picking_cost: 520 },
          { id: "2", trader_id: "2", variety_id: "1", plot_id: "2", harvest_date: "2026-09-10", containers: 3, picking_cost: null },
        ] };
      } else if (url.pathname === "/rest/v1/farm_documents") {
        assert.equal(role, "admin");
        if (event.request.method === "POST") {
          const item = JSON.parse(event.request.postData); item.id = crypto.randomUUID();
          assert.ok(storedFiles.has(item.storage_path)); documents.push(item); body = null;
        } else if (event.request.method === "DELETE") {
          documents = documents.filter((d) => d.id !== url.searchParams.get("id").replace("eq.", "")); body = null;
        } else {
          body = documents.filter((d) => ["receipt_id", "shipment_id", "storage_path"].every((key) => !url.searchParams.has(key) || d[key] === url.searchParams.get(key).replace("eq.", "")));
        }
      } else if (url.pathname.startsWith("/storage/v1/object/sign/")) {
        assert.equal(role, "admin");
        if (event.request.method === "GET") {
          await page("Fetch.fulfillRequest", { requestId: event.requestId, responseCode: 200, responseHeaders: [{ name: "Content-Type", value: "image/png" }, { name: "Access-Control-Allow-Origin", value: origin }], body: photoFixture });
          return;
        }
        body = { signedURL: "/object/sign/farm-documents/preview.jpg?token=fixture" };
      } else if (url.pathname.startsWith("/storage/v1/object/farm-documents/")) {
        assert.equal(role, "admin");
        const path = decodeURIComponent(url.pathname.split("/farm-documents/")[1]);
        storedFiles.add(path); body = { Key: `farm-documents/${path}` };
      } else if (url.pathname === "/storage/v1/object/farm-documents" && event.request.method === "DELETE") {
        assert.equal(role, "admin");
        const { prefixes } = JSON.parse(event.request.postData);
        prefixes.forEach((path) => storedFiles.delete(path)); body = [];
      } else if (url.pathname.endsWith("/get_receipt_workspace")) {
        assert.equal(role, "admin");
        workspace.shipments[0].used_containers = paidWeights()[0]?.containers || 0;
        body = workspace;
      } else if (url.pathname.endsWith("/get_shipment_traders")) {
        assert.ok(role === "admin" || role === "worker");
        body = [...workspace.traders, { id: "2", name: "סוחר נוסף" }];
      } else if (url.pathname.endsWith("/edit_farm_shipment_with_trader")) {
        assert.ok(role === "admin" || role === "worker");
        const request = JSON.parse(event.request.postData);
        assert.equal(request.expected_version, shipmentVersion);
        if (request.new_trader_id !== workspace.shipments[0].trader_id && workspace.receipts.some((r) => r.status !== "cancelled" && r.lines.some((l) => l.allocations.some((a) => a.harvest_event_id === "1")))) {
          await page("Fetch.fulfillRequest", { requestId: event.requestId, responseCode: 400, responseHeaders: [{ name: "Content-Type", value: "application/json" }, { name: "Access-Control-Allow-Origin", value: origin }], body: Buffer.from(JSON.stringify({ message: "LINKED_TRADER" })).toString("base64") });
          return;
        }
        Object.assign(workspace.shipments[0], { harvest_date: request.new_date,
          variety_id: String(request.new_variety_id), plot_id: String(request.new_plot_id), containers: request.new_containers, trader_id: request.new_trader_id });
        shipmentVersion++; body = { id: "1", edit_version: shipmentVersion };
      } else if (url.pathname.endsWith("/delete_farm_receipt")) {
        assert.equal(role, "admin");
        const request = JSON.parse(event.request.postData);
        const item = workspace.receipts.find((record) => record.id === request.receipt_id);
        assert.ok(item && ["draft", "cancelled"].includes(item.status));
        assert.equal(item.version, request.expected_version);
        workspace.receipts = workspace.receipts.filter((record) => record.id !== item.id);
        body = null;
      } else if (url.pathname.endsWith("/save_farm_receipt")) {
        assert.equal(role, "admin");
        const request = JSON.parse(event.request.postData);
        const item = { ...request.payload, version: request.payload.version + 1, status: request.finalize ? "confirmed" : "draft" };
        workspace.receipts = [...workspace.receipts.filter((record) => record.id !== item.id), item];
        writes++; body = { id: item.id, version: item.version };
      } else throw new Error(`Unexpected mocked request: ${url.pathname}`);
      await page("Fetch.fulfillRequest", { requestId: event.requestId, responseCode: 200,
        responseHeaders: [{ name: "Content-Type", value: "application/json" }, { name: "Access-Control-Allow-Origin", value: origin }],
        body: Buffer.from(JSON.stringify(body)).toString("base64") });
    })().catch((error) => { errors.push(error.message); void page("Fetch.failRequest", { requestId: event.requestId, errorReason: "BlockedByClient" }); });
  }]);
  await page("Fetch.enable", { patterns: [{ urlPattern: "*" }] });

  let seedId;
  const seedSession = async () => {
    if (seedId) await page("Page.removeScriptToEvaluateOnNewDocument", { identifier: seedId });
    const expires = Math.floor(Date.now() / 1000) + 3600;
    const token = [Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url"), Buffer.from(JSON.stringify({ sub: userId(), role: "authenticated", exp: expires })).toString("base64url"), "fixture"].join(".");
    const session = { access_token: token, refresh_token: "fixture-refresh", expires_at: expires, expires_in: 3600, token_type: "bearer", user: user() };
    const { identifier } = await page("Page.addScriptToEvaluateOnNewDocument", { source: `if(location.origin===${JSON.stringify(origin)}){localStorage.setItem(${JSON.stringify(storageKey)},${JSON.stringify(JSON.stringify(session))});}` });
    seedId = identifier;
  };
  const evaluate = async (expression) => {
    const result = await page("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  };
  const text = () => evaluate("document.body.innerText");
  failureInfo = async () => ({ text: await text(), errors, requests });
  const waitText = (value) => waitFor(async () => (await text()).includes(value), value);
  const click = async (value) => {
    await evaluate(`(() => { const button=[...document.querySelectorAll('button')].find(item=>item.textContent.trim()===${JSON.stringify(value)}); if(!button || button.disabled) throw Error('Button unavailable: '+${JSON.stringify(value)}); button.click(); })()`);
  };
  const fill = async (label, value) => {
    await evaluate(`(() => { const label=[...document.querySelectorAll('label')].find(item=>item.textContent.startsWith(${JSON.stringify(label)})); const input=label?.querySelector('input,select'); if(!input) throw Error('Input missing'); Object.getOwnPropertyDescriptor(input.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)}); input.dispatchEvent(new Event('input',{bubbles:true})); input.dispatchEvent(new Event('change',{bubbles:true})); })()`);
  };
  const screenshot = async (name) => {
    const dimensions = await evaluate("({viewport:innerWidth,content:document.documentElement.scrollWidth})");
    assert.ok(dimensions.content <= dimensions.viewport + 1, `Horizontal page overflow: ${JSON.stringify(dimensions)}`);
    const modal = await evaluate("(() => { const dialog=document.querySelector('dialog[open]'); if(!dialog) return null; const rect=dialog.getBoundingClientRect(); return {left:rect.left,right:rect.right,width:document.documentElement.clientWidth}; })()");
    if (modal) assert.ok(modal.left >= -1 && modal.right <= modal.width + 1, `Dialog outside viewport: ${JSON.stringify(modal)}`);
    const image = await page("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
    await writeFile(join(temp, name), Buffer.from(image.data, "base64"));
  };

  await seedSession(); await page("Page.navigate", { url: origin });
  await waitText("תקבולים"); await click("תקבולים"); await waitText("תקבול חדש");
  await waitFor(() => evaluate("[...document.querySelectorAll('button')].some(item=>item.textContent.trim()==='תקבול חדש' && !item.disabled)"), "receipt data");
  await click("תקבול חדש"); await waitText("פרטי התקבול");
  await fill("סכום התקבול בפועל", "1008"); await fill("תאריך פירעון ההמחאה", "2026-09-18");
  await fill("תאריך אצל הסוחר", "2026-09-07"); await fill("זן", "2");
  await fill("משקל ברוטו", "657"); await fill("מספר מיכלים", "2");
  await fill("משקל נטו", "560"); await fill("מחיר לק״ג", "1.8");
  await waitText("06/09/2026"); await click("שייך לשורה"); await waitText("שויכו 2 מתוך 2");
  await screenshot("receipt-mobile.png");
  await page("Emulation.setDeviceMetricsOverride", { width: 320, height: 844, deviceScaleFactor: 1, mobile: true });
  await screenshot("receipt-mobile-320.png");
  await page("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  acceptDialog = false; await click("החשבון שלי"); acceptDialog = true;
  assert.ok((await text()).includes("פרטי התקבול"), "Unsaved navigation can be cancelled");
  await click("שמור טיוטה"); await waitText("הטיוטה נשמרה");
  assert.equal(writes, 1); assert.equal(paidWeights().length, 0);
  await click("דשבורד"); await waitText("מיכלים שטרם שולמו לפי זן");
  assert.equal(await evaluate("document.querySelector('[data-unpaid-total]').textContent"), "2");
  assert.ok(await evaluate("document.querySelector('[data-unpaid-varieties]').textContent.includes('גליל')"));
  await fill("מתאריך שיווק", "2026-10-01");
  assert.equal(await evaluate("document.querySelector('[data-unpaid-total]').textContent"), "0");
  await click("תקבולים"); await waitText("תקבולים קודמים");
  await fill("מצב", "draft");
  await evaluate("document.querySelectorAll('details').forEach(item=>item.open=true)");
  await click("עריכת תקבול"); await waitText("עריכת תקבול");
  await click("אישור סופי ושמירה"); await waitText("התקבול אושר ונשמר");
  assert.equal(writes, 2); assert.equal(paidWeights()[0].net_weight, 560);
  await click("דשבורד"); await waitText("560"); await screenshot("dashboard-mobile.png");
  assert.equal(await evaluate("document.querySelector('[data-unpaid-total]').textContent"), "0");
  await page("Emulation.setDeviceMetricsOverride", { width: 320, height: 844, deviceScaleFactor: 1, mobile: true });
  await screenshot("dashboard-mobile-320.png");

  await click("שיווקים"); await waitText("רשימת שיווקים");
  for (const width of [320, 390]) {
    await page("Emulation.setDeviceMetricsOverride", { width, height: 844, deviceScaleFactor: 1, mobile: true });
    const table = await evaluate("(() => { const t=document.querySelector('[data-shipment-list]'); return {width:t.clientWidth,content:t.scrollWidth,available:t.parentElement.clientWidth}; })()");
    assert.ok(table.content <= table.available + 1, `Shipment table overflows at ${width}px: ${JSON.stringify(table)}`);
    await screenshot(`shipments-mobile-${width}.png`);
  }
  await page("Emulation.setDeviceMetricsOverride", { width: 320, height: 844, deviceScaleFactor: 1, mobile: true });
  await evaluate("document.querySelector('button[aria-label=\"מיון לפי תאריך\"]').click()");
  assert.equal(await evaluate("document.querySelector('button[aria-label=\"מיון לפי תאריך\"]').closest('th').getAttribute('aria-sort')"), "ascending");
  await evaluate("document.querySelector('button[aria-label=\"מיון לפי מיכלים\"]').click()");
  assert.equal(await evaluate("document.querySelector('button[aria-label=\"מיון לפי מיכלים\"]').closest('th').getAttribute('aria-sort')"), "ascending");
  assert.equal(await evaluate("document.querySelectorAll('td span[title^=\"שויך תשלום מאושר\"]').length"), 1);
  await evaluate("document.querySelector('button[aria-label^=\"ערוך שיווק\"]').click()"); await waitText("עריכת שיווק");
  await fill("תאריך שיווק", "2026-09-05"); await fill("חלקה", "2");
  await waitFor(() => evaluate("[...document.querySelectorAll('label')].find(l=>l.textContent.startsWith('סוחר'))?.querySelector('select')?.options.length>=3"), "shipment traders loaded");
  await fill("סוחר", "2"); await click("שמור שינויים");
  await waitText("לא ניתן לשנות סוחר בשיווק המשויך");
  assert.equal(shipmentVersion, 0); assert.equal(workspace.shipments[0].trader_id, "1");
  await fill("סוחר", "1");
  await waitText("אין מסמכים מצורפים");
  assert.equal(await evaluate("document.querySelector('input[aria-label=\"צילום תמונה\"]').getAttribute('capture')"), "environment");
  assert.equal(await evaluate("document.querySelector('input[aria-label=\"בחירה מהגלריה\"]').hasAttribute('capture')"), false);
  const photoPath = join(temp, "test-receipt.png");
  photoFixture = await evaluate("(() => {const c=document.createElement('canvas');c.width=600;c.height=400;const x=c.getContext('2d');x.fillStyle='red';x.fillRect(0,0,300,400);x.fillStyle='blue';x.fillRect(300,0,300,400);return c.toDataURL('image/png').split(',')[1]})()");
  await writeFile(photoPath, Buffer.from(photoFixture, "base64"));
  await evaluate("(() => { const append=FormData.prototype.append;FormData.prototype.append=function(key,value,...rest){if(value instanceof Blob && value.type.startsWith('image/')){void createImageBitmap(value).then(bitmap=>{const c=document.createElement('canvas');c.width=bitmap.width;c.height=bitmap.height;const x=c.getContext('2d');x.drawImage(bitmap,0,0);window.__photoUpload={width:bitmap.width,height:bitmap.height,type:value.type,pixel:[...x.getImageData(Math.floor(c.width/2),Math.floor(c.height/2),1,1).data]};bitmap.close()})};return append.call(this,key,value,...rest)}})()");
  const upload = async (source = "gallery") => {
    await evaluate("window.__photoUpload=null");
    const { root: dom } = await page("DOM.getDocument");
    const { nodeId } = await page("DOM.querySelector", { nodeId: dom.nodeId, selector: source === "camera" ? 'input[capture="environment"]' : 'input[type="file"]:not([capture])' });
    await page("DOM.setFileInputFiles", { nodeId, files: [photoPath] });
    await waitText("עריכת תמונה לפני העלאה");
    await waitFor(() => evaluate("!!document.querySelector('[data-photo-crop] img')"), "photo decoded");
    await click("סיבוב 90°");
    const handle = await evaluate("(() => {const r=document.querySelector('[data-handle=se]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()");
    await page("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: handle.x, y: handle.y }] });
    await page("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: handle.x - 30, y: handle.y - 40 }] });
    await page("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    assert.ok(await evaluate("parseFloat(document.querySelector('[data-crop-box]').style.width)<100"), "Crop corner responds to touch");
    await fill("רוחב", "50"); await fill("גובה", "50");
    await screenshot("photo-editor-mobile-320.png");
    await click("שמירה והעלאה");
    await waitFor(() => evaluate("!!document.querySelector('button[aria-label=\"הגדל תמונה test-receipt.jpg\"]')"), "uploaded photo preview");
    await waitText("מסמכים מצורפים (1)");
    assert.equal((await text()).includes("test-receipt.jpg"), false, "Photo file name is not displayed");
    const image = await waitFor(() => evaluate("window.__photoUpload"), "edited image uploaded");
    assert.equal(image.width, 200); assert.equal(image.height, 300); assert.equal(image.type, "image/jpeg");
    assert.ok(image.pixel[0] > 240 && image.pixel[2] < 15, "Uploaded pixels come from the rotated/cropped red quadrant");
  };
  const { root: photoDom } = await page("DOM.getDocument");
  const { nodeId: photoInput } = await page("DOM.querySelector", { nodeId: photoDom.nodeId, selector: 'input[type="file"]' });
  await page("DOM.setFileInputFiles", { nodeId: photoInput, files: [photoPath] });
  await waitText("עריכת תמונה לפני העלאה");
  await evaluate("document.querySelector('dialog[aria-label=\"עריכת תמונה לפני העלאה\"] button[aria-label=\"סגור תמונה\"]').click()");
  assert.equal(storedFiles.size, 0); assert.equal(documents.length, 0);
  await upload();
  assert.equal(documents[0].shipment_id, "1");
  assert.equal(storedFiles.size, 1);
  await waitFor(() => evaluate("!!document.querySelector('img[alt=\"test-receipt.jpg\"]')?.complete"), "thumbnail loaded");
  await evaluate("document.querySelector('button[aria-label=\"הגדל תמונה test-receipt.jpg\"]').click()");
  await waitFor(() => evaluate("!!document.querySelector('[data-photo-viewer] img')?.complete"), "large private image loaded");
  await evaluate("document.querySelector('button[aria-label=\"הגדל תמונה\"]').click()");
  assert.equal(await evaluate("document.querySelector('output[aria-label=\"רמת הגדלה\"]').textContent"), "150%");
  await screenshot("photo-viewer-mobile-320.png");
  await click("התאם למסך");
  const area = await evaluate("(() => {const r=document.querySelector('[data-photo-viewer]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()");
  await page("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: area.x - 30, y: area.y }, { x: area.x + 30, y: area.y }] });
  await page("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: area.x - 75, y: area.y }, { x: area.x + 75, y: area.y }] });
  await page("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  assert.ok(await evaluate("parseInt(document.querySelector('output[aria-label=\"רמת הגדלה\"]').textContent)>200"), "Pinch zoom works");
  await page("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: area.x, y: area.y }] });
  await page("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: area.x + 40, y: area.y }] });
  await page("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  assert.ok(await evaluate("!document.querySelector('[data-photo-viewer] img').style.transform.startsWith('translate(0px')"), "Zoomed image can be dragged");
  await evaluate("document.querySelector('dialog[aria-label=\"test-receipt.jpg\"] button[aria-label=\"סגור תמונה\"]').click()");
  assert.ok(await evaluate("!!document.querySelector('dialog[aria-labelledby=\"shipment-edit-title\"][open]')"), "Closing photo keeps shipment editor open");
  await screenshot("shipment-edit-mobile-320.png");
  await page("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await screenshot("shipment-edit-mobile-390.png");
  await page("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await screenshot("shipment-edit-desktop.png");
  await page("Emulation.setDeviceMetricsOverride", { width: 320, height: 844, deviceScaleFactor: 1, mobile: true });
  await click("שמור שינויים"); await waitFor(() => evaluate("!document.querySelector('dialog[open]')"), "shipment saved");
  await waitText("05/09/2026"); assert.equal(shipmentVersion, 1);
  await evaluate("document.querySelector('button[aria-label^=\"ערוך שיווק\"]').click()");
  await waitText("מסמכים מצורפים (1)");
  assert.ok(await evaluate("!!document.querySelector('button[aria-label=\"הגדל תמונה test-receipt.jpg\"]')"), "Existing image appears automatically when shipment is reopened");
  await click("ביטול");

  await click("דוחות ומעקב"); await waitText("יתרות פתוחות לפי סוחר");
  await waitFor(() => evaluate("!!document.querySelector('summary')"), "reports loaded");
  assert.ok((await text()).includes("5 מיכלים"), "Both traders' open containers are counted");
  await screenshot("reports-balances-mobile-320.png");
  await click("מחירים ומגמות"); await waitText("מגמה חודשית");
  assert.ok((await text()).includes("1.80"), "Weighted price uses confirmed revenue / kg");
  await screenshot("reports-prices-mobile-320.png");
  await click("סיכום עונה"); await waitText("פירוט לפי חלקה וזן");
  await fill("עונה", "2026");
  await waitText("השוואה לתקופה המקבילה");
  await screenshot("reports-season-mobile-320.png");
  await page("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await screenshot("reports-season-mobile-390.png");
  await page("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await screenshot("reports-season-desktop.png");
  await page("Emulation.setDeviceMetricsOverride", { width: 320, height: 844, deviceScaleFactor: 1, mobile: true });
  await send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: temp, eventsEnabled: true });
  let downloadName;
  handlers.set("Browser.downloadWillBegin", [(event) => { downloadName = event.suggestedFilename; }]);
  await click("ייצוא לאקסל");
  const excel = await waitFor(async () => {
    try { return downloadName ? await readFile(join(temp, downloadName)) : null; } catch { return null; }
  }, "Excel downloaded");
  assert.equal(excel.readUInt32LE(0), 0x04034b50);
  assert.ok(excel.includes(Buffer.from("xl/worksheets/sheet6.xml")));
  await fill("סוחר", "2");
  assert.ok((await text()).includes("חסרים נתוני עלות"));
  await click("יתרות סוחרים");
  assert.ok((await text()).includes("3 מיכלים"));
  await click("תקבולים"); await waitText("תקבולים קודמים");
  await evaluate("document.querySelectorAll('details').forEach(item=>item.open=true)");
  await waitText("אין מסמכים מצורפים");
  await upload("camera");
  assert.equal(documents.filter((d) => d.receipt_id).length, 1);
  await evaluate("document.querySelector('details').open=false");
  await waitFor(() => evaluate("!document.querySelector('input[type=file]')"), "receipt documents unmounted when closed");
  await evaluate("document.querySelector('details').open=true");
  await waitText("מסמכים מצורפים (1)");
  assert.ok(await evaluate("!!document.querySelector('button[aria-label=\"הגדל תמונה test-receipt.jpg\"]')"), "Receipt preview opens automatically with existing attachments");
  acceptDialog = false; await click("מחיקה"); acceptDialog = true;
  assert.equal(documents.length, 2);
  await click("מחיקה"); await waitText("אין מסמכים מצורפים");
  assert.equal(documents.length, 1); assert.equal(storedFiles.size, 1);
  await click("שיווקים");

  for (const status of ["draft", "cancelled"]) {
    const item = structuredClone(workspace.receipts[0]);
    item.id = crypto.randomUUID(); item.status = status; item.cancellation_reason = "בדיקה";
    workspace.receipts.push(item);
    await click("תקבולים"); await waitText("תקבולים קודמים");
    await click("רענון רשימה");
    await fill("מצב", status);
    await waitFor(() => evaluate("!!document.querySelector('details')"), "receipt to delete");
    await evaluate("document.querySelectorAll('details').forEach(item=>item.open=true)");
    acceptDialog = false; await click("מחיקת תקבול"); acceptDialog = true;
    assert.ok(workspace.receipts.some((record) => record.id === item.id), "Cancelled confirmation keeps receipt");
    await click("מחיקת תקבול"); await waitText("התקבול נמחק");
    await waitFor(() => evaluate("!document.querySelector('details')"), "deleted receipt removed from list");
    assert.equal(workspace.receipts.some((record) => record.id === item.id), false);
    assert.equal(paidWeights()[0].net_weight, 560);
    await fill("מצב", "confirmed");
    assert.equal(await evaluate("[...document.querySelectorAll('button')].some(item=>item.textContent==='מחיקת תקבול')"), false);
    await click("שיווקים");
  }

  role = "worker"; await seedSession(); await page("Page.navigate", { url: origin }); await waitText("עובד");
  assert.equal(await evaluate("[...document.querySelectorAll('button')].some(item=>item.textContent==='דוחות ומעקב')"), false);
  await click("שיווקים"); await waitText("רשימת שיווקים"); await evaluate("document.querySelector('button[aria-label^=\"ערוך שיווק\"]').click()");
  await fill("מספר מיכלים", "3");
  await waitFor(() => evaluate("[...document.querySelectorAll('button')].some(b=>b.textContent==='שמור שינויים'&&!b.disabled)"), "worker edit ready");
  await click("שמור שינויים");
  await waitFor(() => evaluate("!document.querySelector('dialog[open]')"), "worker edit saved");
  assert.equal(shipmentVersion, 2);
  workspace.receipts.forEach((r) => { r.status = "cancelled"; });
  await evaluate("document.querySelector('button[aria-label^=\"ערוך שיווק\"]').click()");
  await waitFor(() => evaluate("[...document.querySelectorAll('label')].find(l=>l.textContent.startsWith('סוחר'))?.querySelector('select')?.options.length>=3"), "worker trader options");
  await fill("סוחר", "2"); await click("שמור שינויים");
  await waitFor(() => evaluate("!document.querySelector('dialog[open]')"), "worker changed trader");
  assert.equal(workspace.shipments[0].trader_id, "2"); assert.equal(shipmentVersion, 3);

  role = "viewer"; await seedSession(); await page("Page.navigate", { url: origin }); await waitText("צופה");
  assert.equal(await evaluate("[...document.querySelectorAll('button')].some(item=>item.textContent.trim()==='תקבולים')"), false);
  assert.equal(await evaluate("[...document.querySelectorAll('button')].some(item=>item.textContent.trim()==='שמור שיווק')"), false);
  await click("שיווקים"); await waitText("רשימת שיווקים");
  assert.equal(await evaluate("!!document.querySelector('button[aria-label^=\"ערוך שיווק\"]')"), false);
  await evaluate("document.querySelector('button[aria-label=\"מיון לפי מיכלים\"]').click()");
  assert.equal(await evaluate("document.querySelector('button[aria-label=\"מיון לפי מיכלים\"]').closest('th').getAttribute('aria-sort')"), "ascending");
  assert.deepEqual(errors, []);
  console.log(`Browser checks passed: receipts, dashboard, mobile shipments, reports/filters, Excel download, shipment/receipt documents and role permissions. Screenshots: ${temp}`);
} catch (error) {
  console.error("Browser failure context:", await failureInfo());
  throw error;
} finally {
  if (ws?.readyState === WebSocket.OPEN && send) {
    await Promise.race([send("Browser.close").catch(() => {}), new Promise((done) => setTimeout(done, 1000))]);
    ws.close();
  }
  chrome.kill(); server.kill();
}
