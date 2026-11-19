// Framegen's tfact2 student shares its expensive trunk across all the times
// generated for one input pair. Only a tiny scene signature returns to the CPU.
async function kittyNeuralRenderer(canvas, onFailure, hybrid = false) {
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter || adapter.info?.isFallbackAdapter) throw new Error("Hardware WebGPU unavailable");
  const device = await adapter.requestDevice({
    requiredFeatures: ["shader-f16", "timestamp-query"].filter(feature => adapter.features.has(feature)),
  });
  let closed = false,
    net;
  try {
    const model = await chrome.runtime.sendMessage({type: "kittyplays-load-model"});
    if (!model?.weights) throw new Error(model?.error || "Model data unavailable");
    const weightsBin = (Uint8Array.fromBase64
      ? Uint8Array.fromBase64(model.weights)
      : Uint8Array.from(atob(model.weights), c => c.charCodeAt(0))).buffer;
    const [w, h] = device.features.has("shader-f16") ? [1280, 720] : [848, 480];
    net = await kittyCreateRT(device, {
      w,
      h,
      weightsBin,
      weightsManifest: model.manifest,
      textureInput: true,
      textureOutput: true,
      staticGuard: true,
      hybrid,
    });
    const context = canvas.getContext("webgpu");
    if (!context) throw new Error("WebGPU canvas unavailable");
    const U = GPUTextureUsage,
      B = GPUBufferUsage;
    const signatureBytes = 16 * 12 * 4;
    const signature = device.createBuffer({
      size: signatureBytes,
      usage: B.STORAGE | B.COPY_SRC,
    });
    const readback = device.createBuffer({
      size: signatureBytes,
      usage: B.COPY_DST | B.MAP_READ,
    });
    const signaturePipe = device.createComputePipeline({
      layout: "auto",
      compute: {
        module: device.createShaderModule({
          code: `
        @group(0) @binding(0) var image: texture_2d<f32>;
        @group(0) @binding(1) var<storage,read_write> result:array<u32>;
        @compute @workgroup_size(8,4) fn main(@builtin(global_invocation_id) id:vec3<u32>) {
          let dim=textureDimensions(image);
          let uv=(vec2<f32>(id.xy)+0.5)/vec2<f32>(16,12);
          let p=vec2<i32>(uv*vec2<f32>(dim));
          var rgb=vec3<f32>(0);
          for(var y=0;y<2;y++){for(var x=0;x<2;x++){
            let offset=vec2<i32>(x*3-1,y*3-1);
            rgb+=textureLoad(image,clamp(p+offset,vec2<i32>(0),vec2<i32>(dim)-1),0).rgb;
          }}
          result[id.y*16+id.x]=pack4x8unorm(vec4<f32>(rgb*.25,1));
        }`,
        }),
        entryPoint: "main",
      },
    });
    let width = 0,
      height = 0,
      slots = [],
      frames = [],
      out,
      previousPair,
      shown;
    let reading = false,
      presenting = false,
      epoch = 0;
    const prepare = { calls: 0, ms: null }, generate = { calls: 0, ms: null };
    // Sample one in eight passes without synchronously waiting on the GPU.
    function record(stage, timing) {
      stage.calls++;
      if (!timing) return;
      const generation = epoch;
      timing.then(ms => {
        if (generation === epoch && Number.isFinite(ms))
          stage.ms = stage.ms === null ? ms : stage.ms * .75 + ms * .25;
      });
    }
    function resources(elapsed) {
      const stages = [prepare, generate];
      const known = net.hasGpuTimestamps && stages.every(s => !s.calls || s.ms !== null);
      const gpu = known && elapsed > 0
        ? Math.min(100, 100 * stages.reduce((n, s) => n + s.calls * (s.ms || 0), 0) / elapsed)
        : null;
      prepare.calls = generate.calls = 0;
      return { gpu, bytes: net.allocatedBytes + 2 * signatureBytes
        + width * height * 4 * (slots.length + (out ? 1 : 0)) };
    }
    const reset = () => {
      epoch++;
      prepare.calls = generate.calls = 0;
      frames = [];
      previousPair = null;
      shown = null;
    };
    const freeTextures = () => {
      for (const slot of slots) slot.image.destroy();
      slots = [];
      out?.destroy();
    };
    const failure = (err) => {
      if (!closed) onFailure(err);
    };
    device.lost.then((info) =>
      failure(new Error(info.message || "GPU device lost")),
    );
    device.addEventListener("uncapturederror", (event) => failure(event.error));
    function resize(w, h) {
      reset();
      freeTextures();
      width = canvas.width = w;
      height = canvas.height = h;
      context.configure({
        device,
        format: "rgba8unorm",
        alphaMode: "opaque",
        usage: U.COPY_DST | U.RENDER_ATTACHMENT,
      });
      out = device.createTexture({
        size: [w, h],
        format: "rgba8unorm",
        usage: U.STORAGE_BINDING | U.COPY_SRC,
      });
    }
    function upload(video, time) {
      if (reading || closed) return;
      if (video.videoWidth !== width || video.videoHeight !== height)
        resize(video.videoWidth, video.videoHeight);
      let slot = slots.find((s) => !frames.some((f) => f.slot === s));
      if (!slot) {
        const image = device.createTexture({
          size: [width, height],
          format: "rgba8unorm",
          usage:
            U.TEXTURE_BINDING | U.COPY_DST | U.COPY_SRC | U.RENDER_ATTACHMENT,
        });
        slot = {
          image,
          group: device.createBindGroup({
            layout: signaturePipe.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: image.createView() },
              { binding: 1, resource: { buffer: signature } },
            ],
          }),
        };
        slots.push(slot);
      }
      device.queue.copyExternalImageToTexture(
        { source: video },
        { texture: slot.image },
        [width, height],
      );
      const enc = device.createCommandEncoder(),
        pass = enc.beginComputePass();
      pass.setPipeline(signaturePipe);
      pass.setBindGroup(0, slot.group);
      pass.dispatchWorkgroups(2, 3);
      pass.end();
      enc.copyBufferToBuffer(signature, 0, readback, 0, signatureBytes);
      device.queue.submit([enc.finish()]);
      const generation = epoch;
      reading = true;
      readback
        .mapAsync(GPUMapMode.READ)
        .then(() => {
          const sample = new Uint8Array(readback.getMappedRange()).slice();
          readback.unmap();
          if (closed || generation !== epoch) return;
          const prev = frames.at(-1);
          let sum = 0,
            peak = 0,
            changed = 0;
          if (prev)
            for (let i = 0; i < signatureBytes; i += 4) {
              const d =
                (Math.abs(sample[i] - prev.sample[i]) +
                  Math.abs(sample[i + 1] - prev.sample[i + 1]) +
                  Math.abs(sample[i + 2] - prev.sample[i + 2])) /
                3;
              sum += d;
              peak = Math.max(peak, d);
              if (d > 24) changed++;
            }
          const mean = sum / (signatureBytes / 4);
          if (prev && mean < 0.8 && peak < 12) return;
          const cut =
            prev &&
            (time - prev.time > 0.25 ||
              (mean > 51 && changed > (signatureBytes / 4) * 0.75));
          frames.push({ slot, time, sample, cut });
          if (frames.length > 4) frames.shift();
        })
        .catch(failure)
        .finally(() => {
          reading = false;
        });
    }
    function drawAt(time) {
      if (presenting || frames.length < 2 || closed) return false;
      let i = frames.findIndex((f, n) => n > 0 && f.time >= time);
      if (i < 0) i = frames.length - 1;
      const a = frames[i - 1],
        b = frames[i];
      const t = Math.min(1, Math.max(0, (time - a.time) / (b.time - a.time)));
      let source;
      if (t < 0.015 || (b.cut && t < 0.5)) source = a;
      else if (t > 0.985 || b.cut) source = b;
      if (source && shown === source) return false;
      if (!source) {
        if (previousPair !== b) {
          record(prepare, net.prepPair(a.slot.image, b.slot.image, {measure: prepare.calls % 8 === 0}));
          previousPair = b;
        }
        record(generate, net.runT(t, out, {measure: generate.calls % 8 === 0}));
      }
      shown = source;
      const enc = device.createCommandEncoder();
      enc.copyTextureToTexture(
        { texture: source?.slot.image || out },
        { texture: context.getCurrentTexture() },
        [width, height],
      );
      device.queue.submit([enc.finish()]);
      // Bound outstanding inference work on slower GPUs, including background tabs.
      presenting = true;
      device.queue
        .onSubmittedWorkDone()
        .catch(failure)
        .finally(() => {
          presenting = false;
        });
      return true;
    }
    return {
      reset,
      upload,
      drawAt,
      resources,
      dispose() {
        closed = true;
        reset();
        freeTextures();
        signature.destroy();
        readback.destroy();
        net.destroy();
        context.unconfigure();
        device.destroy();
      },
    };
  } catch (err) {
    closed = true;
    net?.destroy();
    device.destroy();
    throw err;
  }
}
