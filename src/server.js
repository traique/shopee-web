import http from "node:http";
import process from "node:process";
import { WebSocket, WebSocketServer } from "ws";

import { tokenFromPath, tokenMatches } from "./auth.js";
import { chromiumStatus, ensureChromiumReady, stopChromium } from "./chromium.js";
import { memorySnapshot } from "./memory.js";

const PORT = Number.parseInt(process.env.PORT || "10000", 10);
const HOST = "0.0.0.0";
const CDP_TOKEN = (process.env.CDP_TOKEN || "").trim();
const MAX_TOKEN_LENGTH = 256;

if (CDP_TOKEN.length < 32 || CDP_TOKEN.length > MAX_TOKEN_LENGTH) {
  console.error("CDP_TOKEN is required and must be between 32 and 256 characters.");
  process.exit(1);
}

let activeClient = false;

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || "/", "http://localhost");
  if (request.method === "GET" && url.pathname === "/healthz") {
    sendJson(response, 200, {
      ok: true,
      chromium: chromiumStatus(),
      memory: await memorySnapshot(),
      activeClient,
    });
    return;
  }
  sendJson(response, 404, { error: "not_found" });
});

const wss = new WebSocketServer({
  noServer: true,
  perMessageDeflate: false,
  maxPayload: 100 * 1024 * 1024,
});

function rejectUpgrade(socket, statusCode, statusText) {
  if (!socket.writable) {
    return;
  }
  socket.write(`HTTP/1.1 ${statusCode} ${statusText}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

function bridge(external, internal) {
  const closeOther = (socket, code = 1000, reason = "") => {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      try {
        socket.close(code, reason);
      } catch {
        socket.terminate();
      }
    }
  };

  external.on("message", (data, isBinary) => {
    if (internal.readyState === WebSocket.OPEN) {
      internal.send(data, { binary: isBinary });
    }
  });
  internal.on("message", (data, isBinary) => {
    if (external.readyState === WebSocket.OPEN) {
      external.send(data, { binary: isBinary });
    }
  });

  external.on("close", (code, reason) => closeOther(internal, code, reason.toString()));
  internal.on("close", (code, reason) => closeOther(external, code, reason.toString()));
  external.on("error", () => internal.terminate());
  internal.on("error", () => external.terminate());
}

server.on("upgrade", async (request, socket, head) => {
  const url = new URL(request.url || "/", "http://localhost");
  const suppliedToken = tokenFromPath(url.pathname);
  if (!tokenMatches(CDP_TOKEN, suppliedToken)) {
    rejectUpgrade(socket, 404, "Not Found");
    return;
  }
  if (activeClient) {
    rejectUpgrade(socket, 429, "Too Many Requests");
    return;
  }

  activeClient = true;
  let internal = null;
  try {
    const chromeWsUrl = await ensureChromiumReady();
    internal = new WebSocket(chromeWsUrl, {
      perMessageDeflate: false,
      maxPayload: 100 * 1024 * 1024,
      handshakeTimeout: 10000,
    });
    await new Promise((resolve, reject) => {
      internal.once("open", resolve);
      internal.once("error", reject);
    });

    wss.handleUpgrade(request, socket, head, (external) => {
      const started = Date.now();
      console.log("[cdp] client connected");
      bridge(external, internal);
      external.once("close", async () => {
        activeClient = false;
        const memory = await memorySnapshot();
        console.log(
          `[cdp] client disconnected after ${Math.round((Date.now() - started) / 1000)}s; `
          + `memory=${memory.usageMb ?? "?"}/${memory.limitMb ?? "?"}MB`,
        );
      });
    });
  } catch (error) {
    activeClient = false;
    internal?.terminate();
    console.error(`[cdp] connection setup failed: ${error.message}`);
    rejectUpgrade(socket, 503, "Service Unavailable");
  }
});

async function shutdown(signal) {
  console.log(`[server] received ${signal}; shutting down`);
  server.close();
  wss.close();
  await stopChromium();
  process.exit(0);
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

server.listen(PORT, HOST, () => {
  console.log(`[server] listening on ${HOST}:${PORT}`);
  console.log("[server] Chromium starts lazily on the first authenticated CDP connection");
});
