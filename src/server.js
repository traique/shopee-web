import http from "node:http";
import process from "node:process";
import { WebSocket, WebSocketServer } from "ws";

import { tokenFromPath, tokenFromVersionPath, tokenMatches } from "./auth.js";
import { chromiumStatus, chromiumVersion, ensureChromiumReady, stopChromium } from "./chromium.js";
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
let activeConnection = null;
let idleTimer = null;
const IDLE_MS = Math.max(5000, Number.parseInt(process.env.CHROME_IDLE_TIMEOUT_MS || "30000", 10) || 30000);
const MAX_CDP_BYTES = 16 * 1024 * 1024;
function cancelIdleStop() { clearTimeout(idleTimer); idleTimer = null; }
function scheduleIdleStop() {
  cancelIdleStop();
  idleTimer = setTimeout(() => {
    if (!activeClient) void stopChromium().catch(error => console.error(`[chromium] idle stop failed: ${error.message}`));
  }, IDLE_MS);
  idleTimer.unref();
}
function releaseClient(connection) {
  if (activeConnection !== connection) return;
  activeConnection = null;
  activeClient = false;
  scheduleIdleStop();
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

function publicCdpWebSocketUrl(request) {
  const forwardedProto = String(request.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const forwardedHost = String(request.headers["x-forwarded-host"] || "").split(",")[0].trim();
  const host = forwardedHost || String(request.headers.host || "").trim();
  if (!host || /[\s/]/.test(host)) {
    throw new Error("Invalid public host header");
  }
  const scheme = forwardedProto === "https" ? "wss" : "ws";
  return `${scheme}://${host}/cdp/${encodeURIComponent(CDP_TOKEN)}`;
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

  if (request.method === "GET") {
    const suppliedToken = tokenFromVersionPath(url.pathname);
    if (suppliedToken) {
      if (!tokenMatches(CDP_TOKEN, suppliedToken)) {
        sendJson(response, 404, { error: "not_found" });
        return;
      }
      if (activeClient) {
        sendJson(response, 429, { error: "browser_busy" });
        return;
      }
      try {
        cancelIdleStop();
        const version = await chromiumVersion();
        scheduleIdleStop();
        sendJson(response, 200, {
          ...version,
          webSocketDebuggerUrl: publicCdpWebSocketUrl(request),
        });
      } catch (error) {
        console.error(`[cdp] discovery failed: ${error.message}`);
        sendJson(response, 503, { error: "browser_unavailable" });
      }
      return;
    }
  }

  sendJson(response, 404, { error: "not_found" });
});

const wss = new WebSocketServer({
  noServer: true,
  perMessageDeflate: false,
  maxPayload: MAX_CDP_BYTES,
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
      if (internal.bufferedAmount + data.length > MAX_CDP_BYTES) { external.terminate(); internal.terminate(); return; }
      internal.send(data, { binary: isBinary });
    }
  });
  internal.on("message", (data, isBinary) => {
    if (external.readyState === WebSocket.OPEN) {
      if (external.bufferedAmount + data.length > MAX_CDP_BYTES) { external.terminate(); internal.terminate(); return; }
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
  const connection = {};
  activeConnection = connection;
  cancelIdleStop();
  let internal = null;
  const disconnectedDuringSetup = () => {
    releaseClient(connection);
    internal?.terminate();
    socket.destroy();
  };
  socket.once("close", disconnectedDuringSetup);
  socket.once("end", disconnectedDuringSetup);
  socket.once("error", disconnectedDuringSetup);
  // Upgrade sockets are paused by HTTP; read FIN while Chromium is starting.
  socket.resume();
  try {
    const chromeWsUrl = await ensureChromiumReady();
    if (socket.destroyed || activeConnection !== connection) return;
    internal = new WebSocket(chromeWsUrl, {
      perMessageDeflate: false,
      maxPayload: MAX_CDP_BYTES,
      handshakeTimeout: 10000,
    });
    await new Promise((resolve, reject) => {
      internal.once("open", resolve);
      internal.once("error", reject);
    });

    wss.handleUpgrade(request, socket, head, (external) => {
      socket.off("close", disconnectedDuringSetup);
      socket.off("end", disconnectedDuringSetup);
      socket.off("error", disconnectedDuringSetup);
      const started = Date.now();
      console.log("[cdp] client connected");
      bridge(external, internal);
      external.once("close", async () => {
        releaseClient(connection);
        const memory = await memorySnapshot();
        console.log(
          `[cdp] client disconnected after ${Math.round((Date.now() - started) / 1000)}s; `
          + `memory=${memory.usageMb ?? "?"}/${memory.limitMb ?? "?"}MB`,
        );
      });
    });
  } catch (error) {
    socket.off("close", disconnectedDuringSetup);
    socket.off("end", disconnectedDuringSetup);
    socket.off("error", disconnectedDuringSetup);
    releaseClient(connection);
    internal?.terminate();
    console.error(`[cdp] connection setup failed: ${error.message}`);
    rejectUpgrade(socket, 503, "Service Unavailable");
  }
});

async function shutdown(signal) {
  console.log(`[server] received ${signal}; shutting down`);
  cancelIdleStop();
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
