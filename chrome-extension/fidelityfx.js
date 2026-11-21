// Video-only FidelityFX path. Pixel data stays in browser GPU textures.
async function createFidelityFxRenderer(canvas, signal, onFailure, getFrameLimit, maxMultiplier = 8, colorSpace = "srgb") {
  const adapterOptions = /^win/i.test(kittyPlaysPlatform) ? undefined : {powerPreference: "high-performance"};
  const adapter = await navigator.gpu?.requestAdapter(adapterOptions);
  if (!adapter || adapter.info.isFallbackAdapter) throw new Error("FidelityFX requires hardware WebGPU");
  signal.throwIfAborted();
  const device = await adapter.requestDevice();
  try {
    const format = kittyFrameFormat(colorSpace);
    const stages = Object.entries(kittyFidelityFxShaders).flatMap(([name, code]) => {
      const module = device.createShaderModule({label: name, code: typeof code === "function" ? code(format) : code});
      if (name === "search") return [
        ["coarse", module, {radius: 8, usePrediction: 0}],
        ["refine", module, {radius: 4, usePrediction: 1}],
        ["refineLocal", module, {radius: 4, usePrediction: 1, tryLocal: 1}],
        ["fine", module, {radius: 2, usePrediction: 1}],
      ];
      return [[name, module]];
    });
    const pipes = Object.fromEntries(await Promise.all(stages.map(async ([name, module, constants]) => [
      name,
      await device.createComputePipelineAsync({label: name, layout: "auto", compute: {
        module, entryPoint: "main", constants,
      }}),
    ])));
    signal.throwIfAborted();
    const context = canvas.getContext("webgpu");
    if (!context) throw new Error("WebGPU canvas unavailable");

    const textureUsage = GPUTextureUsage;
    const bufferUsage = GPUBufferUsage;
    const read = textureUsage.TEXTURE_BINDING;
    const storage = textureUsage.STORAGE_BINDING;
    const copyIn = textureUsage.COPY_DST | textureUsage.RENDER_ATTACHMENT;
    const hdr = kittyConfigureCanvas(context, device, colorSpace, copyIn | storage);
    const sampler = device.createSampler({minFilter: "linear", magFilter: "linear"});
    const frames = [], slots = [], levels = [], pyramids = [];
    let width = 0, height = 0, bytes = 0;
    let pyramidIndex = 0;
    let projected, phase, intermediate;
    const phaseData = new ArrayBuffer(16);
    const phaseGrid = new Uint32Array(phaseData, 0, 2);
    const phaseTime = new Float32Array(phaseData, 8, 1);
    let cadence, playbackRate = 1, displayed, bypass = false;
    let inFlight = 0, pendingDraws = 0, closed = false;
    let busyDrops = 0;

    function fail(error) {
      if (closed) return;
      dispose();
      onFailure(error);
    }
    device.lost.then(info => fail(new Error(info.message || "GPU device lost")));
    device.addEventListener("uncapturederror", event => fail(event.error));

    function texture(w, h, format, usage, label) {
      const image = device.createTexture({label, size: [w, h], format, usage});
      bytes += w * h * (format === "rg32sint" || format === "rgba16float" ? 8 : 4);
      return {image, view: image.createView()};
    }

    function buffer(size, usage) {
      bytes += size;
      return device.createBuffer({size, usage});
    }

    function reset() {
      hdr?.reset();
      frames.length = 0;
      cadence = displayed = undefined;
      busyDrops = 0;
    }

    function release() {
      reset();
      for (const slot of slots) {
        slot.color.image.destroy();
        slot.vectors.destroy();
        slot.entries.destroy();
        slot.divergence.destroy();
      }
      for (const pyramid of pyramids) for (const luma of pyramid) luma.image.destroy();
      for (const level of levels) {
        level.raw.image.destroy();
        level.filtered.image.destroy();
      }
      slots.length = levels.length = pyramids.length = 0;
      phase?.destroy();
      projected?.destroy();
      intermediate?.image.destroy();
      bytes = 0;
    }

    function resize(w, h) {
      release();
      width = canvas.width = w;
      height = canvas.height = h;
      if (hdr) intermediate = texture(w, h, format, read | storage, "Interpolated HDR frame");
      while (levels.length < 7) {
        const cols = Math.ceil(w / 8), rows = Math.ceil(h / 8);
        levels.push({w, h, cols, rows,
          raw: texture(cols, rows, "rg32sint", read | storage, "Raw optical flow"),
          filtered: texture(cols, rows, "rg32sint", read | storage, "Filtered optical flow"),
        });
        if (Math.max(w, h) <= 16) break;
        w = Math.ceil(w / 2);
        h = Math.ceil(h / 2);
      }
      const cells = levels[0].cols * levels[0].rows;
      for (let i = 0; i < 2; i++) {
        pyramids.push(levels.map(({w, h}) => texture(w, h, "r32uint", read | storage, "Luminance pyramid")));
      }
      phaseGrid.set([levels[0].cols, levels[0].rows]);
      phase = buffer(16, bufferUsage.UNIFORM | bufferUsage.COPY_DST);
      projected = buffer(cells * 4, bufferUsage.STORAGE | bufferUsage.COPY_DST);
    }

    function makeSlot() {
      const cells = levels[0].cols * levels[0].rows;
      return {
        color: texture(width, height, format, read | copyIn | textureUsage.COPY_SRC | (hdr ? storage : 0), "Decoded frame"),
        vectors: buffer(cells * 8, bufferUsage.STORAGE),
        entries: buffer(cells * 4, bufferUsage.STORAGE),
        divergence: buffer(9 * 4, bufferUsage.STORAGE),
      };
    }

    function dispatch(pass, name, resources, x, y) {
      const pipe = pipes[name];
      const group = device.createBindGroup({
        layout: pipe.getBindGroupLayout(0),
        entries: resources.map((resource, binding) => ({binding, resource})),
      });
      pass.setPipeline(pipe);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(x, y);
    }

    function prepareMotion(pass, current, prevLuma, currLuma) {
      const sceneLevel = Math.min(levels.length - 1, 3);
      const scene = {buffer: current.divergence};
      dispatch(pass, "scene", [currLuma[sceneLevel].view, prevLuma[sceneLevel].view, scene], 3, 3);
      for (let index = levels.length - 1; index >= 0; index--) {
        const level = levels[index];
        const coarser = levels[index + 1];
        const name = !coarser ? "coarse" : index === 2 ? "refineLocal" : index ? "refine" : "fine";
        dispatch(pass, name, [
          currLuma[index].view, prevLuma[index].view,
          (coarser || level).filtered.view, level.raw.view,
        ], level.cols, level.rows);
        dispatch(pass, "filter", [level.raw.view, level.filtered.view],
          Math.ceil(level.cols / 8), Math.ceil(level.rows / 8));
      }
      const finest = levels[0];
      dispatch(pass, "project", [
        finest.filtered.view, currLuma[0].view, prevLuma[0].view,
        {buffer: current.vectors}, {buffer: current.entries}, scene,
      ], Math.ceil(finest.cols / 8), Math.ceil(finest.rows / 8));
    }

    function upload(video, time, sourceFps, frame) {
      if (closed) return;
      const limit = getFrameLimit();
      playbackRate = video.playbackRate;
      const skip = Boolean(limit && sourceFps && limit <= sourceFps * playbackRate * 1.01);
      if (skip !== bypass) {
        bypass = skip;
        reset();
      }
      if (bypass) return;
      if (inFlight >= 2) {
        busyDrops++;
        return;
      }
      const w = video.videoWidth, h = video.videoHeight;
      if (!hdr && (w > 1920 || h > 1080)) {
        fail(new Error("FidelityFX supports source video up to 1080p"));
        return;
      }
      // Scatter entries reserve 20 bits for the source 8×8 block index.
      if (Math.ceil(w / 8) * Math.ceil(h / 8) > 2 ** 20) {
        fail(new Error("Video exceeds the optical-flow grid limit"));
        return;
      }
      if (hdr) return hdr.capture(frame, (planes, w, h) => storeFrame(video, time, sourceFps, limit, w, h, planes), fail);
      storeFrame(video, time, sourceFps, limit, w, h);
    }

    function storeFrame(video, time, sourceFps, limit, w, h, planes) {
      if (width !== w || height !== h) resize(w, h);
      const previous = frames.at(-1);
      const gap = time - previous?.time;
      cadence = sourceFps ? 1 / sourceFps : cadence || 1 / 30;
      const contiguous = gap > 0 && gap < cadence * 1.65;
      const prevLuma = pyramids[pyramidIndex];
      pyramidIndex ^= 1;
      const currLuma = pyramids[pyramidIndex];
      const oldestTime = time - Math.max(4 * cadence, 0.12 * playbackRate);
      while (frames.length > 2 && frames[1].time < oldestTime) frames.shift();
      let slot = slots.find(candidate => !frames.some(frame => frame.slot === candidate));
      if (!slot) {
        if (slots.length < 8) {
          slot = makeSlot();
          slots.push(slot);
        } else slot = frames.shift().slot;
      }
      const encoder = device.createCommandEncoder();
      if (hdr) hdr.unpack(encoder, planes, slot.color.image);
      else device.queue.copyExternalImageToTexture({source: video}, {texture: slot.color.image, colorSpace}, [width, height]);
      const pass = encoder.beginComputePass();
      dispatch(pass, "luma", [slot.color.view, currLuma[0].view], levels[0].cols, levels[0].rows);
      for (let index = 1; index < levels.length; index++) {
        const {cols, rows} = levels[index];
        dispatch(pass, "downsample", [currLuma[index - 1].view, currLuma[index].view], cols, rows);
      }
      if (contiguous) prepareMotion(pass, slot, prevLuma, currLuma);
      pass.end();
      device.queue.submit([encoder.finish()]);
      const target = limit ? Math.ceil(limit * cadence / playbackRate - 0.06) : maxMultiplier;
      const multiplier = contiguous ? Math.max(1, Math.min(maxMultiplier, target)) : 1;
      frames.push({slot, time, multiplier});
      inFlight++;
      device.queue.onSubmittedWorkDone().catch(fail).finally(() => { inFlight--; });
    }

    function drawAt(time) {
      if (closed || bypass || !frames.length || time < frames[0].time || time - frames.at(-1).time > 0.1) return null;
      // Fullscreen queue completions can arrive several display ticks late.
      // Overlap draws while bounding the backlog when the GPU really falls behind.
      if (pendingDraws >= 4) return false;
      const nextIndex = frames.findIndex(frame => frame.time > time);
      const next = frames[nextIndex];
      const frame = nextIndex < 0 ? frames.at(-1) : frames[nextIndex - 1];
      const span = next ? next.time - frame.time : 0;
      const step = next ? Math.min(next.multiplier - 1, Math.floor((time - frame.time) / span * next.multiplier)) : 0;
      const fraction = step ? step / next.multiplier : 0;
      const at = frame.time + fraction * span;
      if (displayed === at) return false;
      const encoder = device.createCommandEncoder();
      if (step) {
        const output = hdr ? intermediate.image : context.getCurrentTexture();
        const current = next.slot;
        phaseTime[0] = fraction;
        device.queue.writeBuffer(phase, 0, phaseData);
        encoder.clearBuffer(projected);
        const pass = encoder.beginComputePass();
        const {cols, rows} = levels[0];
        dispatch(pass, "scatter", [
          {buffer: current.vectors}, {buffer: current.entries}, {buffer: projected}, {buffer: phase},
        ], Math.ceil(cols / 8), Math.ceil(rows / 8));
        dispatch(pass, "interpolate", [
          frame.slot.color.view, current.color.view, sampler, {buffer: current.vectors},
          {buffer: projected}, {buffer: current.divergence}, output.createView(), {buffer: phase},
        ], cols, rows);
        pass.end();
        if (hdr) hdr.present(encoder, output);
      } else if (hdr) {
        hdr.present(encoder, frame.slot.color.image);
      } else {
        encoder.copyTextureToTexture({texture: frame.slot.color.image}, {texture: context.getCurrentTexture()}, [width, height]);
      }
      device.queue.submit([encoder.finish()]);
      displayed = at;
      pendingDraws++;
      device.queue.onSubmittedWorkDone().catch(fail).finally(() => { pendingDraws--; });
      return true;
    }

    function dispose() {
      if (closed) return;
      closed = true;
      signal.removeEventListener("abort", dispose);
      release();
      context.unconfigure();
      device.destroy();
    }
    signal.addEventListener("abort", dispose, {once: true});
    return {
      upload, drawAt, reset, dispose, delay: 0.045,
      resources() {
        const dropped = busyDrops;
        busyDrops = 0;
        return {bytes, passthrough: bypass, resolution: !bypass && width ? [width, height] : undefined, dropped};
      },
      get outputRate() { return cadence ? (frames.at(-1)?.multiplier || 1) * playbackRate / cadence : 0; },
    };
  } catch (error) {
    device.destroy();
    throw error;
  }
}
