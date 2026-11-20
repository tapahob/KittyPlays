const kittyPlaysModes = [
  ["ai", "AI", "Neural frame interpolation"],
  ["flow", "Optical Flow", "Optical flow interpolation"],
  ["hybrid", "Hybrid", "Neural interpolation with local optical flow correction"],
  ["fidelityfx", "AMD FidelityFX", "Generate frames in Chrome at source resolution up to the selected FPS"],
];
const kittyPlaysPlatform = navigator.userAgentData?.platform || navigator.platform;
const kittyPlaysModeKey = mode => "modeEnabled." + mode;
const kittyPlaysAvailabilityKeys = ["extensionEnabled", ...kittyPlaysModes.map(([mode]) => kittyPlaysModeKey(mode))];

async function detectKittyPlaysGraphics() {
  const isWindows = /^win/i.test(kittyPlaysPlatform);
  const isMac = /^mac/i.test(kittyPlaysPlatform);
  const isAmd = name => /\b(?:amd|radeon|ati)\b|^(?:0x)?1002$/i.test(name?.trim() || "");
  const isNvidia = name => /\b(?:nvidia|geforce|quadro|tesla)\b|^(?:0x)?10de$/i.test(name?.trim() || "");
  const adapterOptions = isWindows ? {powerPreference: "high-performance"} : undefined;
  const adapter = isMac ? null : await navigator.gpu?.requestAdapter(adapterOptions).catch(() => null);
  const info = adapter?.info;
  const names = info && !info.isFallbackAdapter ? [info.vendor, info.description] : [];

  // WebGL can expose the GPU model even when WebGPU only identifies its vendor.
  const gl = document.createElement("canvas").getContext("webgl2", {powerPreference: "high-performance"});
  if (gl) {
    try {
      const debugInfo = gl.getExtension("WEBGL_debug_renderer_info");
      if (debugInfo) names.push(gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL),
        gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL));
    } finally {
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
  }
  const amd = !isMac && names.some(isAmd);
  const nvidia = !isMac && names.some(isNvidia);
  const appleM1 = isMac && names.some(name => /\bApple M1\b(?!\s+(?:Pro|Max|Ultra)\b)/i.test(name));
  const fidelityFxLabel = nvidia ? "FidelityFX (WebGPU)" : amd ? "AMD FidelityFX" : "";
  return {amd, nvidia, appleM1, fidelityFxLabel};
}
