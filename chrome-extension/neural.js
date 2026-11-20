// Framegen's tfact2 student shares its expensive trunk across all the times
// generated for one input pair. Only the scene classification returns to the CPU.
async function kittyNeuralRenderer(canvas, onFailure, hybrid = false, colorSpace = "srgb") {
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter || adapter.info?.isFallbackAdapter) throw new Error("Hardware WebGPU unavailable");
  const device = await adapter.requestDevice({
    requiredFeatures: ["shader-f16", "timestamp-query"].filter(feature => adapter.features.has(feature)),
  });
  let closed = false,
    net;
  try {
    const context = canvas.getContext("webgpu");
    if (!context) throw new Error("WebGPU canvas unavailable");
    const format = kittyFrameFormat(colorSpace);
    const hdr = kittyConfigureCanvas(context, device, colorSpace, GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT);
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
      outputFormat: format,
      staticGuard: true,
      hybrid,
    });
    const U = GPUTextureUsage,
      B = GPUBufferUsage;
    const sceneBytes = Uint32Array.BYTES_PER_ELEMENT;
    const scene = device.createBuffer({
      size: sceneBytes,
      usage: B.STORAGE | B.COPY_SRC,
    });
    const readback = device.createBuffer({
      size: sceneBytes,
      usage: B.COPY_DST | B.MAP_READ,
    });
    const scenePipe = device.createComputePipeline({
      layout: "auto",
      compute: {
        module: device.createShaderModule({
          code: `
        @group(0) @binding(0) var current: texture_2d<f32>;
        @group(0) @binding(1) var previous: texture_2d<f32>;
        @group(0) @binding(2) var<storage,read_write> result: u32;
        var<workgroup> sum: atomic<u32>;
        var<workgroup> peak: atomic<u32>;
        var<workgroup> changed: atomic<u32>;
        fn sample(image: texture_2d<f32>, cell: vec2<u32>) -> vec3<i32> {
          let dim=textureDimensions(image);
          let uv=(vec2<f32>(cell)+0.5)/vec2<f32>(16,12);
          let p=vec2<i32>(uv*vec2<f32>(dim));
          var rgb=vec3<f32>(0);
          for(var y=0;y<2;y++){for(var x=0;x<2;x++){
            let offset=vec2<i32>(x*3-1,y*3-1);
            rgb+=textureLoad(image,clamp(p+offset,vec2<i32>(0),vec2<i32>(dim)-1),0).rgb;
          }}
          return vec3<i32>(round(rgb * (255.0 / 4.0)));
        }
        @compute @workgroup_size(16,12) fn main(
          @builtin(local_invocation_id) id: vec3<u32>,
          @builtin(local_invocation_index) index: u32,
        ) {
          let delta=abs(sample(current,id.xy)-sample(previous,id.xy));
          let distance=u32(delta.r+delta.g+delta.b);
          atomicAdd(&sum,distance);
          atomicMax(&peak,distance);
          if (distance > 24u*3u) { atomicAdd(&changed,1u); }
          workgroupBarrier();
          if (index == 0u) {
            let mean=f32(atomicLoad(&sum))/(3.0*192.0);
            let repeat=mean < 0.8 && atomicLoad(&peak) < 12u*3u;
            let cut=mean > 51.0 && atomicLoad(&changed) > 144u;
            result=select(select(0u,2u,cut),1u,repeat);
          }
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
      return { gpu, bytes: net.allocatedBytes + sceneBytes
        + width * height * (format === "rgba16float" ? 8 : 4) * (slots.length + (out ? 1 : 0)) };
    }
    const reset = () => {
      hdr?.reset();
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
      out = device.createTexture({
        size: [w, h],
        format,
        usage: U.STORAGE_BINDING | U.COPY_SRC | (hdr ? U.TEXTURE_BINDING : 0),
      });
    }
    function upload(video, time, planes, w = video.videoWidth, h = video.videoHeight) {
      if (reading || closed) return;
      if (w !== width || h !== height) resize(w, h);
      let slot = slots.find((s) => !frames.some((f) => f.slot === s));
      if (!slot) {
        const image = device.createTexture({
          size: [width, height],
          format,
          usage:
            U.TEXTURE_BINDING | U.COPY_DST | U.COPY_SRC | U.RENDER_ATTACHMENT | (hdr ? U.STORAGE_BINDING : 0),
        });
        slot = { image, view: image.createView() };
        slots.push(slot);
      }
      const enc = device.createCommandEncoder();
      if (hdr) hdr.unpack(enc, planes, slot.image);
      else device.queue.copyExternalImageToTexture(
        { source: video },
        { texture: slot.image, colorSpace },
        [width, height],
      );
      const prev = frames.at(-1);
      const group = device.createBindGroup({
        layout: scenePipe.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: slot.view },
          { binding: 1, resource: prev?.slot.view || slot.view },
          { binding: 2, resource: { buffer: scene } },
        ],
      });
      const pass = enc.beginComputePass();
      pass.setPipeline(scenePipe);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(1);
      pass.end();
      enc.copyBufferToBuffer(scene, 0, readback, 0, sceneBytes);
      device.queue.submit([enc.finish()]);
      const generation = epoch;
      reading = true;
      readback
        .mapAsync(GPUMapMode.READ)
        .then(() => {
          const classification = new Uint32Array(readback.getMappedRange())[0];
          readback.unmap();
          if (closed || generation !== epoch) return;
          if (prev && classification === 1) return;
          const cut = prev && (time - prev.time > 0.25 || classification === 2);
          frames.push({ slot, time, cut });
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
      const image = source?.slot.image || out;
      if (hdr) hdr.present(enc, image);
      else enc.copyTextureToTexture(
        { texture: image },
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
      upload(video, time, fps, frame) {
        if (hdr && !reading && !closed) hdr.capture(frame, (planes, w, h) => upload(video, time, planes, w, h), failure);
        else if (!hdr) upload(video, time);
      },
      drawAt,
      resources,
      dispose() {
        closed = true;
        reset();
        freeTextures();
        scene.destroy();
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
