// Saves screenshots of the dialog over a stand-in Amazon page, light and dark, to the folder given (default docs/).
// With --log, the dialog shows a finished run with a long log, to check how that fits.
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EXT = fileURLToPath(new URL("../extension", import.meta.url));
const out = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? fileURLToPath(new URL("../docs", import.meta.url));
const withLog = process.argv.includes("--log");
fs.mkdirSync(out, { recursive: true });

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "nerdledger-shot-"));
const ctx = await chromium.launchPersistentContext(profile, {
  headless: true, channel: "chromium", viewport: { width: 1000, height: 760 },
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--host-resolver-rules=MAP * ~NOTFOUND"],
});
await ctx.route("https://www.amazon.com/**", (r) => r.fulfill({ contentType: "text/html", body: `
  <body style="margin:0;font:16px Arial"><div style="background:#131921;color:#fff;padding:14px 20px;font-weight:700">amazon</div>
  <div style="padding:24px"><h1>Your Orders</h1>${"<div style='border:1px solid #ddd;border-radius:8px;height:120px;margin:12px 0'></div>".repeat(4)}</div></body>` }));
const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker"));

for (const scheme of ["light", "dark"]) {
  const page = await ctx.newPage();
  await page.emulateMedia({ colorScheme: scheme });
  await page.goto("https://www.amazon.com/your-orders/orders");
  await sw.evaluate(async () => {
    const tabs = await chrome.tabs.query({ url: "https://www.amazon.com/*" });
    await globalThis.openPanel(tabs.sort((a, b) => b.id - a.id)[0]);
  });
  await page.locator("nerd-ledger .panel").waitFor();
  if (withLog) {
    await page.evaluate(() => {
      const r = document.querySelector("nerd-ledger").shadowRoot;
      r.querySelector(".status").hidden = false;
      r.querySelector(".now").textContent = "Step 2 of 2: invoices, 120 of 250 orders, about 2 min left";
      
      r.querySelector("progress").max = 250; r.querySelector("progress").value = 120;
      for (let i = 1; i <= 250; i++) {
        const li = document.createElement("li");
        li.className = "good";
        li.textContent = `702-${String(i).padStart(7, "0")}-0000000: PDF`;
        r.querySelector(".log").append(li);
      }
      r.querySelector(".log").lastElementChild.scrollIntoView({ block: "nearest" });
    });
  }
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(out, `dialog${withLog ? "-log" : ""}-${scheme}.png`) });
  await page.close();
}
await ctx.close();
fs.rmSync(profile, { recursive: true, force: true });
