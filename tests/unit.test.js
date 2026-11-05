// Pure parts, in Node: the date reader, PDF link detection and the zip writer (checked with the system's unzip).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { parseDate, isPdfHref } from "../extension/lib/amazon.js";
import { makeZip, crc32 } from "../extension/lib/zip.js";

test("parseDate reads the date formats of the supported Amazon sites", () => {
  const cases = {
    "Order placed November 1, 2026 Total $12.99": "2026-11-01",
    "Order placed\n  March 15, 2025\n": "2025-03-15",
    "Order placed 1 November 2026": "2026-11-01",
    "Order placedNovember 1, 2026 then March 2, 2026": "2026-03-02",
    "Bestellung aufgegeben 3. März 2026": "2026-03-03",
    "Commande effectuée le 12 février 2026": "2026-02-12",
    "Pedido realizado 7 de noviembre de 2026": "2026-11-07",
    "Ordine effettuato il 9 dicembre 2025": "2025-12-09",
    "Order placed 4 Sept. 2026": "2026-09-04",
    "Total $12.99 nothing else": "",
  };
  for (const [text, want] of Object.entries(cases)) assert.equal(parseDate(text), want, text);
});

test("isPdfHref keeps invoice PDFs and drops the summary and help links", () => {
  assert.ok(isPdfHref("/documents/download/0b1c-uuid/invoice.pdf"));
  assert.ok(isPdfHref("https://www.amazon.de/documents/download/abc/invoice.pdf?x=1"));
  assert.ok(!isPdfHref("/gp/css/summary/print.html?orderID=112-1234567-1234567"));
  assert.ok(!isPdfHref("/gp/help/contact/invoice.pdf"));
  assert.ok(!isPdfHref("javascript:void(0)"));
});

test("crc32 matches the standard check value", () => {
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
});

test("makeZip writes a zip that unzip accepts, with names and contents intact", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zip-"));
  const bin = new Uint8Array(70000).map((_, i) => (i * 31) & 255);
  const zip = makeZip([
    { name: "2026-11-01_112-1234567-1234567.pdf", data: bin },
    { name: "index.csv", data: "a,b\n1,ü\n" },
  ]);
  fs.writeFileSync(path.join(dir, "t.zip"), zip);
  execFileSync("unzip", ["-tq", "t.zip"], { cwd: dir });
  execFileSync("unzip", ["-q", "t.zip", "-d", "out"], { cwd: dir });
  assert.deepEqual(new Uint8Array(fs.readFileSync(path.join(dir, "out/2026-11-01_112-1234567-1234567.pdf"))), bin);
  assert.equal(fs.readFileSync(path.join(dir, "out/index.csv"), "utf8"), "a,b\n1,ü\n");
  fs.rmSync(dir, { recursive: true });
});
