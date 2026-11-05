// Reads your orders and invoices from Amazon, with the browser's own Amazon sign-in (its cookies). No password is
// ever asked for or stored. Every request is a plain page load of the same pages you'd open yourself, a few at a time
// (CONCURRENCY), like a person with a few tabs open. If Amazon says to slow down, the request waits and tries again.
//
// The pages used, the same ones Amazon's own "Your Orders" uses:
//   /your-orders/orders?timeFilter=year-YYYY&startIndex=N   order history, 10 orders a page
//   /your-orders/invoice/popover?orderId=ID                 the "Invoice" menu of an order: PDF invoices, if the
//                                                           seller issued any, and the printable order summary
//   /gp/css/summary/print.html?orderID=ID                   the printable order summary (what amazon.com calls
//                                                           the invoice when there's no PDF)

const CANCELLED = /\border was cancell?ed\b/i;
export const ORDER_ID = /\b(?:\d{3}|D\d{2})-\d{7}-\d{7}\b/;
const PAGE_SIZE = 10;
export const CONCURRENCY = 3;               // requests in flight at once
const RETRY_MS = [2000, 5000, 15000];       // waits before trying again when Amazon answers 429 or 5xx

// Amazon sent a request to its sign-in page. Signed in or not as far as the header goes, it wants the password
// (again) before it shows your orders: it asks for that after switching accounts, and from time to time anyway.
// path: the page that was asked for, for the message.
export class NotSignedIn extends Error {
  constructor(path) {
    super("Amazon wants you to sign in (again) before it shows your orders. It asks for that after switching " +
      "accounts, even while the page greets you by name. Open Your Orders in this tab, sign in if it asks, then try again." +
      (path ? ` (Asked for ${path}, sent to the sign-in page.)` : ""));
    this.path = path;
  }
}

// Month names (and their abbreviations, by prefix) on the Amazon sites listed in the manifest.
const MONTHS = [
  ["january", "januar", "januari", "janvier", "enero", "gennaio"],
  ["february", "februar", "februari", "février", "fevrier", "febrero", "febbraio"],
  ["march", "märz", "maerz", "maart", "mars", "marzo"],
  ["april", "avril", "abril", "aprile"],
  ["may", "mai", "mei", "mayo", "maggio"],
  ["june", "juni", "juin", "junio", "giugno"],
  ["july", "juli", "juillet", "julio", "luglio"],
  ["august", "augustus", "août", "aout", "agosto"],
  ["september", "septembre", "septiembre", "settembre"],
  ["october", "oktober", "octobre", "octubre", "ottobre"],
  ["november", "novembre", "noviembre"],
  ["december", "dezember", "décembre", "decembre", "diciembre", "dicembre"],
];

function monthOf(word) {
  const w = word.toLowerCase().replace(/\.$/, "");
  if (w.length < 3) return 0;
  const hits = new Set();
  MONTHS.forEach((names, i) => { if (names.some((n) => n === w || n.startsWith(w))) hits.add(i + 1); });
  return hits.size === 1 ? [...hits][0] : 0;
}

const pad = (n) => String(n).padStart(2, "0");

// The first date written out in text, as "YYYY-MM-DD", or "" if there's none. Reads "November 1, 2026",
// "1 November 2026", "1. November 2026", "1 nov. 2026" and "1 de noviembre de 2026".
export function parseDate(text) {
  const L = "\\p{L}+\\.?";
  const patterns = [
    [new RegExp(`(${L})\\s+(\\d{1,2}),?\\s+(\\d{4})`, "u"), (m) => [m[3], monthOf(m[1]), m[2]]],
    [new RegExp(`(\\d{1,2})\\.?\\s+(?:de\\s+)?(${L})\\s+(?:de\\s+)?(\\d{4})`, "u"), (m) => [m[3], monthOf(m[2]), m[1]]],
  ];
  let best = null;
  for (const [re, pick] of patterns) {
    for (const m of text.matchAll(new RegExp(re.source, "gu"))) {
      const [y, mo, d] = pick(m);
      if (!mo || +d < 1 || +d > 31) continue;
      if (!best || m.index < best.index) best = { index: m.index, value: `${y}-${pad(mo)}-${pad(+d)}` };
      break;
    }
  }
  return best ? best.value : "";
}

// An element's text with its pieces kept apart ("Order placed" + "November 1, 2026", not "placedNovember").
function textOf(el) {
  if (!el) return "";
  const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const parts = [];
  while (walker.nextNode()) parts.push(walker.currentNode.nodeValue);
  return parts.join(" ").replace(/\s+/g, " ");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// What the pages hold when they worked: order cards, the invoice menu's links, a printable summary.
const CONTENT = ".js-yo-container, .order-card, .order, a[href*='print.html'], a[href*='/documents/download/'], #pos_view_section, table";

function checkSignedIn(res, doc, url) {
  const asked = new URL(url).pathname;
  if (new URL(res.url).pathname.startsWith("/ap/")) throw new NotSignedIn(asked);
  // A sign-in form alone isn't enough: Amazon pages can carry one (account switching, "verify it's you") around
  // content that's there all the same. Only a page that's nothing but the form means signed out.
  if (doc?.querySelector("form[name='signIn']") && !doc.querySelector(CONTENT)) throw new NotSignedIn(asked);
  if (doc?.querySelector("form[action*='validateCaptcha']")) {
    throw new Error("Amazon is asking for a captcha. Open any Amazon page in this browser, solve it, then try again.");
  }
}

// ctx, passed down from the caller: { signal, onRequest }. onRequest is called after every request, for progress.
async function get(url, ctx = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { credentials: "include", signal: ctx.signal });
    const busy = res.status === 429 || res.status >= 500;
    if (busy && attempt < RETRY_MS.length) {
      await sleep(RETRY_MS[attempt]);
      continue;
    }
    ctx.onRequest?.();
    if (!res.ok) throw new Error(`Amazon answered ${res.status} for ${new URL(url).pathname}`);
    return res;
  }
}

async function getDoc(url, ctx) {
  const res = await get(url, ctx);
  const doc = new DOMParser().parseFromString(await res.text(), "text/html");
  checkSignedIn(res, doc, url);
  return doc;
}

function idFromCard(card) {
  for (const a of card.querySelectorAll("a[href]")) {
    const q = new URL(a.getAttribute("href"), "https://x").searchParams;
    const id = q.get("orderID") ?? q.get("orderId");
    if (id && ORDER_ID.test(id)) return id;
  }
  return card.textContent.match(ORDER_ID)?.[0] ?? "";
}

// The orders on one order history page: [{ id, date }]. date is "" when it couldn't be read.
export function parseOrders(doc) {
  let cards = [...doc.querySelectorAll("div.order-card")];
  if (!cards.length) cards = [...doc.querySelectorAll("div.order")];
  const orders = [];
  for (const card of cards) {
    const id = idFromCard(card);
    if (!id || orders.some((o) => o.id === id)) continue;
    const head = card.querySelector("[data-component='orderDate'], span.order-date-invoice-item, .order-header");
    orders.push({ id, date: parseDate(textOf(head)) || parseDate(textOf(card)) });
  }
  return orders;
}

function hasNextPage(doc) {
  const last = doc.querySelector("ul.a-pagination li.a-last");
  return !!last && !last.classList.contains("a-disabled") && !!last.querySelector("a");
}

// How many orders the year has, from the page's "12 orders placed in 2026", or null if it doesn't say.
export function orderCount(doc) {
  const el = doc.querySelector(".js-yo-container span.num-orders, span.num-orders, form.js-time-filter-form label.time-filter__label b");
  const n = parseInt(textOf(el).replace(/[^\d]/g, ""), 10);
  return Number.isFinite(n) ? n : null;
}

// Runs fn on every item, at most n at a time, and returns the results in the items' order.
export async function pool(items, n, fn, signal) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      signal?.throwIfAborted();
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return results;
}

const historyUrl = (origin, year, start) =>
  `${origin}/your-orders/orders?timeFilter=year-${year}&startIndex=${start}&disableCsd=no-js`;

// Every order placed in the years from..to, oldest first. ctx.onPages(n) says how many history pages there are, as
// far as that's known: one a year at first, then all of them once each year's first page gives its order count.
export async function ordersOfYears(origin, fromYear, toYear, ctx = {}) {
  const years = [];
  for (let y = fromYear; y <= toYear; y++) years.push(y);
  ctx.onPages?.(years.length);

  const firsts = await pool(years, CONCURRENCY, (y) => getDoc(historyUrl(origin, y, 0), ctx), ctx.signal);
  const rest = [];        // [{ year, start }] of the pages still to read, for years that gave their count
  const unknown = [];     // years that didn't, read a page at a time until there's no next page
  years.forEach((year, i) => {
    const count = orderCount(firsts[i]);
    if (count === null) { if (hasNextPage(firsts[i])) unknown.push(year); return; }
    for (let start = PAGE_SIZE; start < count; start += PAGE_SIZE) rest.push({ year, start });
  });
  let total = years.length + rest.length + unknown.length;
  ctx.onPages?.(total);

  const pages = years.map((year, i) => ({ year, start: 0, orders: parseOrders(firsts[i]) }));
  const more = await pool(rest, CONCURRENCY, async (p) => ({ ...p, orders: parseOrders(await getDoc(historyUrl(origin, p.year, p.start), ctx)) }), ctx.signal);
  pages.push(...more);
  for (const year of unknown) {
    for (let start = PAGE_SIZE; start < PAGE_SIZE * 200; start += PAGE_SIZE) {
      const doc = await getDoc(historyUrl(origin, year, start), ctx);
      const orders = parseOrders(doc);
      pages.push({ year, start, orders });
      if (!orders.length || !hasNextPage(doc)) break;
      ctx.onPages?.(++total);
    }
  }

  // Amazon lists each year newest first; turn it around. Orders without a readable date keep their place in it.
  pages.sort((a, b) => a.year - b.year || b.start - a.start);
  const seen = new Set(), all = [];
  for (const p of pages) {
    for (const o of [...p.orders].reverse()) if (!seen.has(o.id)) { seen.add(o.id); all.push(o); }
  }
  return all;
}

export function isPdfHref(href) {
  const h = href.trim().toLowerCase();
  if (h.startsWith("javascript:") || h.includes("/gp/help/") || h.includes("/summary/print.htm")) return false;
  return /\.pdf(?:$|[?#])/.test(h) || h.includes("/documents/download/");
}

// What an order's "Invoice" menu offers: { pdfs: [url], summary: url }.
export async function invoiceLinks(origin, id, ctx = {}) {
  const doc = await getDoc(`${origin}/your-orders/invoice/popover?orderId=${encodeURIComponent(id)}`, ctx);
  const hrefs = [...doc.querySelectorAll("a[href]")].map((a) => new URL(a.getAttribute("href"), origin).href);
  const pdfs = [...new Set(hrefs.filter(isPdfHref))];
  const fallback = id.startsWith("D")
    ? `${origin}/gp/digital/your-account/order-summary.html?orderID=${id}`
    : `${origin}/gp/css/summary/print.html?orderID=${id}`;
  const summary = hrefs.find((h) => /\/summary\/print\.html|order-summary\.html/.test(h)) ?? fallback;
  return { pdfs, summary };
}

// A saved copy of the printable summary that opens on its own: scripts removed, links and images pointed back at
// Amazon. Returns { html, date, cancelled }: cancelled orders have no invoice, only this page, saying so.
export async function summaryPage(origin, url, ctx = {}) {
  const doc = await getDoc(url, ctx);
  doc.querySelectorAll("script, noscript").forEach((s) => s.remove());
  const base = doc.createElement("base");
  base.href = origin + "/";
  const charset = doc.createElement("meta");
  charset.setAttribute("charset", "utf-8");
  doc.head.prepend(charset, base);
  const text = textOf(doc.body);
  return { html: "<!doctype html>\n" + doc.documentElement.outerHTML, date: parseDate(text), cancelled: CANCELLED.test(text) };
}

export async function pdf(url, ctx = {}) {
  const res = await get(url, ctx);
  checkSignedIn(res, null, url);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (String.fromCharCode(...bytes.slice(0, 5)) !== "%PDF-") throw new Error("the invoice link didn't return a PDF");
  return bytes;
}

// The files of one order's invoices: [{ name, data }]. PDF invoices when the order has any, otherwise the
// printable order summary as HTML (named ..._cancelled.html for a cancelled order). date may be "" (single orders); it's then read from the summary if one is saved.
export async function invoicesOfOrder(origin, { id, date }, ctx = {}) {
  const { pdfs, summary } = await invoiceLinks(origin, id, ctx);
  const stem = (d) => (d ? `${d}_${id}` : id);
  if (pdfs.length) {
    const files = [];
    for (const [i, url] of pdfs.entries()) {
      files.push({ name: `${stem(date)}${pdfs.length > 1 ? `_${i + 1}` : ""}.pdf`, data: await pdf(url, ctx) });
    }
    return { files, kind: "pdf", date };
  }
  const page = await summaryPage(origin, summary, ctx);
  const d = date || page.date;
  const kind = page.cancelled ? "cancelled" : "summary";
  return { files: [{ name: `${stem(d)}${page.cancelled ? "_cancelled" : ""}.html`, data: page.html }], kind, date: d };
}
