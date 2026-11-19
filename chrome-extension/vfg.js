// Native Messaging establishes the session. Frame bytes stay on the loopback
// socket so they don't pass through Chrome's JSON messaging or the page.
function createNvidiaRenderer(canvas, signal, onFailure, getFrameLimit, useFruc) {
  return new Promise((resolve, reject) => {
    const name = useFruc ? "NVIDIA NvOFFRUC" : "NVIDIA VFG";
    const maxMultiplier = useFruc ? 2 : 8;
    const port = chrome.runtime.connect({name: "kittyplays-vfg"});
    const timeout = setTimeout(() => fail(new Error(name + " helper did not start")), 25000);
    const capture = document.createElement("canvas");
    const reader = capture.getContext("2d", {alpha: false, willReadFrequently: true});
    const output = canvas.getContext("2d", {alpha: false});
    let socket, ready = false, closed = false, lastSubmitted, displayed;
    const pending = [];
    let supportsStats, hostStats;
    const roundTrips = [];
    let capacity = 2, slow = 0, headroom = 0;
    let captureTotal = 0, captureCount = 0, busyDrops = 0, bypass;
    let generation = 0, queue = [], lastInput, cadence, playbackRate = 1;
    let recovery, resumeFrom, resumeStart, windowStart, windowInputs = 0, windowMisses = 0, windows = 0;
    let warmed = false;
    let previousRefresh, refreshInterval;
    const refreshSamples = [];

    function tick(now) {
      const interval = now - previousRefresh;
      if (interval >= 2 && interval <= 45) {
        refreshSamples.push(interval);
        if (refreshSamples.length === 15) {
          refreshSamples.sort((a, b) => a - b);
          refreshInterval = refreshSamples[7];
          refreshSamples.length = 0;
        }
      }
      previousRefresh = now;
    }

    function reset() {
      generation++;
      for (const frame of queue) frame.source?.close();
      queue = [];
      lastSubmitted = displayed = lastInput = cadence = undefined;
      capacity = 2;
      slow = headroom = 0;
      recovery = windowStart = undefined;
      resumeFrom = resumeStart = undefined;
      windowInputs = windowMisses = windows = 0;
      warmed = false;
      previousRefresh = refreshInterval = undefined;
      refreshSamples.length = 0;
      roundTrips.length = 0;
      captureTotal = captureCount = busyDrops = 0;
      bypass = undefined;
    }
    function dispose() {
      if (closed) return;
      closed = true;
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      port.disconnect();
      socket?.close();
      reset();
      pending.length = 0;
    }
    function fail(error) {
      if (closed) return;
      dispose();
      if (ready) onFailure(error);
      else reject(error);
    }
    function abort() {
      fail(new DOMException(name + " cancelled", "AbortError"));
    }
    signal.addEventListener("abort", abort, {once: true});
    if (signal.aborted) { abort(); return; }

    // At the minimum multiplier there is no cheaper native interpolation
    // step. Measure missed submissions over full windows, independently of
    // the HUD. Test recovery while the original video is still visible.
    function monitorHost(now, busy, limit) {
      if (!warmed || capacity !== 2) {
        windowStart = undefined;
        windowInputs = windowMisses = windows = 0;
        return;
      }
      windowStart ??= now;
      windowInputs++;
      if (busy) windowMisses++;
      if (now - windowStart < 1000) return;
      const fraction = windowMisses / windowInputs;
      windowInputs = windowMisses = 0;
      windowStart = now;
      if (recovery) {
        if (fraction <= 0.05) {
          if (++windows >= 2) {
            recovery = undefined;
            resumeFrom = lastInput;
            windows = 0;
          }
          return;
        }
      } else {
        windows = fraction >= 0.20 ? windows + 1 : 0;
        if (windows < 2) return;
      }
      const wait = Math.min(120000, recovery ? recovery.wait * 2 : 15000);
      const interval = cadence;
      reset();
      bypass = "";
      recovery = {retryAt: now + wait, wait, limit, interval};
    }

    function upload(video, time, sourceFps) {
      if (closed || !ready) return;
      playbackRate = video.playbackRate;
      const width = video.videoWidth, height = video.videoHeight;
      const limit = getFrameLimit();
      let reason = "";
      if (width < 2 || height < 2 || width > 1920 || height > 1080 || width % 2 || height % 2) {
        reason = "Исходное разрешение вне диапазона NVIDIA";
      } else if (limit && sourceFps && sourceFps * playbackRate >= limit / 1.01) {
        reason = "Достигнут лимит FPS";
      }
      if (reason !== bypass) {
        reset();
        bypass = reason;
      }
      if (bypass) return;
      if (canvas.width !== width || canvas.height !== height || capture.width !== width || capture.height !== height) {
        canvas.width = capture.width = width;
        canvas.height = capture.height = height;
        reset();
        bypass = "";
      }
      const began = performance.now();
      if (pending.length && began - pending[0].sent > 5000) {
        fail(new Error(name + " frame timed out"));
        return;
      }
      if (recovery && (limit !== recovery.limit || (sourceFps && Math.abs(1 / sourceFps - recovery.interval) > recovery.interval * 0.2))) {
        reset();
        bypass = "";
      }
      if (recovery && began < recovery.retryAt) return;
      const priorInput = lastInput;
      const interval = time - priorInput;
      if (interval > 0 && interval < 0.15) {
        cadence = cadence === undefined ? interval : cadence * 0.85 + interval * 0.15;
      }
      lastInput = time;
      if (sourceFps > 0) cadence = 1 / sourceFps;
      // Originals keep their place on the presentation timeline even when
      // the host is late. Only the optional intermediate frames may be lost.
      const busy = pending.length >= 2;
      monitorHost(began, busy, limit);
      if (recovery && began < recovery.retryAt) return;
      const frame = {time};
      if (busy && typeof VideoFrame === "function") frame.source = new VideoFrame(video);
      else {
        reader.drawImage(video, 0, 0, width, height);
        frame.image = reader.getImageData(0, 0, width, height);
      }
      queue.push(frame);
      const oldestTime = time - Math.max(0.19, 4 * (cadence || 0));
      while (queue.length > 1 && (queue[1].time < oldestTime || queue.length > 64)) queue.shift().source?.close();
      const sent = performance.now();
      captureTotal += sent - began;
      captureCount++;
      if (busy) {
        busyDrops++;
        return;
      }
      const contiguous = lastSubmitted && lastSubmitted.time === priorInput && interval > 0 && interval < (cadence || 0.034) * 1.65;
      const target = limit || 1000 / (refreshInterval || 1000 / 60);
      const requested = Math.max(1, Math.min(maxMultiplier, Math.ceil(target * (cadence || 1 / 30) / playbackRate - 0.06)));
      const multiplier = contiguous ? Math.min(capacity, requested) : 1;
      pending.push({frame, from: lastSubmitted?.time, generation, multiplier, requested, sent, began});
      lastSubmitted = frame;
      const header = Uint8Array.of(width & 255, width >> 8, height & 255, height >> 8, multiplier);
      socket.send(new Blob([header, frame.image.data]));
    }
    function drawAt(time) {
      if (recovery || !queue.length || time - queue.at(-1).time > 0.1) return null;
      // Hand off from live video without replaying the buffered originals.
      // Build the normal presentation delay gradually as playback continues.
      if (resumeFrom !== undefined) {
        resumeStart ??= time;
        const handoff = resumeFrom + 0.9 * (time - resumeStart);
        if (handoff > time) time = handoff;
        else resumeFrom = resumeStart = undefined;
      }
      const next = queue.findIndex(frame => frame.time > time);
      if (next === 0) return null;
      const frame = queue[next < 0 ? queue.length - 1 : next - 1];
      if (displayed && frame.time <= displayed.time) return false;
      displayed = frame;
      if (frame.source) output.drawImage(frame.source, 0, 0, canvas.width, canvas.height);
      else output.putImageData(frame.image, 0, 0);
      return true;
    }
    function resources(elapsed, visible) {
      const timings = visible ? roundTrips.sort((a, b) => a - b) : [];
      const medianMs = timings[Math.floor(timings.length / 2)];
      const p95Ms = timings[Math.ceil(timings.length * 0.95) - 1];
      const captureMs = captureCount ? captureTotal / captureCount : null;
      const dropped = busyDrops;
      roundTrips.length = 0;
      captureTotal = captureCount = busyDrops = 0;
      if (!visible) {
        hostStats = undefined;
        return;
      }
      if (elapsed > 0 && supportsStats && socket?.readyState === WebSocket.OPEN) socket.send("stats");
      const buffers = new Set();
      for (const frame of [...queue, ...pending.map(job => job.frame), lastSubmitted, displayed]) {
        if (frame?.image) buffers.add(frame.image.data.buffer);
      }
      let ramBytes = 0;
      for (const buffer of buffers) ramBytes += buffer.byteLength;
      return {frameBuffers: true, bytes: hostStats?.gpuBytes, hostCpu: hostStats?.cpu, ramBytes,
        medianMs, p95Ms, captureMs, dropped, resolution: displayed && [canvas.width, canvas.height],
        passthrough: Boolean(bypass || recovery), bypassReason: recovery
          ? (performance.now() < recovery.retryAt ? "Хост не успевает" : "Проверка скорости хоста") : bypass};
    }
    function receive({data}) {
      if (!ready) {
        if (data !== "ready") {
          fail(new Error(typeof data === "string" ? data : name + " authentication failed"));
          return;
        }
        ready = true;
        clearTimeout(timeout);
        resolve({
          upload, drawAt, reset, dispose, tick, resources,
          get delay() { return Math.max(0.075, Math.min(0.135, 3 * (cadence || 1 / 30) / playbackRate)); },
          get outputRate() { return cadence ? capacity * playbackRate / cadence : 0; },
        });
        return;
      }
      if (typeof data === "string") {
        if (supportsStats && data.startsWith("stats ")) {
          try { hostStats = JSON.parse(data.slice(6)); }
          catch { hostStats = undefined; }
        } else fail(new Error(data));
        return;
      }
      const job = pending.shift();
      if (!job || job.generation !== generation) return;
      const {frame, multiplier} = job;
      const {width, height} = frame.image;
      const frameBytes = width * height * 4;
      if (data.byteLength !== (multiplier - 1) * frameBytes) {
        fail(new Error(name + " returned unexpected frame data"));
        return;
      }
      const end = queue.indexOf(frame);
      const generated = [];
      for (let index = 1; end >= 0 && index < multiplier; index++) {
        const time = job.from + (frame.time - job.from) * index / multiplier;
        if (displayed && time <= displayed.time) continue;
        generated.push({
          time,
          image: new ImageData(new Uint8ClampedArray(data, (index - 1) * frameBytes, frameBytes), width, height),
        });
      }
      if (generated.length) queue.splice(end, 0, ...generated);
      const now = performance.now();
      roundTrips.push(now - job.sent);
      warmed = true;
      if (!cadence || multiplier !== capacity) return;
      const budget = 1000 * cadence / playbackRate;
      const elapsed = now - job.began;
      slow = elapsed > budget ? slow + 1 : Math.max(0, slow - 1);
      headroom = elapsed < 0.72 * budget ? headroom + 1 : 0;
      if (capacity > 2 && slow >= 3) {
        capacity--;
        slow = headroom = 0;
      } else if (!recovery && capacity < job.requested && headroom >= 24) {
        capacity++;
        slow = headroom = 0;
      }
    }
    port.onMessage.addListener(message => {
      if (closed) return;
      if (message.error) {
        const reason = message.error.includes("not found") ? "Install the local KittyPlays NVIDIA helper" : message.error;
        fail(new Error(reason));
        return;
      }
      if (message.version !== 2 || (useFruc && message.supportsFruc !== true)) {
        fail(new Error("Update the KittyPlays NVIDIA helper using setup-vfg.ps1"));
        return;
      }
      if (socket || !Number.isInteger(message.port) || message.port < 1 || message.port > 65535 ||
          !/^[a-f0-9]{64}$/.test(message.token)) {
        fail(new Error("Invalid KittyPlays NVIDIA helper response"));
        return;
      }
      socket = new WebSocket("ws://127.0.0.1:" + message.port);
      supportsStats = message.supportsStats === true;
      socket.binaryType = "arraybuffer";
      socket.onopen = () => socket.send(useFruc ? message.token + ":fruc" : message.token);
      socket.onmessage = receive;
      socket.onerror = () => fail(new Error("Cannot reach the KittyPlays NVIDIA helper. Check loopback access in Chrome."));
      socket.onclose = () => fail(new Error(name + " connection closed"));
    });
    port.onDisconnect.addListener(() => fail(new Error(chrome.runtime.lastError?.message || "KittyPlays NVIDIA helper disconnected")));
  });
}
