// Renders Nerdledger's toolbar and store icons (extension/icons/icon-<size>.png) from docs/nerdledger-icon.svg, with
// simpler drawings for the small sizes, where the full one would blur or thin out. Headless Chromium, nothing shown.
// Run by hand after changing the icon: node tools/render-icons.mjs
import fs from "node:fs";
import { chromium } from "playwright";
const root = new URL("..", import.meta.url).pathname;
const full = fs.readFileSync(root + "docs/nerdledger-icon.svg", "utf8");
// At 16 px: no edge or grid, 1 px ink, two text lines and the red total, on whole pixels.
const small = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">
  <rect width="16" height="16" rx="3.5" fill="#f8f7f2"/>
  <path d="M3.5 1.5H12.5V14.5L11 13.5L9.5 14.5L8 13.5L6.5 14.5L5 13.5L3.5 14.5Z" fill="#fff" stroke="#15171b"/>
  <path d="M5 4.5H9M5 6.5H10" stroke="#15171b"/>
  <path d="M5 9.5H11M5 11.5H11" stroke="#c21f35"/>
</svg>`;
// At 32 and 48 px (32 is what a retina toolbar shows): the same drawing in heavier lines, one text line fewer, no grid.
const medium = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
  <rect x="3" y="3" width="122" height="122" rx="25" fill="#f8f7f2" stroke="#15171b" stroke-width="6"/>
  <path d="M30 14H98V110L88 102L78 110L68 102L58 110L48 102L38 110L30 104Z" fill="#fff" stroke="#15171b"
        stroke-width="8" stroke-linejoin="round"/>
  <path d="M44 36H74M44 54H82" stroke="#15171b" stroke-width="9"/>
  <path d="M44 74H84M44 88H84" stroke="#c21f35" stroke-width="8"/>
</svg>`;
const browser = await chromium.launch();
const page = await browser.newPage();
const icons = [[16, small], [32, medium], [48, medium], [128, full]];
fs.mkdirSync(root + "extension/icons", { recursive: true });
for (const [size, svg] of icons) {
  await page.setViewportSize({ width: size, height: size });
  const src = "data:image/svg+xml;base64," + Buffer.from(svg).toString("base64");
  await page.setContent(`<body style="margin:0"><img src="${src}" width="${size}" height="${size}" style="display:block">`);
  await page.waitForFunction(() => document.images[0].complete);
  await page.screenshot({ path: root + `extension/icons/icon-${size}.png`, omitBackground: true });
}
await browser.close();
