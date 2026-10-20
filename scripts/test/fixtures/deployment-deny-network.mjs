import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";

function denyNetwork() {
  throw new Error("Deployment audit fixtures must not use the network");
}

// Preloaded before the real CLI or native storage imports; no credentials are inherited.
globalThis.fetch = denyNetwork;
http.request = denyNetwork;
http.get = denyNetwork;
https.request = denyNetwork;
https.get = denyNetwork;
net.Socket.prototype.connect = denyNetwork;
syncBuiltinESMExports();
