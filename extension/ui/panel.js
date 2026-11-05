// The dialog over the Amazon page: pick a time frame or order numbers, then it reads the invoices and saves one zip.
import { ORDER_ID, CONCURRENCY, NotSignedIn, ordersOfYears, invoicesOfOrder, pool } from "../lib/amazon.js";
import { makeZip } from "../lib/zip.js";

const MARKUP = `
  <div class="panel" role="dialog" aria-label="Nerdledger">
    <button type="button" class="close" title="Close (Esc)">×</button>
    <h1>Nerdledger <span class="version"></span></h1>
    <p class="hint">Downloads the invoices of your orders on <b class="site"></b> as one zip.</p>

    <form>
      <fieldset>
        <legend>Which orders</legend>
        <label class="radio"><input type="radio" name="mode" value="range" checked> A time frame</label>
        <label class="radio"><input type="radio" name="mode" value="ids"> Order numbers</label>
      </fieldset>

      <div class="range">
        <div class="row">
          <label class="block">From <input type="date" name="from"></label>
          <label class="block">To <input type="date" name="to"></label>
        </div>
        <p class="hint">Leave "To" empty for everything up to today.</p>
        <div class="presets">
          <button type="button" data-preset="30">Last 30 days</button>
          <button type="button" data-preset="this">This year</button>
          <button type="button" data-preset="last">Last year</button>
        </div>
      </div>

      <div class="ids" hidden>
        <label class="block">Order numbers
          <textarea name="orders" rows="3" placeholder="112-1234567-1234567"></textarea>
        </label>
        <p class="hint">One or more, separated by spaces, commas or new lines.</p>
      </div>

      <div class="actions">
        <button type="submit" class="primary start">Download invoices</button>
        <button type="button" class="cancel" hidden>Cancel</button>
      </div>
    </form>

    <section class="status" hidden>
      <progress max="1" value="0"></progress>
      <p class="now"></p>
      <a class="save" hidden>Save the zip again</a>
      <a class="signin" hidden>Open Your Orders</a>
      <ol class="log"></ol>
    </section>
  </div>`;

const KINDS = { pdf: "PDF", summary: "order summary (HTML)", cancelled: "cancelled, not charged (order summary, HTML)" };
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const today = () => iso(new Date());
const csvCell = (s) => (/[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s);

// "about 3 min left", from how long the step's done part took. Nothing until there's enough to go on.
function timeLeft(started, done, total) {
  const spent = Date.now() - started;
  if (done < 3 || spent < 2000 || done >= total) return "";
  const s = Math.round((spent / done) * (total - done) / 1000);
  if (s < 60) return ", less than a minute left";
  return `, about ${Math.round(s / 60)} min left`;
}

export function mount() {
  const origin = location.origin;
  // A dialog left by the extension before it was reloaded or updated: it can't work any more, so it goes.
  document.querySelectorAll("nerd-ledger").forEach((old) => old.remove());
  const host = document.createElement("nerd-ledger");
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `<link rel="stylesheet" href="${chrome.runtime.getURL("ui/panel.css")}">${MARKUP}`;
  document.documentElement.append(host);

  const $ = (sel) => root.querySelector(sel);
  const form = $("form"), f = form.elements;
  let job = null, zipUrl = null;

  $(".site").textContent = location.hostname.replace(/^www\./, "");
  $(".version").textContent = `v${chrome.runtime.getManifest().version}`;
  f.from.max = f.to.max = today();
  chrome.storage.local.get(["from", "to", "mode"]).then((saved) => {
    f.from.value = saved.from ?? `${new Date().getFullYear()}-01-01`;
    f.to.value = saved.to ?? "";
    setMode(saved.mode ?? "range");
  });
  chrome.storage.local.set({ site: origin });

  function setMode(mode) {
    f.mode.value = mode;
    $(".range").hidden = mode !== "range";
    $(".ids").hidden = mode !== "ids";
  }
  for (const r of f.mode) r.addEventListener("change", () => setMode(r.value));

  for (const b of root.querySelectorAll("[data-preset]")) {
    b.addEventListener("click", () => {
      const y = new Date().getFullYear();
      if (b.dataset.preset === "30") { f.from.value = iso(new Date(Date.now() - 30 * 864e5)); f.to.value = ""; }
      if (b.dataset.preset === "this") { f.from.value = `${y}-01-01`; f.to.value = ""; }
      if (b.dataset.preset === "last") { f.from.value = `${y - 1}-01-01`; f.to.value = `${y - 1}-12-31`; }
    });
  }

  // Closing only hides it, so a download keeps running and the dialog comes back as it was.
  const toggle = (show = host.hidden) => { host.hidden = !show; };
  $(".close").addEventListener("click", () => toggle(false));
  host.addEventListener("click", (e) => { if (e.composedPath()[0] === host) toggle(false); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !host.hidden) toggle(false); });
  // Amazon's own key handlers shouldn't see typing in the dialog.
  for (const type of ["keydown", "keyup", "keypress"]) root.addEventListener(type, (e) => e.stopPropagation());

  $(".cancel").addEventListener("click", () => job?.abort());
  form.addEventListener("submit", (e) => { e.preventDefault(); run(); });

  function log(text, cls = "") {
    const li = document.createElement("li");
    li.textContent = text;
    if (cls) li.className = cls;
    $(".log").append(li);
    li.scrollIntoView({ block: "nearest" });
  }
  const now = (text) => { $(".now").textContent = text; };
  const progress = (done, total) => { $("progress").max = Math.max(total, 1); $("progress").value = done; };
  function busy(on) {
    $(".cancel").hidden = !on;
    for (const el of f) if (!el.classList.contains("cancel")) el.disabled = on;
  }
  function problem(text) { $(".status").hidden = false; $(".log").replaceChildren(); now(text); }

  // Leaving or reloading the page mid-run would lose it all, so the browser asks first.
  window.addEventListener("beforeunload", (e) => { if (job) e.preventDefault(); });

  async function run() {
    const mode = f.mode.value;
    const from = f.from.value, to = f.to.value || today();
    chrome.storage.local.set({ mode, from: f.from.value, to: f.to.value });

    let ids = [];
    if (mode === "ids") {
      ids = [...new Set(f.orders.value.split(/[\s,;]+/).filter(Boolean))];
      const bad = ids.filter((id) => !new RegExp(`^${ORDER_ID.source}$`).test(id));
      if (!ids.length) return problem("Enter at least one order number.");
      if (bad.length) return problem(`These don't look like Amazon order numbers: ${bad.join(", ")}`);
    } else if (!from) {
      return problem('Pick a "From" date.');
    } else if (from > to) {
      return problem('"From" is after "To".');
    }

    job = new AbortController();
    const { signal } = job;
    busy(true);
    $(".status").hidden = false;
    $(".log").replaceChildren();
    $(".save").hidden = true;
    $(".signin").hidden = true;
    if (zipUrl) URL.revokeObjectURL(zipUrl);
    progress(0, 1);

    const results = [];   // per order, in date order: { order, got } or { order, error }
    let orders = [];
    try {
      // 1. Which orders, oldest first.
      if (mode === "ids") {
        orders = ids.map((id) => ({ id, date: "" }));
      } else {
        let pages = 1, read = 0;
        const started = Date.now();
        const show = () => {
          progress(read, pages);
          now(`Step 1 of 2: reading your order history, page ${read} of ${pages}${timeLeft(started, read, pages)}`);
        };
        show();
        const found = await ordersOfYears(origin, +from.slice(0, 4), +to.slice(0, 4), {
          signal,
          onPages: (n) => { pages = n; show(); },
          onRequest: () => { read++; show(); },
        });
        orders = found.filter((o) => !o.date || (o.date >= from && o.date <= to));
        const undated = orders.filter((o) => !o.date).length;
        log(`${orders.length} orders from ${from} to ${to}` + (undated ? ` (${undated} without a readable date, included)` : ""));
      }
      if (!orders.length) { now("No orders in that time frame."); return; }

      // 2. Their invoices, a few orders at a time. An order that fails is noted and skipped.
      let done = 0;
      const started = Date.now();
      const show = () => {
        progress(done, orders.length);
        now(`${mode === "ids" ? "Invoices" : "Step 2 of 2: invoices"}, ${done} of ${orders.length} orders${timeLeft(started, done, orders.length)}`);
      };
      show();
      await pool(orders, CONCURRENCY, async (order, i) => {
        try {
          const got = await invoicesOfOrder(origin, order, { signal });
          results[i] = { order, got };
          log(`${got.date || "(no date)"} ${order.id}: ${got.kind === "pdf" && got.files.length > 1 ? `${got.files.length} PDFs` : KINDS[got.kind]}`, "good");
        } catch (err) {
          if (signal.aborted || err instanceof NotSignedIn) throw err;
          results[i] = { order, error: err };
          log(`${order.date} ${order.id}: failed (${err.message})`, "bad");
        }
        done++;
        show();
      }, signal);

      const failed = results.filter((r) => r.error).length;
      const name = save(results, mode === "ids"
        ? `amazon-invoices_${ids.length === 1 ? ids[0] : `${ids.length}-orders`}_${today()}.zip`
        : `amazon-invoices_${from}_to_${to}.zip`);
      now(`Done: ${orders.length - failed} of ${orders.length} orders, saved as ${name}` + (failed ? ` (${failed} failed, listed below and in index.csv)` : ""));
    } catch (err) {
      // Whatever was already read is still worth having.
      const partial = () => {
        const got = results.filter((r) => r?.got).length;
        if (!got) return "";
        const name = save(results.filter(Boolean), mode === "ids"
          ? `amazon-invoices_partial_${today()}.zip`
          : `amazon-invoices_${from}_to_${to}_partial.zip`);
        return ` Saved the ${got} of ${orders.length} orders read so far as ${name}.`;
      };
      const cancelled = signal.aborted;
      job.abort();   // stops the requests still in flight
      if (cancelled) now("Cancelled." + partial());
      else { log(err.message, "bad"); now(err.message + partial()); }
      if (err instanceof NotSignedIn) {
        const a = $(".signin");
        a.href = `${origin}/your-orders/orders`;
        a.hidden = false;
      }
    } finally {
      job = null;
      busy(false);
    }
  }

  // Zips the results (with an index of what's in it), saves the zip, and returns its name.
  function save(results, name) {
    const files = [], rows = [["order_date", "order_id", "invoice", "files"]];
    for (const { order, got, error } of results) {
      if (error) { rows.push([order.date, order.id, `failed: ${error.message}`, ""]); continue; }
      files.push(...got.files);
      rows.push([got.date, order.id, KINDS[got.kind], got.files.map((x) => x.name).join(" ")]);
    }
    files.push({ name: "index.csv", data: rows.map((r) => r.map(csvCell).join(",")).join("\n") + "\n" });
    zipUrl = URL.createObjectURL(new Blob([makeZip(files)], { type: "application/zip" }));
    const a = $(".save");
    a.href = zipUrl;
    a.download = name;
    a.hidden = false;
    a.click();
    return name;
  }

  return { toggle: () => toggle() };
}
