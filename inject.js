// Runs in the page's MAIN world at document_start, before Sleeper's own JS.
// Wraps WebSocket so we can observe the draft room's live feed and mirror
// pick events to the extension (via window.postMessage -> relay.js).
// Observation only — never sends or modifies anything on the socket.
(() => {
  const NativeWS = window.WebSocket;
  window.WebSocket = new Proxy(NativeWS, {
    construct(target, args) {
      const ws = new target(...args);
      ws.addEventListener("message", (ev) => {
        try {
          if (typeof ev.data !== "string") return;
          // Cheap prefilter: only forward frames that could contain a pick
          if (!ev.data.includes("pick") && !ev.data.includes("first_name")) return;
          window.postMessage({ __sleeperDraftAssistant: true, data: ev.data }, "*");
        } catch (e) {
          /* never interfere with the page */
        }
      });
      return ws;
    },
  });
})();
