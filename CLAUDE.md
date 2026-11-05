# Nerdledger

A Manifest V3 browser extension (Arc, Chrome) that downloads the user's Amazon invoices, for a time frame or single
order numbers, as one zip. Plain JavaScript, no build step: `extension/` is loaded unpacked as it is. See README.md
for what it does and how the pieces fit.

## Rules

- Use the browser's existing Amazon sign-in only. Never ask for, type, or store the Amazon password.
- Keep it simple: no frameworks, no bundler, no runtime dependencies. Playwright is a dev dependency for tests only.
- Amazon requests must run inside the Amazon tab (content script), not from an extension page or the service worker:
  from there, SameSite=Lax sign-in cookies aren't sent and the user looks signed out (checked with Playwright).
- Be gentle with Amazon: at most `CONCURRENCY` (3) requests at a time, and back off on 429/5xx (`RETRY_MS`), both in
  `lib/amazon.js`. Don't raise it without a reason; Amazon publishes no limit. No timers between requests: hidden tabs
  throttle them, which would slow a run in a background tab to a crawl.
- English Amazon pages are the main case. Other languages are supported only by reading their dates; never default
  to them.
- Sister project for style and conventions: [Nerdfader](https://github.com/grumpitect/nerdfader) (same author, also an MV3
  extension).

- Bump `version` in `extension/manifest.json` with every change the user will load: the dialog shows it next to
  the title, and that's how they tell a reload took.

## Commands

- `npm test`: unit tests (Node) and end-to-end tests (Playwright Chromium, headless, real network blocked).
- `./release.sh [patch|minor|major|X.Y.Z]`: tests, version bump, commit, tag, push and a GitHub release with the
  zip. Only when the user asks for a release.
- `node tools/render-icons.mjs`: renders `extension/icons/` from `docs/nerdledger-icon.svg` (and simpler small
  versions in the script). Run it after changing the icon.
- `node tools/screenshot.mjs <folder> [--log]`: screenshots of the dialog, light and dark, to check the layout.

## Where Amazon's page structure comes from

The selectors and URLs in `lib/amazon.js` follow open-source projects that track Amazon's pages, mainly
alexdlaird/amazon-orders (`amazonorders/selectors.py`, `constants.py`) and
Xenolphthalein/order-history-exporter-for-amazon (`src/utils/invoiceUtils.ts`). When Amazon changes its pages,
check those first. The test fixtures in `tests/extension.test.js` are modeled on the same structure.
