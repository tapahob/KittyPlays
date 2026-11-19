function createFidelityFxRenderer(canvas, signal, onFailure, getFrameLimit) {
  return new Promise((resolve, reject) => {
    const port = chrome.runtime.connect({name: "kittyplays-fidelityfx"});
    const output = canvas.getContext("2d", {alpha: false});
    const capture = document.createElement("canvas");
    const pending = [], queue = [];
    // Width, height, reset, color flags, pixel format and frame duration precede the pixels.
    const packet = new Uint8Array(1920 * 1080 * 4 + 9);
    const header = new DataView(packet.buffer);
    const timeout = setTimeout(() => fail(new Error(
      socket ? "Allow loopback access for YouTube in Chrome, then select AMD FidelityFX again"
        : "FidelityFX helper did not start")), 25000);
    let socket, reader, ready = false, closed = false, copying = false, bypass = false;
    let displayed, lastTime, cadence, playbackRate = 1, generation = 0, totalLatency = 0, samples = 0;

    function reset() {
      generation++;
      lastTime = displayed = undefined;
      for (const frame of [...queue, ...pending]) frame.image.close();
      queue.length = 0;
    }
    function dispose() {
      if (closed) return;
      closed = true;
      clearTimeout(timeout);
      signal.removeEventListener("abort", dispose);
      port.disconnect();
      socket?.close();
      reset();
      pending.length = 0;
      if (!ready) reject(new DOMException("FidelityFX connection cancelled", "AbortError"));
    }
    function fail(error) {
      if (closed) return;
      if (!ready) reject(error);
      dispose();
      if (ready) onFailure(error);
    }
    signal.addEventListener("abort", dispose, {once: true});
    if (signal.aborted) { dispose(); return; }
    if (!output || typeof VideoFrame !== "function") {
      fail(new Error("FidelityFX requires Canvas 2D and WebCodecs"));
      return;
    }

    async function upload(video, time, sourceFps) {
      playbackRate = video.playbackRate;
      const limit = getFrameLimit();
      const shouldBypass = limit && sourceFps && limit <= sourceFps * playbackRate * 1.01;
      if (Boolean(shouldBypass) !== bypass) {
        bypass = Boolean(shouldBypass);
        reset();
      }
      if (closed || bypass || copying || pending.length >= 4) return;
      if (video.videoWidth > 1920 || video.videoHeight > 1080) {
        fail(new Error("FidelityFX supports source video up to 1080p"));
        return;
      }
      copying = true;
      const width = Math.max(2, video.videoWidth & ~1);
      const height = Math.max(2, video.videoHeight & ~1);
      if (canvas.width !== width || canvas.height !== height) {
        reset();
        canvas.width = width;
        canvas.height = height;
      }
      const current = generation;
      const duration = sourceFps ? 1 / sourceFps : cadence || 1 / 30;
      cadence = duration;
      let image;
      try {
        image = new VideoFrame(video);
        let format = image.format === "NV12" ? 0 : image.format === "I420" ? 1 : 2;
        const color = image.colorSpace;
        if (color.transfer === "pq" || color.transfer === "hlg" ||
            (color.matrix && !["bt709", "bt470bg", "smpte170m"].includes(color.matrix))) format = 2;
        const rect = image.visibleRect;
        const sameSize = rect.width === width && rect.height === height &&
          image.displayWidth === width && image.displayHeight === height;
        let bytes;
        if (sameSize) {
          const pixels = width * height;
          const luma = {offset: 0, stride: width};
          const options = format === 0 ? {layout: [luma, {offset: pixels, stride: width}]} :
            format === 1 ? {layout: [luma, {offset: pixels, stride: width / 2},
              {offset: pixels + pixels / 4, stride: width / 2}]} : {format: "RGBA"};
          try {
            bytes = image.allocationSize(options);
            if (bytes !== width * height * (format === 2 ? 4 : 1.5)) bytes = 0;
            if (bytes) await image.copyTo(packet.subarray(9, 9 + bytes), options);
          } catch { bytes = 0; }
        }
        if (closed || current !== generation) return;
        if (!bytes) {
          format = 2;
          bytes = width * height * 4;
          if (capture.width !== width || capture.height !== height) {
            capture.width = width;
            capture.height = height;
          }
          reader ||= capture.getContext("2d", {alpha: false, willReadFrequently: true});
          reader.drawImage(image, 0, 0, width, height);
          packet.set(reader.getImageData(0, 0, width, height).data, 9);
        }
        const gap = time - lastTime;
        const previous = gap > 0 && gap < duration * 1.65 ? lastTime : undefined;
        header.setUint16(0, width, true);
        header.setUint16(2, height, true);
        packet[4] = Number(previous === undefined);
        packet[5] = Number(color.matrix === "bt470bg" || color.matrix === "smpte170m") + 2 * Number(Boolean(color.fullRange));
        packet[6] = format;
        header.setUint16(7, Math.min(50000, Math.max(100, Math.round(duration * 100000))), true);
        socket.send(packet.subarray(0, 9 + bytes));
        pending.push({image, time, previous, width, height, generation: current, sent: performance.now()});
        image = null;
        lastTime = time;
      } catch (error) {
        if (current === generation) fail(error);
      } finally {
        image?.close();
        copying = false;
      }
    }

    function receive({data}) {
      if (!ready) {
        if (data !== "ready") { fail(new Error("FidelityFX authentication failed")); return; }
        ready = true;
        clearTimeout(timeout);
        resolve({
          upload, drawAt, reset, dispose, tick, resources, delay: 0.075,
          get outputRate() { return cadence ? 2 * playbackRate / cadence : 0; },
        });
        return;
      }
      const frame = pending.shift();
      if (!frame || !(data instanceof ArrayBuffer) || data.byteLength !== frame.width * frame.height * 1.5) {
        frame?.image.close();
        fail(new Error("FidelityFX returned invalid video data"));
        return;
      }
      if (frame.generation !== generation) return;
      try {
        if (frame.previous !== undefined) {
          const image = new VideoFrame(data, {
            format: "NV12", codedWidth: frame.width, codedHeight: frame.height, timestamp: 0,
            colorSpace: {matrix: "smpte170m", primaries: "bt709", transfer: "bt709", fullRange: false},
            transfer: [data],
          });
          queue.push({image, time: (frame.previous + frame.time) / 2});
        }
        queue.push(frame);
        while (queue.length > 16) queue.shift().image.close();
        totalLatency += performance.now() - frame.sent;
        samples++;
      } catch (error) {
        frame.image.close();
        fail(error);
      }
    }
    function drawAt(time) {
      if (bypass || !queue.length || queue[0].time > time || time - queue.at(-1).time > 0.1) return null;
      while (queue.length > 1 && queue[1].time <= time) queue.shift().image.close();
      const frame = queue[0];
      if (frame === displayed) return false;
      output.drawImage(frame.image, 0, 0, canvas.width, canvas.height);
      displayed = frame;
      return true;
    }
    function tick(now) {
      if (pending.length && now - pending[0].sent > 3000) fail(new Error("FidelityFX frame timed out"));
    }
    function resources() {
      const roundTripMs = samples ? totalLatency / samples : null;
      totalLatency = samples = 0;
      return {roundTripMs, passthrough: bypass};
    }

    port.onMessage.addListener(message => {
      if (closed) return;
      if (message.error) { fail(new Error(message.error)); return; }
      if (socket || message.version !== 1 || !Number.isInteger(message.port) ||
          message.port < 1 || message.port > 65535 || !/^[a-f0-9]{64}$/.test(message.token)) {
        fail(new Error("Invalid FidelityFX helper response"));
        return;
      }
      socket = new WebSocket("ws://127.0.0.1:" + message.port);
      socket.binaryType = "arraybuffer";
      socket.onopen = () => socket.send(message.token);
      socket.onmessage = receive;
      socket.onerror = socket.onclose = () => fail(new Error("FidelityFX connection closed"));
    });
    port.onDisconnect.addListener(() => fail(new Error(chrome.runtime.lastError?.message || "FidelityFX helper disconnected")));
  });
}
