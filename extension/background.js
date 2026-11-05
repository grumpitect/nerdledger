// The toolbar icon shows the dialog on the Amazon tab you're on. From any other tab, it opens your orders on the
// Amazon site you used last (amazon.com the first time) and shows the dialog there once the page has loaded.
const SITES = chrome.runtime.getManifest().host_permissions.map((p) => new URL(p).origin);

const isAmazon = (url) => { try { return SITES.includes(new URL(url).origin); } catch { return false; } };

async function openPanel(tab) {
  if (!isAmazon(tab.url)) {
    const { site } = await chrome.storage.local.get("site");
    tab = await chrome.tabs.create({ url: `${SITES.includes(site) ? site : SITES[0]}/your-orders/orders`, index: tab.index + 1 });
    await new Promise((resolve) => {
      const done = (id, info) => {
        if (id === tab.id && info.status === "complete") { chrome.tabs.onUpdated.removeListener(done); resolve(); }
      };
      chrome.tabs.onUpdated.addListener(done);
    });
  }
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content/panel.js"] });
}

chrome.action.onClicked.addListener(openPanel);
globalThis.openPanel = openPanel;   // for the tests, which can't click the toolbar
