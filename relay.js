// Isolated-world content script: relays WebSocket frames captured by
// inject.js (MAIN world) to the extension side panel.
window.addEventListener("message", (ev) => {
  if (ev.source !== window || !ev.data || !ev.data.__sleeperDraftAssistant) return;
  try {
    chrome.runtime
      .sendMessage({ type: "sleeper-ws", data: ev.data.data })
      .catch(() => {}); // side panel not open — fine, polling covers it
  } catch (e) {
    /* extension reloaded / context invalidated */
  }
});
