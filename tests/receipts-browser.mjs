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
      else if (url.pathname.endsWith("/get_receipt_workspace")) {
        assert.equal(role, "admin");
        workspace.shipments[0].used_containers = paidWeights()[0]?.containers || 0;
        body = workspace;
      } else if (url.pathname.endsWith("/edit_farm_shipment")) {
        assert.ok(role === "admin" || role === "worker");
        const request = JSON.parse(event.request.postData);
        assert.equal(request.expected_version, shipmentVersion);
        Object.assign(workspace.shipments[0], { harvest_date: request.new_date,
          variety_id: String(request.new_variety_id), plot_id: String(request.new_plot_id), containers: request.new_containers });
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
  await screenshot("shipment-edit-mobile-320.png");
  await page("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await screenshot("shipment-edit-mobile-390.png");
  await page("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await screenshot("shipment-edit-desktop.png");
  await page("Emulation.setDeviceMetricsOverride", { width: 320, height: 844, deviceScaleFactor: 1, mobile: true });
  await click("שמור שינויים"); await waitFor(() => evaluate("!document.querySelector('dialog[open]')"), "shipment saved");
  await waitText("05/09/2026"); assert.equal(shipmentVersion, 1);

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
  await click("שיווקים"); await waitText("רשימת שיווקים"); await evaluate("document.querySelector('button[aria-label^=\"ערוך שיווק\"]').click()");
  await fill("מספר מיכלים", "3"); await click("שמור שינויים");
  await waitFor(() => evaluate("!document.querySelector('dialog[open]')"), "worker edit saved");
  assert.equal(shipmentVersion, 2);

  role = "viewer"; await seedSession(); await page("Page.navigate", { url: origin }); await waitText("צופה");
  assert.equal(await evaluate("[...document.querySelectorAll('button')].some(item=>item.textContent.trim()==='תקבולים')"), false);
  assert.equal(await evaluate("[...document.querySelectorAll('button')].some(item=>item.textContent.trim()==='שמור שיווק')"), false);
  await click("שיווקים"); await waitText("רשימת שיווקים");
  assert.equal(await evaluate("!!document.querySelector('button[aria-label^=\"ערוך שיווק\"]')"), false);
  await evaluate("document.querySelector('button[aria-label=\"מיון לפי מיכלים\"]').click()");
  assert.equal(await evaluate("document.querySelector('button[aria-label=\"מיון לפי מיכלים\"]').closest('th').getAttribute('aria-sort')"), "ascending");
  assert.deepEqual(errors, []);
  console.log(`Mobile browser checks passed: receipts, dashboard, sorting for viewers, shipment editing for admins/workers, mobile dialog. Screenshots: ${temp}`);
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
