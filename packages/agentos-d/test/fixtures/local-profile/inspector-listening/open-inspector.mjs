// Helper for the inspector-listening fixture. Opens a bare TCP listener on
// 127.0.0.1:9229 so the trust aggregator's port probe reports the inspector
// as exposed. Not a real CDP endpoint — sufficient for the warning check.

import net from "node:net";

let server = null;

export function startInspectorStub() {
  return new Promise((resolve, reject) => {
    if (server !== null) {
      reject(new Error("inspector stub already running"));
      return;
    }
    const s = net.createServer();
    s.once("error", reject);
    s.listen(9229, "127.0.0.1", () => {
      server = s;
      resolve();
    });
  });
}

export function stopInspectorStub() {
  return new Promise((resolve) => {
    if (server === null) {
      resolve();
      return;
    }
    const s = server;
    server = null;
    s.close(() => resolve());
  });
}
