import fs from "node:fs/promises";
import http from "node:http";
import { spawn } from "node:child_process";

const CHROME_HOST = "127.0.0.1";
const CHROME_PORT = Number.parseInt(process.env.CHROME_DEBUG_PORT || "9222", 10);
const CHROME_EXECUTABLE = process.env.CHROME_EXECUTABLE || "/usr/bin/chromium";
const PROFILE_DIR = process.env.CHROME_PROFILE_DIR || "/tmp/shopee-cdp-profile";
const START_TIMEOUT_MS = Number.parseInt(process.env.CHROME_START_TIMEOUT_MS || "30000", 10);

let chromeProcess = null;
let startingPromise = null;
let lastExit = null;

function chromeArgs() {
  // Keep this list aligned with Playwright 1.63 Chromium defaults.
  // connect_over_cdp() is lower fidelity than the Playwright protocol and
  // Playwright explicitly warns that custom launch arguments may break
  // functionality. The previous RAM-oriented flags (renderer-process-limit,
  // tiny V8 heap, disabled software rasterizer/images) produced a Shopee SPA
  // shell with scripts present but an empty body.
  const disabledFeatures = [
    "AcceptCHFrame",
    "AvoidUnnecessaryBeforeUnloadCheckSync",
    "DestroyProfileOnBrowserClose",
    "DialMediaRouteProvider",
    "GlobalMediaControls",
    "HttpsUpgrades",
    "LensOverlay",
    "MediaRouter",
    "PaintHolding",
    "ThirdPartyStoragePartitioning",
    "Translate",
    "AutoDeElevate",
    "RenderDocument",
    "OptimizationHints",
  ].join(",");

  return [
    "--disable-field-trial-config",
    "--disable-background-networking",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-back-forward-cache",
    "--disable-breakpad",
    "--disable-client-side-phishing-detection",
    "--disable-component-extensions-with-background-pages",
    "--disable-component-update",
    "--no-default-browser-check",
    "--disable-default-apps",
    "--disable-dev-shm-usage",
    "--disable-extensions",
    `--disable-features=${disabledFeatures}`,
    "--enable-features=CDPScreenshotNewSurface",
    "--allow-pre-commit-input",
    "--disable-hang-monitor",
    "--disable-ipc-flooding-protection",
    "--disable-popup-blocking",
    "--disable-prompt-on-repost",
    "--disable-renderer-backgrounding",
    "--force-color-profile=srgb",
    "--metrics-recording-only",
    "--no-first-run",
    "--password-store=basic",
    "--use-mock-keychain",
    "--no-service-autorun",
    "--export-tagged-pdf",
    "--disable-search-engine-choice-screen",
    "--unsafely-disable-devtools-self-xss-warnings",
    "--edge-skip-compat-layer-relaunch",
    "--enable-automation",
    "--disable-infobars",
    "--disable-sync",
    "--headless",
    "--hide-scrollbars",
    "--mute-audio",
    "--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4",
    "--no-sandbox",
    `--remote-debugging-address=${CHROME_HOST}`,
    `--remote-debugging-port=${CHROME_PORT}`,
    `--user-data-dir=${PROFILE_DIR}`,
    "--no-startup-window",
  ];
}

export function chromiumLaunchArgsForTest() {
  return chromeArgs();
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
