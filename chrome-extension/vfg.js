// Native Messaging establishes the session. Frame bytes stay on the loopback
// socket so they don't pass through Chrome's JSON messaging or the page.
function createVfgRenderer(canvas, signal, onFailure, getFrameLimit) {
  return new Promise((resolve, reject) => {
    const port = chrome.runtime.connect({name: "kittyplays-vfg"});
    const timeout = setTimeout(() => fail(new Error("NVIDIA VFG helper did not start")), 25000);
    const capture = document.createElement("canvas");
    const reader = capture.getContext("2d", {alpha: false, willReadFrequently: true});
    const output = canvas.getContext("2d", {alpha: false});
    let socket, ready = false, closed = false, pending, previous, displayed;
    let generation = 0, queue = [], lastInput, cadence;
    let pixelScale = 1, slowFrames = 0, samples = 0;
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
      queue = [];
      previous = displayed = lastInput = cadence = undefined;
      previousRefresh = refreshInterval = undefined;
      refreshSamples.length = 0;
    }
    function dispose() {
      if (closed) return;
      closed = true;
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      port.disconnect();
      socket?.close();
      reset();
      pending = undefined;
    }
    function fail(error) {
      if (closed) return;
      dispose();
      if (ready) onFailure(error);
      else reject(error);
    }
    function abort() {
      fail(new DOMException("NVIDIA VFG cancelled", "AbortError"));
    }
    signal.addEventListener("abort", abort, {once: true});
    if (signal.aborted) { abort(); return; }

    function upload(video, time) {
      if (closed || !ready) return;
      const interval = time - lastInput;
      if (interval > 0 && interval < 0.15) {
        cadence = cadence === undefined ? interval : cadence * 0.85 + interval * 0.15;
      }
      lastInput = time;
      if (pending) {
        if (performance.now() - pending.sent > 5000) fail(new Error("NVIDIA VFG frame timed out"));
        return;
      }
      const scale = Math.min(1, 1920 / video.videoWidth, 1080 / video.videoHeight) * pixelScale;
      const width = Math.max(2, Math.floor(video.videoWidth * scale / 2) * 2);
      const height = Math.max(2, Math.floor(video.videoHeight * scale / 2) * 2);
      if (canvas.width !== width || canvas.height !== height || capture.width !== width || capture.height !== height) {
        canvas.width = capture.width = width;
        canvas.height = capture.height = height;
        reset();
      }
      const contiguous = previous && time > previous.time && time - previous.time < (cadence || 0.034) * 1.65;
      const target = getFrameLimit() || 1000 / (refreshInterval || 1000 / 60);
      const multiplier = contiguous ? Math.max(1, Math.min(8,
        Math.ceil(target * (cadence || 1 / 30) / video.playbackRate - 0.06))) : 1;
      reader.drawImage(video, 0, 0, width, height);
      const image = reader.getImageData(0, 0, width, height);
      pending = {image, time, generation, multiplier, sent: performance.now()};
      const header = Uint8Array.of(width & 255, width >> 8, height & 255, height >> 8, multiplier);
      socket.send(new Blob([header, image.data]));
    }
    function drawAt(time) {
      if (!queue.length || time - queue.at(-1).time > 0.1) return null;
      const next = queue.findIndex(frame => frame.time > time);
      if (next === 0) return null;
      const frame = queue[next < 0 ? queue.length - 1 : next - 1];
      if (frame === displayed) return false;
      displayed = frame;
      output.putImageData(frame.image, 0, 0);
      return true;
    }
    function receive({data}) {
      if (!ready) {
        if (data !== "ready") { fail(new Error("NVIDIA VFG authentication failed")); return; }
        ready = true;
        clearTimeout(timeout);
        resolve({upload, drawAt, reset, dispose, tick, delay: 0.075});
        return;
      }
      if (typeof data === "string") { fail(new Error(data)); return; }
      if (!pending) return;
      const frame = pending;
      pending = undefined;
      if (frame.generation !== generation) return;
      const {width, height} = frame.image;
      const frameBytes = width * height * 4;
      if (data.byteLength !== (frame.multiplier - 1) * frameBytes) {
        fail(new Error("NVIDIA VFG returned unexpected frame data"));
        return;
      }
      for (let index = 1; index < frame.multiplier; index++) {
        queue.push({
          time: previous.time + (frame.time - previous.time) * index / frame.multiplier,
          image: new ImageData(new Uint8ClampedArray(data, (index - 1) * frameBytes, frameBytes), width, height),
        });
      }
      queue.push(frame);
      while (queue.length > 1 && (queue[1].time < frame.time - 0.19 || queue.length > 64)) queue.shift();
      previous = frame;
      // Copies into Chrome and back can dominate inference time. Step down
      // when the transport repeatedly consumes most of a source interval.
      if (++samples > 4 && cadence) {
        const slow = performance.now() - frame.sent > cadence * 800;
        slowFrames = slow ? slowFrames + 1 : Math.max(0, slowFrames - 1);
        if (slowFrames >= 6 && height > 240 && pixelScale > 0.25) {
          pixelScale = Math.max(0.25, pixelScale * 0.75);
          slowFrames = samples = 0;
        }
      }
    }
    port.onMessage.addListener(message => {
      if (closed) return;
      if (message.error) {
        const reason = message.error.includes("not found") ? "Install the local KittyPlays NVIDIA VFG helper" : message.error;
        fail(new Error(reason));
        return;
      }
      if (message.version !== 2) {
        fail(new Error("Update the KittyPlays NVIDIA VFG helper using setup-vfg.ps1"));
        return;
      }
      if (socket || !Number.isInteger(message.port) || message.port < 1 || message.port > 65535 ||
          !/^[a-f0-9]{64}$/.test(message.token)) {
        fail(new Error("Invalid NVIDIA VFG helper response"));
        return;
      }
      socket = new WebSocket("ws://127.0.0.1:" + message.port);
      socket.binaryType = "arraybuffer";
      socket.onopen = () => socket.send(message.token);
      socket.onmessage = receive;
      socket.onerror = () => fail(new Error("Cannot reach NVIDIA VFG helper. Check loopback access in Chrome."));
      socket.onclose = () => fail(new Error("NVIDIA VFG connection closed"));
    });
    port.onDisconnect.addListener(() => fail(new Error(chrome.runtime.lastError?.message || "NVIDIA VFG helper disconnected")));
  });
}
