// Run with Playwright, Google Chrome and WebGPU available.
const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const {chromium} = require("playwright");

test("Windows HDR presentation preserves the BT.709 shadow curve for SDR video", async () => {
  const browser = await chromium.launch({channel: "chrome"});
  try {
    const page = await browser.newPage();
    await page.route("https://kitty.test/", route => route.fulfill({body: "<main></main>", contentType: "text/html"}));
    await page.goto("https://kitty.test/");
    await page.addScriptTag({path: path.resolve(__dirname, "../chrome-extension/color.js")});
    const {profiles, samples} = await page.evaluate(() => {
      const frame = {format: "NV12", colorSpace: {primaries: "bt709", transfer: "bt709", matrix: "bt709"}};
      const profiles = [
        kittyVideoColorSpace(frame, {hdrCanvas: false}),
        kittyVideoColorSpace(frame, {hdrCanvas: true, matchBt709: true}),
        kittyVideoColorSpace(frame, {hdrCanvas: false, matchBt709: true}),
      ];
      frame.colorSpace.transfer = "iec61966-2-1";
      profiles.push(kittyVideoColorSpace(frame, {hdrCanvas: false, matchBt709: true}));
      for (const transfer of ["pq", "hlg"]) {
        frame.colorSpace = {primaries: "bt2020", transfer, matrix: "bt2020-ncl", fullRange: false};
        profiles.push(kittyVideoColorSpace(frame, {hdrCanvas: false, matchBt709: true}));
      }
      const filter = kittyBt709DisplayFilter();
      document.body.append(filter);
      const input = document.createElement("canvas");
      input.width = 256;
      input.height = 1;
      const ctx = input.getContext("2d");
      const data = ctx.createImageData(256, 1);
      for (let x = 0; x < 256; x++) data.data.set([x, x, x, 255], 4*x);
      ctx.putImageData(data, 0, 0);
      const output = input.cloneNode();
      const result = output.getContext("2d");
      result.filter = `url(#${filter.firstElementChild.id})`;
      result.drawImage(input, 0, 0);
      const samples = Array.from(result.getImageData(0, 0, 256, 1).data).filter((_, i) => i % 4 === 0);
      return {profiles, samples};
    });
    assert.deepEqual(profiles, ["srgb", "bt709-on-hdr", "bt709-on-hdr", "srgb", "converted", "converted"]);
    assert.equal(samples[0], 0);
    assert.equal(samples[255], 255);
    for (const [code, actual] of samples.entries()) {
      const linear = (code / 255) ** 2.2;
      const expected = 255 * (linear <= 0.0031308 ? 12.92 * linear : 1.055 * linear ** (1/2.4) - 0.055);
      assert.ok(Math.abs(actual - expected) <= 1, `BT.709 code ${code}: got ${actual}, expected ${expected}`);
    }
  } finally { await browser.close(); }
});

test("10-bit PQ and HLG retain adjacent highlight levels through the HDR canvas", async () => {
  const browser = await chromium.launch({channel: "chrome"});
  try {
    const page = await browser.newPage();
    await page.route("https://kitty.test/", route => route.fulfill({body: "<canvas></canvas>", contentType: "text/html"}));
    await page.goto("https://kitty.test/");
    await page.addScriptTag({path: path.resolve(__dirname, "../chrome-extension/color.js")});
    for (const transfer of ["pq", "hlg"]) {
      for (const fullRange of [false, true]) {
        const result = await page.evaluate(async ({transfer, fullRange}) => {
          const w = 17, h = 3;
          const cw = Math.ceil(w/2), ch = Math.ceil(h/2);
          const planes = new Uint16Array(w*h + 2*cw*ch).fill(512);
          for (let i = 0; i < w*h; i++) planes[i] = i % w < 10 ? 800 + i % w : (fullRange ? 242 : 271);
          for (let i = 0; i < cw*ch; i++) {
            if (i % cw < 6) continue;
            planes[w*h + i] = fullRange ? 383 : 399;
            planes[w*h + cw*ch + i] = fullRange ? 972 : 915;
          }
          const frame = new VideoFrame(planes, {format: "I420P10", codedWidth: w, codedHeight: h, timestamp: 0,
            colorSpace: {primaries: "bt2020", transfer, matrix: "bt2020-ncl", fullRange}});
          const device = await (await navigator.gpu.requestAdapter()).requestDevice();
          const canvas = document.querySelector("canvas");
          canvas.width = w;
          canvas.height = h;
          const context = canvas.getContext("webgpu");
          const detected = kittyVideoColorSpace(frame);
          try {
            const io = kittyConfigureCanvas(context, device, detected, GPUTextureUsage.COPY_SRC | GPUTextureUsage.RENDER_ATTACHMENT);
            const source = device.createTexture({size: [w,h], format: "rgba16float",
              usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING});
            const readback = device.createBuffer({size: 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ});
            let failure;
            await io.capture(frame, buffer => {
              const encoder = device.createCommandEncoder();
              io.unpack(encoder, buffer, source);
              io.present(encoder, source);
              encoder.copyTextureToBuffer({texture: context.getCurrentTexture()}, {buffer: readback, bytesPerRow: 256}, [w,1]);
              device.queue.submit([encoder.finish()]);
            }, error => { failure = error; });
            if (failure) throw failure;
            await readback.mapAsync(GPUMapMode.READ);
            const row = new Float16Array(readback.getMappedRange());
            return {detected, values: Array.from({length: 9}, (_, x) => row[4*x]),
              color: Array.from(row.slice(4*(w-1), 4*(w-1) + 3))};
          } finally {
            frame.close();
            context.unconfigure();
            device.destroy();
          }
        }, {transfer, fullRange});
        assert.equal(result.detected, transfer);
        function luminance(signal) {
          const p = signal ** (32/2523);
          const scene = signal <= 0.5 ? signal**2/3 : (Math.exp((signal - 0.55991073)/0.17883277) + 0.28466892)/12;
          return transfer === "hlg" ? scene :
            10000 * ((p - 3424/4096) / (2413/128 - 2392/128*p)) ** (16384/2610);
        }
        for (const [x, value] of result.values.entries()) {
          const signal = (800 + x - (fullRange ? 0 : 64)) / (fullRange ? 1023 : 876);
          const light = luminance(signal);
          const nits = transfer === "hlg" ? 1000 * light ** 1.2 : light;
          const expected = 1.055 * (nits / 203) ** (1/2.4) - 0.055;
          assert.ok(value > 1 && Math.abs(value - expected) < 0.012, `${transfer}: ${value} vs ${expected}`);
          if (x) assert.ok(value > result.values[x-1], `${transfer}: collapsed 10-bit step ${x}`);
        }
        // A BT.2020 red outside Display P3 retains both extended and negative channels.
        assert.ok(result.color[0] > 1 && result.color[1] < 0,
          `${transfer}: lost extended gamut in ${result.color}`);
      }
    }
  } finally {
    await browser.close();
  }
});

test("HDR optical flow presents a distinct intermediate frame from eight-bit decoder planes", async () => {
  const browser = await chromium.launch({channel: "chrome"});
  try {
    const page = await browser.newPage();
    await page.route("https://kitty.test/", route => route.fulfill({body: "<main></main>", contentType: "text/html"}));
    await page.goto("https://kitty.test/");
    for (const script of ["color.js", "fidelityfx-shaders.js", "fidelityfx.js"])
      await page.addScriptTag({path: path.resolve(__dirname, "../chrome-extension", script)});
    for (const format of ["NV12", "I420"]) {
      for (const transfer of ["pq", "hlg"]) {
        const colors = await page.evaluate(async ({format, transfer}) => {
          const w = 1936, h = 16, pixels = w * h;
          const canvas = document.createElement("canvas");
          const context = canvas.getContext("webgpu");
          const configure = context.configure.bind(context);
          context.configure = options => configure({...options, usage: options.usage | GPUTextureUsage.COPY_SRC});
          const signal = new AbortController();
          let failure;
          const renderer = await createFidelityFxRenderer(canvas, signal.signal, e => { failure = e; }, () => 60, 8, transfer);
          const {device} = context.getConfiguration();
          try {
            for (let i = 0; i < 2; i++) {
              const bytes = new Uint8Array(pixels * 3 / 2).fill(195, 0, pixels);
              // Change a small patch, keeping scene-cut detection out of the way.
              for (let y = 4; y < 12; y++) bytes.fill(195 + 4*i, y*w + 12, y*w + 20);
              const chroma = bytes.subarray(pixels);
              for (let j = 0; j < chroma.length; j++) {
                const isU = format === "NV12" ? j % 2 === 0 : j < pixels / 4;
                chroma[j] = isU ? 124 : 140;
              }
              const frame = new VideoFrame(bytes, {format, codedWidth: w, codedHeight: h, timestamp: i * 40000,
                colorSpace: {primaries: "bt2020", transfer, matrix: "bt2020-ncl", fullRange: false}});
              try {
                if (kittyVideoColorSpace(frame) !== transfer) throw Error("HDR input rejected");
                await renderer.upload({videoWidth: w, videoHeight: h, playbackRate: 1}, i / 25, 25, frame);
                if (failure) throw failure;
              } finally { frame.close(); }
            }
            const colors = [];
            for (const time of [0, 0.02, 0.04]) {
              await device.queue.onSubmittedWorkDone();
              await new Promise(requestAnimationFrame);
              if (!renderer.drawAt(time)) throw Error("Frame missing at " + time);
              const buffer = device.createBuffer({size: 8, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ});
              const encoder = device.createCommandEncoder();
              encoder.copyTextureToBuffer({texture: context.getCurrentTexture(), origin: [16,8]}, {buffer}, [1,1]);
              device.queue.submit([encoder.finish()]);
              await buffer.mapAsync(GPUMapMode.READ);
              colors.push(Array.from(new Float16Array(buffer.getMappedRange()).slice(0, 3)));
              buffer.destroy();
            }
            return colors;
          } finally { signal.abort(); }
        }, {format, transfer});
        const [a, mid, b] = colors;
        assert.ok(a[0] > 1 && a[0] > a[1] && a[0] > a[2], `${format} ${transfer}: ${a}`);
        assert.ok(a[0] < mid[0] && mid[0] < b[0], `${format} ${transfer}: ${a}, ${mid}, ${b}`);
      }
    }
  } finally { await browser.close(); }
});
