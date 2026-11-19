// Usage: node scripts/benchmark-nvidia.cjs <helper.exe> <1080p24 clip.mp4>
// Requires Playwright and Google Chrome. All page requests use a local fixture.
const {chromium} = require("playwright");
const {spawn} = require("node:child_process");
const {once} = require("node:events");
const {access} = require("node:fs/promises");
const path = require("node:path");

async function measure(page, helper, mode, multiplier) {
  const baseline = mode === "Transport";
  const child = spawn(helper, baseline ? ["--transport-baseline"] : [], {windowsHide: true});
  try {
    let announcement = Buffer.alloc(0);
    for await (const chunk of child.stdout.iterator({destroyOnReturn: false})) {
      announcement = Buffer.concat([announcement, chunk]);
      if (announcement.length >= 4 && announcement.length >= 4 + announcement.readUInt32LE()) break;
    }
    const session = JSON.parse(announcement.subarray(4).toString());
    if (session.error) throw new Error(session.error);
    return await page.evaluate(async ({session, mode, multiplier}) => {
      const video = document.querySelector("video");
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const capture = canvas.getContext("2d", {willReadFrequently: true, alpha: false});
      const socket = new WebSocket("ws://127.0.0.1:" + session.port);
      socket.binaryType = "arraybuffer";
      function nextEvent(target, name, timeout = 15000) {
        return new Promise((resolve, reject) => {
          const controller = new AbortController();
          const options = {once: true, signal: controller.signal};
          const timer = setTimeout(() => finish(reject, new Error(name + " timed out")), timeout);
          function finish(callback, value) {
            clearTimeout(timer);
            controller.abort();
            callback(value);
          }
          target.addEventListener(name, event => finish(resolve, event), options);
          target.addEventListener("error", () => finish(reject, new Error(name + " failed")), options);
          target.addEventListener("close", () => finish(reject, new Error("Connection closed")), options);
        });
      }
      const rtt = [], grabs = [];
      try {
        await nextEvent(socket, "open");
        const ready = nextEvent(socket, "message");
        socket.send(session.token + (mode === "NvOFFRUC" ? ":fruc" : ""));
        const greeting = (await ready).data;
        if (greeting !== "ready") throw new Error(String(greeting));
        for (let i = 0; i < 66; i++) {
          const sought = nextEvent(video, "seeked");
          video.currentTime = (i + 5) / 24;
          await sought;
          const start = performance.now();
          capture.drawImage(video, 0, 0);
          const {width, height} = canvas;
          const rgba = capture.getImageData(0, 0, width, height).data;
          const factor = i ? multiplier : 1;
          const header = Uint8Array.of(width & 255, width >> 8, height & 255, height >> 8, factor);
          const received = nextEvent(socket, "message");
          const sent = performance.now();
          socket.send(new Blob([header, rgba]));
          const data = (await received).data;
          if (typeof data === "string") throw new Error(data);
          if (data.byteLength !== rgba.byteLength * (factor - 1)) throw new Error("Wrong reply size");
          if (i >= 6) {
            rtt.push(performance.now() - sent);
            grabs.push(sent - start);
          }
        }
      } finally {
        socket.close();
      }
      function percentiles(values) {
        values.sort((a, b) => a - b);
        return [0.5, 0.95].map(p => Number(values[Math.ceil(values.length * p) - 1].toFixed(1)));
      }
      return {mode, multiplier, samples: rtt.length, rttMs: percentiles(rtt), captureMs: percentiles(grabs)};
    }, {session, mode, multiplier});
  } finally {
    child.stdin.end();
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
  }
}

async function main() {
  const [helper, clip] = process.argv.slice(2).map(arg => path.resolve(arg));
  if (!helper || !clip) throw new Error("Supply the helper executable and a 1080p24 MP4 at least 3 seconds long");
  await Promise.all([access(helper), access(clip)]);
  const browser = await chromium.launch({channel: "chrome"});
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const origin = "https://www.youtube.com";
    const cdp = await browser.newBrowserCDPSession();
    const {browserContextIds} = await cdp.send("Target.getBrowserContexts");
    await cdp.send("Browser.setPermission", {permission: {name: "loopback-network"},
      setting: "granted", origin, browserContextId: browserContextIds[0]});
    await page.route("**/*", route => route.request().url() === origin + "/clip"
      ? route.fulfill({path: clip, contentType: "video/mp4"})
      : route.fulfill({body: '<video muted preload="auto"></video>', contentType: "text/html"}));
    await page.goto(origin + "/watch");
    // A complete local Blob supports byte-range seeks between benchmark samples.
    await page.evaluate(async () => {
      document.querySelector("video").src = URL.createObjectURL(await (await fetch("/clip")).blob());
    });
    await page.waitForFunction(() => document.querySelector("video").readyState >= 2);
    const valid = await page.locator("video").evaluate(v => v.videoWidth === 1920 && v.videoHeight === 1080 && v.duration >= 3);
    if (!valid) throw new Error("Expected a 1920 × 1080 clip at least 3 seconds long");
    for (const [mode, multiplier] of [["Transport", 5], ["VFG", 5], ["Transport", 2], ["NvOFFRUC", 2]]) {
      console.log(await measure(page, helper, mode, multiplier));
    }
  } finally {
    await browser.close();
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
