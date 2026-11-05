// End to end: loads the unpacked extension into Playwright's Chromium, answers its requests to www.amazon.com with
// sample pages shaped like Amazon's (no request leaves the machine), opens the dialog the way the toolbar icon does,
// runs a download and unzips what it saves. A SameSite=Lax cookie stands in for the Amazon sign-in, to check the
// requests carry it (requests made from an extension's own page would leave it out).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";

const EXT = fileURLToPath(new URL("../extension", import.meta.url));
const AMZ = "https://www.amazon.com";
const CA = "https://www.amazon.ca";
const PDF = (id) => Buffer.from(`%PDF-1.4\n% invoice ${id}\n%%EOF\n`);

// A history card the way Amazon renders one: header with the date, order number and an "Invoice" popover link.
const card = (id, date) => `
  <div class="order-card js-order-card">
    <div class="order-header"><div class="a-row">
      <span class="a-text-caps">Order placed</span><span class="a-size-base">${date}</span></div>
      <div class="yohtmlc-order-id"><span>Order #</span> <span dir="ltr">${id}</span></div>
      <span class="a-declarative" data-action="a-popover"
        data-a-popover='{"url":"/your-orders/invoice/popover?orderId=${id}&ref_=fed_invoice_ajax"}'>
        <a class="a-link-normal" href="/your-orders/invoice/popover?orderId=${id}&ref_=fed_invoice_ajax">Invoice</a></span>
    </div>
    <div class="a-box"><a href="/dp/B000000">Some item</a></div>
  </div>`;
// count: the "3 orders placed in 2026" Amazon shows above the list; null leaves it out, so the pages are read one by
// one until there's no next page.
const history = (cards, next, count) => `<!doctype html><html><body><div class="js-yo-container">
  ${count === null ? "" : `<label><span class="num-orders">${count} orders</span> placed in</label>`}${cards.join("")}
  <ul class="a-pagination"><li class="a-last ${next ? "" : "a-disabled"}">${next ? '<a href="#">Next</a>' : "Next"}</li></ul>
  </div></body></html>`;

const ORDERS = {
  2026: [
    [["111-0000001-0000001", "October 30, 2026"], ["111-0000002-0000002", "September 2, 2026"]],
    [["111-0000003-0000003", "January 5, 2026"]],
  ],
  2025: [[["111-0000004-0000004", "December 20, 2025"], ["111-0000005-0000005", "February 1, 2025"]]],
};
const ORDERS_CA = {
  2026: [[["702-0000006-0000006", "October 28, 2026"], ["702-0000007-0000007", "March 3, 2026"]]],
};
const COUNTED = { [AMZ]: [2026], [CA]: [2026] };   // years whose page gives the count; amazon.com 2025 doesn't
const PDF_ORDERS = { "111-0000001-0000001": 2, "111-0000004-0000004": 1 };   // the rest only have a summary

let context, sw, dir, requests = [];
let inFlight = 0, maxInFlight = 0;
let delay = () => 40;              // ms before each answer, so requests overlap like real ones
const busyOnce = new Set();
let withSignInForm = false;       // puts an (account switching) sign-in form on every page, around the content        // paths answered 429 once, the next time they're asked for
const seenCookies = [], seenOrigins = [];

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "amz-inv-"));
  context = await chromium.launchPersistentContext(path.join(dir, "profile"), {
    headless: true,
    channel: "chromium",
    // Nothing reaches the real network, even requests the test can't intercept (tabs the extension opens itself).
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--host-resolver-rules=MAP * ~NOTFOUND"],
    acceptDownloads: true,
  });
  await context.addCookies([".amazon.com", ".amazon.ca"].map((domain) =>
    ({ name: "session-id", value: "signed-in", domain, path: "/", sameSite: "Lax", secure: true })));
  sw = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));

  await context.route((u) => [AMZ, CA].includes(u.origin), async (route) => {
    const req = route.request(), u = new URL(req.url());
    requests.push(u.pathname + u.search);
    seenOrigins.push(u.origin);
    seenCookies.push((await req.allHeaders()).cookie ?? "");
    maxInFlight = Math.max(maxInFlight, ++inFlight);
    await new Promise((r) => setTimeout(r, delay(u)));
    inFlight--;
    if (busyOnce.delete(u.pathname + u.search)) return route.fulfill({ status: 429, body: "slow down" });
    const html = (body) => route.fulfill({ contentType: "text/html; charset=utf-8",
      body: withSignInForm ? `<form name="signIn" hidden><input name="email"></form>${body}` : body });
    if (u.pathname === "/your-orders/orders") {
      const year = (u.searchParams.get("timeFilter") ?? "").replace("year-", "");
      const pages = (u.origin === CA ? ORDERS_CA : ORDERS)[year] ?? [[]];
      const p = +u.searchParams.get("startIndex") / 10;
      // As many orders as the pages hold at Amazon's 10 a page (the samples put fewer on each, to keep them short).
      const count = COUNTED[u.origin].includes(+year) ? (pages.length - 1) * 10 + pages.at(-1).length : null;
      return html(history((pages[p] ?? []).map(([id, d]) => card(id, d)), p < pages.length - 1, count));
    }
    if (u.pathname === "/your-orders/invoice/popover") {
      const id = u.searchParams.get("orderId");
      const pdfs = Array.from({ length: PDF_ORDERS[id] ?? 0 }, (_, i) =>
        `<li><a class="a-link-normal" href="/documents/download/uuid-${id}-${i}/invoice.pdf">Invoice ${i + 1}</a></li>`);
      return html(`<ul class="invoice-list">
        <li><a class="a-link-normal" href="/gp/css/summary/print.html?orderID=${id}&ref=ppx_od_dt_b_invoice">Printable Order Summary</a></li>
        ${pdfs.join("")}<li><a href="/gp/help/contact/contact.html">Request invoice</a></li></ul>`);
    }
    if (u.pathname.startsWith("/documents/download/")) {
      return route.fulfill({ contentType: "application/pdf", body: PDF(u.pathname.split("/")[3]) });
    }
    if (u.pathname === "/gp/css/summary/print.html") {
      const id = u.searchParams.get("orderID");
      return html(`<html><head><title>Amazon.com - Order ${id}</title><script>alert(1)</script></head>
        <body><table><tr><td><b>Order Placed:</b> July 4, 2026</td></tr><tr><td>Amazon.com order number: ${id}</td></tr>
        ${id === "111-0000003-0000003" ? "<tr><td>Cancelled</td></tr><tr><td>Your order was cancelled. You have not been charged for this order.</td></tr>" : ""}
        <tr><td>Grand Total: $10.00</td></tr></table></body></html>`);
    }
    return route.fulfill({ status: 404, body: "not in the test" });
  });
});

after(async () => {
  await context?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// Clicks the toolbar icon (as far as a test can) on the given tab, and waits for the dialog. Returns its shadow root
// as a locator scope.
async function openDialog(page, { wait = true } = {}) {
  await sw.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({ url });
    await globalThis.openPanel(tabs.sort((a, b) => b.id - a.id)[0]);   // the newest, the page the test just opened
  }, page.url());
  const dialog = page.locator("nerd-ledger .panel");
  if (wait) await dialog.waitFor();
  return dialog;
}

// Runs one download from the dialog on an Amazon page and returns the unzipped files: { name: Buffer }.
async function download(fill, site = AMZ) {
  requests = [];
  seenCookies.length = seenOrigins.length = 0;
  maxInFlight = 0;
  const page = await context.newPage();
  await page.goto(`${site}/your-orders/orders`);
  const dialog = await openDialog(page);
  await fill(dialog);
  const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 60000 }), dialog.locator(".start").click()]);
  const zip = path.join(dir, dl.suggestedFilename());
  await dl.saveAs(zip);
  const out = path.join(dir, "out-" + Date.now());
  execFileSync("unzip", ["-q", zip, "-d", out]);
  const files = Object.fromEntries(fs.readdirSync(out).map((f) => [f, fs.readFileSync(path.join(out, f))]));
  const status = await dialog.locator(".now").textContent();
  await page.close();
  return { name: dl.suggestedFilename(), files, status };
}

test("a time frame across two years: only orders in it, PDFs when there are any, the summary otherwise", async () => {
  const { name, files, status } = await download(async (dialog) => {
    await dialog.locator("input[name=mode][value=range]").check();
    await dialog.locator("input[name=from]").fill("2025-12-01");
    await dialog.locator("input[name=to]").fill("2026-10-01");
  });
  assert.equal(name, "amazon-invoices_2025-12-01_to_2026-10-01.zip");
  assert.deepEqual(Object.keys(files).sort(), [
    "2025-12-20_111-0000004-0000004.pdf",
    "2026-01-05_111-0000003-0000003_cancelled.html",
    "2026-09-02_111-0000002-0000002.html",
    "index.csv",
  ]);
  assert.match(files["2025-12-20_111-0000004-0000004.pdf"].toString(), /^%PDF-/);
  const summary = files["2026-09-02_111-0000002-0000002.html"].toString();
  assert.match(summary, /<base href="https:\/\/www\.amazon\.com\/">/);
  assert.doesNotMatch(summary, /<script/);
  const csv = files["index.csv"].toString().trim().split("\n");
  assert.equal(csv[0], "order_date,order_id,invoice,files");
  assert.deepEqual(csv.slice(1).map((r) => r.split(",")[0]), ["2025-12-20", "2026-01-05", "2026-09-02"], "oldest first");
  assert.match(csv[2], /^2026-01-05,111-0000003-0000003,"?cancelled, not charged/);
  assert.ok(maxInFlight > 1 && maxInFlight <= 3, `a few requests at a time, not more (saw ${maxInFlight})`);
  assert.match(status, /Done: 3 of 3 orders/);
  // Both pages of 2026 were read, and every request carried the browser's Amazon sign-in.
  assert.ok(requests.some((r) => r.includes("timeFilter=year-2026&startIndex=10")));
  assert.ok(seenCookies.every((c) => c.includes("session-id=signed-in")), "every request carries the sign-in cookie");
});

test("single order numbers: several PDFs of one order, and a summary whose date is read from the page", async () => {
  const { name, files } = await download(async (dialog) => {
    await dialog.locator("input[name=mode][value=ids]").check();
    await dialog.locator("textarea[name=orders]").fill("111-0000001-0000001, 111-0000005-0000005");
  });
  assert.match(name, /^amazon-invoices_2-orders_\d{4}-\d{2}-\d{2}\.zip$/);
  assert.deepEqual(Object.keys(files).sort(), [
    "111-0000001-0000001_1.pdf",
    "111-0000001-0000001_2.pdf",
    "2026-07-04_111-0000005-0000005.html",
    "index.csv",
  ]);
  assert.ok(!requests.some((r) => r.startsWith("/your-orders/orders?")), "no order history needed for order numbers");
});

test("amazon.ca: same flow, on that site only", async () => {
  const { name, files } = await download(async (dialog) => {
    await dialog.locator("input[name=mode][value=range]").check();
    await dialog.locator("input[name=from]").fill("2026-03-01");
    await dialog.locator("input[name=to]").fill("2026-10-27");
  }, CA);
  assert.equal(name, "amazon-invoices_2026-03-01_to_2026-10-27.zip");
  assert.deepEqual(Object.keys(files).sort(), ["2026-03-03_702-0000007-0000007.html", "index.csv"]);
  assert.match(files["2026-03-03_702-0000007-0000007.html"].toString(), /<base href="https:\/\/www\.amazon\.ca\/">/);
  assert.ok(seenOrigins.every((o) => o === CA), "only amazon.ca was asked");
  assert.ok(seenCookies.every((c) => c.includes("session-id=signed-in")));
});

test("when Amazon says to slow down (429), it waits and tries again", async () => {
  busyOnce.add("/your-orders/invoice/popover?orderId=111-0000002-0000002");
  const { files, status } = await download(async (dialog) => {
    await dialog.locator("input[name=mode][value=ids]").check();
    await dialog.locator("textarea[name=orders]").fill("111-0000002-0000002");
  });
  assert.deepEqual(Object.keys(files).sort(), ["2026-07-04_111-0000002-0000002.html", "index.csv"]);
  assert.match(status, /Done: 1 of 1 orders/);
  assert.equal(requests.filter((r) => r.startsWith("/your-orders/invoice/popover")).length, 2);
});

test("mid-run, leaving the page asks first, and Cancel saves what's read so far", async () => {
  delay = (u) => (u.pathname === "/your-orders/invoice/popover" ? 600 : 40);
  const page = await context.newPage();
  await page.goto(`${AMZ}/your-orders/orders`);
  const dialog = await openDialog(page);
  await dialog.locator("input[name=mode][value=ids]").check();
  await dialog.locator("textarea[name=orders]").fill(
    "111-0000001-0000001 111-0000002-0000002 111-0000003-0000003 111-0000004-0000004 111-0000005-0000005");
  await dialog.locator(".start").click();
  await dialog.locator(".log li").first().waitFor();

  const asked = new Promise((resolve) => page.once("dialog", (d) => { resolve(d.type()); d.dismiss(); }));
  await page.close({ runBeforeUnload: true });
  assert.equal(await asked, "beforeunload");
  assert.ok(!page.isClosed(), "staying on the page keeps the run going");

  const [dl] = await Promise.all([page.waitForEvent("download"), dialog.locator(".cancel").click()]);
  assert.match(dl.suggestedFilename(), /^amazon-invoices_partial_\d{4}-\d{2}-\d{2}\.zip$/);
  const zip = path.join(dir, "partial.zip");
  await dl.saveAs(zip);
  const index = execFileSync("unzip", ["-p", zip, "index.csv"]).toString().trim().split("\n");
  assert.ok(index.length > 1 && index.length < 6, `some orders, not all (${index.length - 1})`);
  assert.match(await dialog.locator(".now").textContent(), /^Cancelled\. Saved the \d of 5 orders/);
  delay = () => 40;
  await page.close();
});

test("from a tab that isn't Amazon, the icon opens your orders on the last used site", async () => {
  await sw.evaluate((site) => chrome.storage.local.set({ site }), CA);
  // What the click hands over on a tab the extension has no access to: no url. The new tab can't load here (no
  // network), so showing the dialog on it fails; that part is the same as on any Amazon tab.
  const tab = await sw.evaluate(() => new Promise((resolve) => {
    chrome.tabs.onCreated.addListener(function seen(t) { chrome.tabs.onCreated.removeListener(seen); resolve(t); });
    globalThis.openPanel({ id: -1, index: 0 }).catch(() => {});
  }));
  assert.equal(tab.pendingUrl ?? tab.url, `${CA}/your-orders/orders`);
  await sw.evaluate((id) => chrome.tabs.remove(id), tab.id);
});

test("the icon toggles the dialog, and it comes back as it was", async () => {
  const page = await context.newPage();
  await page.goto(`${AMZ}/your-orders/orders`);
  const dialog = await openDialog(page);
  await dialog.locator("input[name=mode][value=ids]").check();
  await openDialog(page, { wait: false });
  await dialog.waitFor({ state: "hidden" });
  await openDialog(page);
  assert.ok(await dialog.locator("textarea[name=orders]").isVisible());
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  await page.close();
});

test("a sign-in form on a page that has its content (switching accounts) isn't taken for signed out", async () => {
  withSignInForm = true;
  const { files, status } = await download(async (dialog) => {
    await dialog.locator("input[name=mode][value=range]").check();
    await dialog.locator("input[name=from]").fill("2025-12-01");
    await dialog.locator("input[name=to]").fill("2026-10-01");
  });
  withSignInForm = false;
  assert.match(status, /Done: 3 of 3 orders/);
  assert.equal(Object.keys(files).length, 4);
});

test("the dialog shows the extension's version, and replaces one left by an older one", async () => {
  const version = JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"))).version;
  const page = await context.newPage();
  await page.goto(`${AMZ}/your-orders/orders`);
  await page.evaluate(() => document.documentElement.append(document.createElement("nerd-ledger")));
  const dialog = await openDialog(page);
  assert.equal(await dialog.locator(".version").textContent(), `v${version}`);
  assert.equal(await page.locator("nerd-ledger").count(), 1);
  await page.close();
});

test("not signed in: says so instead of saving an empty zip", async () => {
  const page = await context.newPage();
  await page.goto(`${AMZ}/your-orders/orders`);
  // Signed out, Amazon sends the order pages to its sign-in form.
  const history = (u) => u.pathname === "/your-orders/orders" && u.searchParams.has("timeFilter");
  await context.route(history, (route) =>
    route.fulfill({ contentType: "text/html", body: '<form name="signIn"><input name="email"></form>' }));
  const dialog = await openDialog(page);
  await dialog.locator("input[name=mode][value=range]").check();
  await dialog.locator("input[name=from]").fill("2026-01-01");
  await dialog.locator(".start").click();
  await page.waitForFunction(() => {
    const r = document.querySelector("nerd-ledger").shadowRoot;
    return !r.querySelector(".start").disabled && r.querySelector(".now").textContent;
  });
  assert.match(await dialog.locator(".now").textContent(), /^Amazon wants you to sign in \(again\)/);
  assert.equal(await dialog.locator(".signin").getAttribute("href"), `${AMZ}/your-orders/orders`);
  await page.close();
  await context.unroute(history);
});
