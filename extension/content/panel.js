// Injected into an Amazon tab when you click the toolbar icon. It runs in the Amazon page itself (in the extension's
// own isolated world), so its requests to Amazon are same-site and carry your sign-in, whatever the browser's cookie
// settings. A second click toggles the dialog instead of opening another.
(async () => {
  if (globalThis.nerdledger) return globalThis.nerdledger.toggle();
  const { mount } = await import(chrome.runtime.getURL("ui/panel.js"));
  globalThis.nerdledger = mount();
})();
