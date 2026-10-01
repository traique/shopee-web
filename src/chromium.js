import fs from "node:fs/promises";
import http from "node:http";
import { spawn } from "node:child_process";

const CHROME_HOST = "127.0.0.1";
const CHROME_PORT = Number.parseInt(process.env.CHROME_DEBUG_PORT || "9222", 10);
const CHROME_EXECUTABLE = process.env.CHROME_EXECUTABLE || "/usr/bin/chromium";
const PROFILE_DIR = process.env.CHROME_PROFILE_DIR || "/tmp/shopee-cdp-profile";
const START_TIMEOUT_MS = Number.parseInt(process.env.CHROME_START_TIMEOUT_MS || "30000", 10);
const JS_HEAP_MB = Number.parseInt(process.env.CHROME_JS_HEAP_MB || "192", 10);

let chromeProcess = null;
let startingPromise = null;
let lastExit = null;

function chromeArgs() {
  return [
    "--headless=new",
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-sync",
    "--metrics-recording-only",
    "--mute-audio",
    "--no-first-run",
    "--disable-default-apps",
    "--disable-software-rasterizer",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--blink-settings=imagesEnabled=false",
    "--disable-features=Translate,BackForwardCache,AcceptCHFrame,MediaRouter,OptimizationHints",
    "--renderer-process-limit=1",
    `--js-flags=--max-old-space-size=${JS_HEAP_MB}`,
    `--remote-debugging-address=${CHROME_HOST}`,
    `--remote-debugging-port=${CHROME_PORT}`,
    `--user-data-dir=${PROFILE_DIR}`,
    "about:blank"
  ];
}

function getJson(pathname, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const request = http.get(
      {
        hostname: CHROME_HOST,
        port: CHROME_PORT,
        path: pathname,
        timeout: timeoutMs,
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          if (response.statusCode !== 200) {
            reject(new Error(`Chromium DevTools returned HTTP ${response.statusCode}`));
            return;
          }
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch (error) {
            reject(new Error(`Invalid Chromium DevTools JSON: ${error.message}`));
          }
        });
      },
    );
    request.on("timeout", () => request.destroy(new Error("Chromium DevTools timeout")));
    request.on("error", reject);
  });
}

async function waitUntilReady() {
  const deadline = Date.now() + START_TIMEOUT_MS;
  let lastError = null;
  while (Date.now() < deadline) {
    if (!chromeProcess || chromeProcess.exitCode !== null) {
      throw new Error(`Chromium exited before DevTools became ready${lastExit ? ` (${lastExit})` : ""}`);
    }
    try {
      const version = await getJson("/json/version");
      if (version.webSocketDebuggerUrl) {
        return version.webSocketDebuggerUrl;
      }
      lastError = new Error("Chromium DevTools did not return webSocketDebuggerUrl");
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Chromium did not become ready within ${START_TIMEOUT_MS}ms: ${lastError?.message || "unknown error"}`);
}

async function launchChromium() {
  await fs.rm(PROFILE_DIR, { recursive: true, force: true });
  chromeProcess = spawn(CHROME_EXECUTABLE, chromeArgs(), {
    stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, HOME: "/tmp" },
  });
  lastExit = null;
  let stderrTail = "";
  chromeProcess.stderr.setEncoding("utf8");
  chromeProcess.stderr.on("data", (chunk) => {
    stderrTail = (stderrTail + chunk).slice(-4000);
  });
  chromeProcess.once("exit", (code, signal) => {
    lastExit = `code=${code ?? "null"}, signal=${signal ?? "null"}`;
    chromeProcess = null;
    if (code && stderrTail) {
      console.error(`[chromium] exited ${lastExit}: ${stderrTail.replace(/\s+/g, " ").trim()}`);
    } else {
      console.log(`[chromium] exited ${lastExit}`);
    }
  });
  chromeProcess.once("error", (error) => {
    console.error(`[chromium] spawn failed: ${error.message}`);
  });

  const wsUrl = await waitUntilReady();
  console.log(`[chromium] ready pid=${chromeProcess?.pid ?? "?"}`);
  return wsUrl;
}

export async function ensureChromiumReady() {
  if (chromeProcess && chromeProcess.exitCode === null) {
    try {
      const version = await getJson("/json/version");
      if (version.webSocketDebuggerUrl) {
        return version.webSocketDebuggerUrl;
      }
    } catch {
      // Fall through and restart the process if DevTools stopped responding.
    }
  }

  if (!startingPromise) {
    startingPromise = launchChromium().finally(() => {
      startingPromise = null;
    });
  }
  return startingPromise;
}


export async function chromiumVersion() {
  await ensureChromiumReady();
  return getJson("/json/version");
}

export function chromiumStatus() {
  return {
    running: Boolean(chromeProcess && chromeProcess.exitCode === null),
    pid: chromeProcess?.pid ?? null,
    lastExit,
  };
}

export async function stopChromium() {
  const processToStop = chromeProcess;
  if (!processToStop || processToStop.exitCode !== null) {
    return;
  }
  processToStop.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => processToStop.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 5000)),
  ]);
  if (processToStop.exitCode === null) {
    processToStop.kill("SIGKILL");
  }
}
