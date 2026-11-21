// PQ and HLG code values fit the interpolation shaders' 0..1 signal range.
function kittyVideoColorSpace(frame, windowsHdrDisplay = false) {
  const {primaries, transfer, matrix, fullRange} = frame.colorSpace;
  if (transfer === "pq" || transfer === "hlg") {
    if (primaries === "bt2020" && matrix === "bt2020-ncl" && fullRange !== null &&
        (frame.format === "I420P10" || frame.format === "NV12" || frame.format === "I420") &&
        !frame.rotation && !frame.flip &&
        frame.displayWidth === frame.visibleRect.width && frame.displayHeight === frame.visibleRect.height) return transfer;
    return "converted";
  }
  if (primaries === "bt2020" || primaries === "smpte432" || matrix === "bt2020-ncl" ||
      transfer === "linear" || /P(10|12)$/.test(frame.format)) return "converted";
  if (windowsHdrDisplay && primaries === "bt709" && transfer === "bt709" && matrix === "bt709")
    return "bt709-on-hdr";
  return "srgb";
}

function kittyFrameFormat(colorSpace) {
  return colorSpace === "srgb" ? "rgba8unorm" : "rgba16float";
}

// On a Windows HDR desktop, Chrome presents BT.709 video with a 2.2 display
// gamma. Its SDR canvas feeds the same signal values to the sRGB display curve.
// Match the video layer at presentation, including frames passed through unwarped.
function kittyBt709DisplayFilter() {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("width", "0");
  svg.setAttribute("height", "0");
  svg.setAttribute("aria-hidden", "true");
  svg.style.position = "absolute";
  const filter = document.createElementNS(ns, "filter");
  filter.id = "kittyplays-display-" + crypto.randomUUID();
  filter.setAttribute("x", "0%");
  filter.setAttribute("y", "0%");
  filter.setAttribute("width", "100%");
  filter.setAttribute("height", "100%");
  filter.setAttribute("color-interpolation-filters", "sRGB");
  const transfer = document.createElementNS(ns, "feComponentTransfer");
  const values = Array.from({length: 256}, (_, code) => {
    const linear = (code / 255) ** 2.2;
    return (linear <= 0.0031308 ? 12.92 * linear : 1.055 * linear ** (1 / 2.4) - 0.055).toFixed(7);
  }).join(" ");
  for (const channel of ["R", "G", "B"]) {
    const func = document.createElementNS(ns, "feFunc" + channel);
    func.setAttribute("type", "table");
    func.setAttribute("tableValues", values);
    transfer.append(func);
  }
  filter.append(transfer);
  svg.append(filter);
  return svg;
}

function kittyConfigureCanvas(context, device, colorSpace, usage) {
  const hdr = colorSpace !== "srgb";
  const format = kittyFrameFormat(colorSpace);
  context.configure({device, format, colorSpace: hdr ? "display-p3" : "srgb",
    usage: hdr ? usage | GPUTextureUsage.STORAGE_BINDING : usage, alphaMode: "opaque",
    toneMapping: {mode: hdr ? "extended" : "standard"}});
  if (!hdr) return;
  const config = context.getConfiguration?.();
  if (config?.colorSpace !== "display-p3" || config.format !== format ||
      config.toneMapping?.mode !== "extended") throw new Error("HDR canvas unavailable");

  function pipeline(code) {
    return device.createComputePipeline({layout: "auto", compute: {
      module: device.createShaderModule({code}), entryPoint: "main",
    }});
  }
  // Import the decoder's native planes. External-image copies may go through
  // an 8-bit RGB intermediate even when the destination is a float texture.
  const unpack = pipeline(`
    struct Planes { fullRange: u32, sampleBytes: u32, interleaved: u32, data: array<u32> }
    @group(0) @binding(0) var<storage, read> src: Planes;
    @group(0) @binding(1) var dst: texture_storage_2d<rgba16float, write>;
    fn sampleAt(index: u32) -> f32 {
      if (src.sampleBytes == 1u) {
        return 4.0 * f32((src.data[index / 4u] >> ((index % 4u) * 8u)) & 255u);
      }
      return f32((src.data[index / 2u] >> ((index % 2u) * 16u)) & 1023u);
    }
    fn chroma(offset: u32, dim: vec2<u32>, pos: vec2<f32>) -> f32 {
      let a = vec2<u32>(max(floor(pos), vec2<f32>(0.0)));
      let b = vec2<u32>(clamp(floor(pos) + 1.0, vec2<f32>(0), vec2<f32>(dim - 1u)));
      let f = fract(pos);
      let step = 1u + src.interleaved;
      return mix(mix(sampleAt(offset+(a.y*dim.x+a.x)*step), sampleAt(offset+(a.y*dim.x+b.x)*step), f.x),
                 mix(sampleAt(offset+(b.y*dim.x+a.x)*step), sampleAt(offset+(b.y*dim.x+b.x)*step), f.x), f.y);
    }
    @compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id: vec3<u32>) {
      let dim = textureDimensions(dst);
      if (any(id.xy >= dim)) { return; }
      let c = (dim + 1u) / 2u;
      let pos = vec2<f32>(id.xy) * 0.5 - vec2<f32>(0, 0.25);
      let offset = dim.x * dim.y;
      let full = src.fullRange != 0u;
      let peak = select(1023.0, 1020.0, src.sampleBytes == 1u);
      let y = (sampleAt(id.y*dim.x+id.x) - select(64.0, 0.0, full)) / select(876.0, peak, full);
      let cb = (chroma(offset, c, pos) - 512.0) / select(896.0, peak, full);
      let crOffset = offset + select(c.x*c.y, 1u, src.interleaved != 0u);
      let cr = (chroma(crOffset, c, pos) - 512.0) / select(896.0, peak, full);
      let r = y + 1.4746 * cr;
      let b = y + 1.8814 * cb;
      let g = (y - 0.2627*r - 0.0593*b) / 0.6780;
      textureStore(dst, id.xy, vec4<f32>(r, g, b, 1));
    }`);
  // BT.2100 reference EOTFs, relative to 203 cd/m² SDR white. HLG uses
  // the 1000 cd/m² reference display. The browser maps to the actual display.
  const present = pipeline(`
    @group(0) @binding(0) var src: texture_2d<f32>;
    @group(0) @binding(1) var dst: texture_storage_2d<rgba16float, write>;
    @compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id: vec3<u32>) {
      if (any(id.xy >= textureDimensions(dst))) { return; }
      let signal = clamp(textureLoad(src, id.xy, 0).rgb, vec3<f32>(0), vec3<f32>(1));
      ${colorSpace === "pq" ? `
        let p = pow(signal, vec3<f32>(32.0/2523.0));
        let linear = pow(max(p - 3424.0/4096.0, vec3<f32>(0)) /
          (2413.0/128.0 - (2392.0/128.0)*p), vec3<f32>(16384.0/2610.0)) * (10000.0/203.0);` : `
        let scene = select(signal*signal/3.0, (exp((signal-0.55991073)/0.17883277)+0.28466892)/12.0, signal > vec3<f32>(0.5));
        let linear = scene * pow(dot(scene, vec3<f32>(0.2627,0.6780,0.0593)), 0.2) * (1000.0/203.0);`}
      let p3 = vec3<f32>(dot(linear, vec3<f32>(1.343578,-0.282180,-0.061399)),
                         dot(linear, vec3<f32>(-0.065298,1.075788,-0.010490)),
                         dot(linear, vec3<f32>(0.002822,-0.019598,1.016777)));
      let a = abs(p3);
      let encoded = sign(p3) * select(12.92*a, 1.055*pow(a, vec3<f32>(1.0/2.4))-0.055, a > vec3<f32>(0.0031308));
      textureStore(dst, id.xy, vec4<f32>(encoded, 1));
    }`);
  function dispatch(encoder, pipe, source, target) {
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipe);
    pass.setBindGroup(0, device.createBindGroup({layout: pipe.getBindGroupLayout(0), entries: [
      {binding: 0, resource: source}, {binding: 1, resource: target.createView()},
    ]}));
    pass.dispatchWorkgroups(Math.ceil(target.width / 8), Math.ceil(target.height / 8));
    pass.end();
  }
  let generation = 0, copying = false;
  return {
    reset() { generation++; },
    async capture(frame, upload, onFailure) {
      if (copying) return;
      copying = true;
      const epoch = generation;
      let buffer;
      try {
        const {width, height} = frame.visibleRect;
        const cw = Math.ceil(width / 2), ch = Math.ceil(height / 2);
        const sampleBytes = frame.format === "I420P10" ? 2 : 1;
        const interleaved = frame.format === "NV12";
        const yBytes = width * height * sampleBytes, cBytes = cw * ch * sampleBytes;
        const layout = [{offset: 0, stride: width * sampleBytes},
          {offset: yBytes, stride: cw * sampleBytes * (interleaved ? 2 : 1)}];
        if (!interleaved) layout.push({offset: yBytes + cBytes, stride: cw * sampleBytes});
        buffer = device.createBuffer({size: 12 + Math.ceil((yBytes + 2*cBytes)/4)*4,
          usage: GPUBufferUsage.STORAGE, mappedAtCreation: true});
        const mapped = buffer.getMappedRange();
        new Uint32Array(mapped, 0, 3).set([Number(frame.colorSpace.fullRange), sampleBytes, Number(interleaved)]);
        await frame.copyTo(new Uint8Array(mapped, 12), {layout});
        buffer.unmap();
        if (generation === epoch) upload(buffer, width, height);
      } catch (error) {
        if (generation === epoch) onFailure(error);
      } finally {
        buffer?.destroy();
        copying = false;
      }
    },
    unpack(encoder, buffer, target) { dispatch(encoder, unpack, {buffer}, target); },
    present(encoder, source) { dispatch(encoder, present, source.createView(), context.getCurrentTexture()); },
  };
}
