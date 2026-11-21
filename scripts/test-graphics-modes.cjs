const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const scripts = fs.readFileSync(path.join(__dirname, "../chrome-extension/modes.js"), "utf8");

async function detect(platform, gpu, renderer) {
  const canvas = {getContext: () => renderer && {
    getExtension: name => name === "WEBGL_debug_renderer_info" ? {UNMASKED_RENDERER_WEBGL: "renderer"} : null,
    getParameter: parameter => parameter === "renderer" ? renderer : "",
  }};
  return vm.runInNewContext(scripts + "\ndetectKittyPlaysGraphics()", {
    navigator: {platform, gpu}, document: {createElement: () => canvas},
  });
}

test("macOS advertises Metal only for a hardware WebGPU adapter, independent of GPU vendor", async () => {
  for (const vendor of ["apple", "intel", "amd", ""]) {
    const result = await detect("macOS", {requestAdapter: async options => {
      assert.equal(options.powerPreference, "high-performance");
      return {info: {vendor, isFallbackAdapter: false}};
    }}, "ANGLE Metal Renderer: Apple M1");
    assert.equal(result.fidelityFxLabel, "FidelityFX (Metal)");
    assert.equal(result.appleM1, true);
    assert.equal(result.amd, false);
  }
  for (const gpu of [undefined, {requestAdapter: async () => null}, {
    requestAdapter: async () => { throw Error("WebGPU disabled"); },
  }, {requestAdapter: async () => ({info: {isFallbackAdapter: true}})}]) {
    const result = await detect("MacIntel", gpu, "ANGLE Metal Renderer: Apple M1");
    assert.equal(result.fidelityFxLabel, "");
    assert.equal(result.appleM1, true);
  }
});

test("Windows and Linux retain existing FidelityFX labels and vendor detection", async () => {
  const windows = await detect("Windows", {requestAdapter: async options => {
    assert.equal(options, undefined);
    return {info: {vendor: "0x10de", isFallbackAdapter: false}};
  }});
  assert.equal(windows.fidelityFxLabel, "FidelityFX (WebGPU)");
  assert.equal(windows.nvidia, true);
  const linux = await detect("Linux", {requestAdapter: async options => {
    assert.equal(options, undefined);
    return null;
  }}, "AMD Radeon");
  assert.equal(linux.fidelityFxLabel, "AMD FidelityFX");
  assert.equal((await detect("Linux", undefined, "Intel")).fidelityFxLabel, "");
});
