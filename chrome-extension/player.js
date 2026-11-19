(() => {
  let enabled = true, preferred = "ai", selected, active;
  let frameLimit = 120;
  let showInfo = true;
  function save(setting) {
    if (chrome.runtime?.id) chrome.storage.local.set(setting).catch(() => {});
  }
  const toolbar = document.createElement("div");
  toolbar.className = "kittyplays-toolbar";
  const controls = document.createElement("div");
  controls.className = "kittyplays-modes";
  controls.setAttribute("role", "group");
  controls.setAttribute("aria-label", "Интерполяция KittyPlays");
  const modeMenu = document.createElement("details");
  modeMenu.className = "kittyplays-limit kittyplays-mode-menu";
  const modeTrigger = document.createElement("summary");
  modeTrigger.title = "Playback mode";
  const modeOptions = document.createElement("div");
  modeOptions.className = "kittyplays-limit-options";
  modeOptions.setAttribute("role", "group");
  modeOptions.setAttribute("aria-label", "Playback mode");
  modeMenu.append(modeTrigger, modeOptions);

  const isNvidiaMode = mode => mode === "vfg" || mode === "fruc";
  async function detectGraphics() {
    const isAmd = name => /\b(?:amd|radeon|ati)\b|^0x1002$/i.test(name || "");
    const isNvidia = name => /\bnvidia\b|^0x10de$/i.test(name || "");
    const adapter = await navigator.gpu?.requestAdapter().catch(() => null);
    const info = adapter?.info;
    const names = info && !info.isFallbackAdapter ? [info.vendor, info.description] : [];

    // Try WebGL when WebGPU is unavailable, uses integrated graphics, or
    // doesn't expose a vendor identifier.
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
    return {amd: names.some(isAmd), nvidia: names.some(isNvidia)};
  }

  function select(mode) {
    selected = mode;
    let label = "Mode";
    for (const button of modeOptions.children) {
      const current = button.value === mode;
      button.setAttribute("aria-pressed", String(current));
      if (current) label = button.textContent;
    }
    modeTrigger.textContent = label;
    modeTrigger.setAttribute("aria-label", "Playback mode, " + label);
  }
  for (const [value, label, title] of [
    ["ai", "AI", "Neural frame interpolation"],
    ["flow", "Optical Flow", "Optical flow interpolation"],
    ["hybrid", "Hybrid", "Neural interpolation with local optical flow correction"],
    ["fidelityfx", "AMD FidelityFX", "Double the source frame rate with AMD FidelityFX, up to the selected FPS"],
    ["original", "Original", "Play the original video without interpolation"],
    ["vfg", "NVIDIA VFG", "Generate frames with NVIDIA VFG up to the selected FPS"],
  ]) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "kittyplays-mode";
    button.value = value;
    button.textContent = label;
    button.title = title;
    button.hidden = isNvidiaMode(value) || value === "fidelityfx";
    button.setAttribute("aria-pressed", "false");
    button.addEventListener("click", event => {
      event.stopPropagation();
      if (button.hidden) return;
      modeMenu.open = false;
      modeTrigger.focus();
      if (selected === value) return;
      enabled = value !== "original";
      if (enabled) {
        preferred = value;
        save({enabled, preferred});
      } else save({enabled});
      active?.dispose();
      active = undefined;
      sync();
    });
    modeOptions.append(button);
  }
  select(preferred);
  const limitMenu = document.createElement("details");
  limitMenu.className = "kittyplays-limit";
  const trigger = document.createElement("summary");
  trigger.title = "Frame rate limit";
  const choices = document.createElement("div");
  choices.className = "kittyplays-limit-options";
  choices.setAttribute("role", "group");
  choices.setAttribute("aria-label", "Frame rate limit");
  function createCatIcon(rate) {
    const icon = document.createElement("img");
    icon.className = "kittyplays-cat";
    icon.alt = "";
    icon.draggable = false;
    icon.dataset.rate = rate;
    if (icons[rate]) icon.src = icons[rate];
    return icon;
  }
  function showRate(rate) {
    frameLimit = rate === "Max" ? 0 : Number(rate);
    trigger.replaceChildren(createCatIcon(rate), rate);
    trigger.setAttribute("aria-label", "Frame rate limit, " + rate);
    for (const button of choices.children)
      button.setAttribute("aria-pressed", String(button.value === rate));
  }
  const icons = {};
  for (const [rate, title] of [
    ["60", "Limit interpolation to 60 FPS"],
    ["120", "Limit interpolation to 120 FPS"],
    ["Max", "Follow the browser's display refresh rate"],
  ]) {
    const option = document.createElement("button");
    option.type = "button";
    option.value = rate;
    option.title = title;
    option.append(createCatIcon(rate), rate);
    option.addEventListener("click", () => {
      showRate(rate);
      save({rate});
      limitMenu.open = false;
      trigger.focus();
    });
    choices.append(option);
  }
  showRate("120");
  chrome.runtime.sendMessage({type: "kittyplays-load-icons"}).then(loaded => {
    for (const rate of ["60", "120", "Max"]) {
      if (loaded?.[rate]) icons[rate] = loaded[rate];
    }
    for (const icon of limitMenu.querySelectorAll(".kittyplays-cat")) {
      if (icons[icon.dataset.rate]) icon.src = icons[icon.dataset.rate];
    }
  }).catch(() => {});
  limitMenu.append(trigger, choices);
  for (const [menu, summary] of [[modeMenu, modeTrigger], [limitMenu, trigger]]) {
    menu.addEventListener("focusout", event => {
      if (!menu.contains(event.relatedTarget)) menu.open = false;
    });
    menu.addEventListener("keydown", event => {
      if (event.key === "Escape" && menu.open) {
        event.preventDefault();
        menu.open = false;
        summary.focus();
      }
    });
  }
  const infoButton = document.createElement("button");
  infoButton.type = "button";
  infoButton.textContent = "Info";
  infoButton.title = "Toggle playback statistics";
  infoButton.setAttribute("aria-pressed", String(showInfo));
  infoButton.addEventListener("click", () => {
    showInfo = !showInfo;
    infoButton.setAttribute("aria-pressed", String(showInfo));
    active?.setInfoVisible(showInfo);
    save({showInfo});
  });
  for (const event of ["click", "keydown", "keyup"])
    toolbar.addEventListener(event, e => e.stopPropagation());
  const infoBar = document.createElement("div");
  infoBar.className = "kittyplays-info-bar";
  infoBar.append(infoButton);
  toolbar.append(controls, infoBar);
  controls.append(modeMenu, limitMenu);
  const sparkles = document.createElement("span");
  sparkles.className = "kittyplays-sparkles";
  sparkles.setAttribute("aria-hidden", "true");
  controls.append(sparkles);
  function attach(video, host) {
    let canvas = document.createElement("canvas");
    const hud = document.createElement("span");
    canvas.className = "kittyplays-surface";
    canvas.hidden = true;
    hud.className = "kittyplays-fps";
    hud.hidden = !showInfo;
    video.after(canvas);
    host.append(hud);
    let renderer, raf, callback, previous, latest, sourceFps, issue;
    const requested = preferred;
    let mode = requested === "fidelityfx" ? "Connecting to AMD FidelityFX" :
      requested === "vfg" ? "Connecting to NVIDIA VFG" : "Загрузка нейросети";
    let disposed = false, fallback = false;
    let output = 0, started = performance.now(), next = 0;
    let browserMs = 0;
    const events = new AbortController();
    function updateHud(fps, elapsed) {
      const stats = renderer?.resources?.(elapsed, showInfo);
      const browserLoad = elapsed > 0 ? Math.min(100, 100 * (browserMs + (stats?.browserMs || 0)) / elapsed) : null;
      browserMs = 0;
      if (!showInfo) return;
      if (stats?.passthrough && sourceFps) fps = Math.round(sourceFps * video.playbackRate);
      const lines = [mode + " · FPS " + (sourceFps ? Math.round(sourceFps) : "—") + " / " + fps];
      const load = (label, value) => Number.isFinite(value) ? label + " ≈" + Math.round(value) + "%" : "";
      const memory = (label, bytes) => Number.isFinite(bytes) ? label + " ≈" + Math.round(bytes / 1048576) + " МиБ" : "";
      const add = (...items) => { if (items.some(Boolean)) lines.push(items.filter(Boolean).join(" · ")); };
      add(load("GPU", stats?.gpu), memory(stats?.frameBuffers ? "Видеопамять кадров" : "Видеопамять", stats?.bytes));
      add(load("Поток Chrome", browserLoad), load("ЦП хоста", stats?.hostCpu));
      add(memory("Кадры в ОЗУ Chrome", stats?.ramBytes),
        Number.isFinite(stats?.roundTripMs) ? "Обмен с хостом " + Math.round(stats.roundTripMs) + " мс" : "");
      hud.textContent = lines.join("\n");
    }
    function reset() {
      previous = latest = undefined;
      renderer?.reset();
      next = output = 0;
      started = performance.now();
      canvas.hidden = true;
      if (!issue) updateHud(0, 0);
    }
    function layout() {
      Object.assign(canvas.style, {width: video.offsetWidth + "px", height: video.offsetHeight + "px",
        left: video.offsetLeft + "px", top: video.offsetTop + "px",
        objectFit: getComputedStyle(video).objectFit});
    }
    function fail(message) {
      issue = message;
      canvas.hidden = true;
      hud.textContent = "KittyPlays · " + message;
    }
    function failCapture() {
      fail("Браузер закрыл доступ к кадрам");
    }
    const size = new ResizeObserver(layout);
    size.observe(video);
    const style = new MutationObserver(layout);
    style.observe(video, {attributes: true, attributeFilter: ["style", "class"]});
    video.addEventListener("emptied", () => { sourceFps = undefined; reset(); }, {signal: events.signal});
    for (const event of ["seeking", "pause", "waiting", "ratechange"]) {
      video.addEventListener(event, reset, {signal: events.signal});
    }
    function capture(_, frame) {
      callback = video.requestVideoFrameCallback(capture);
      if (issue || video.paused || video.seeking || document.hidden || !video.videoWidth) return;
      if (video.mediaKeys) { fail("Защищённое видео"); return; }
      try {
        previous = latest;
        latest = frame;
        const gap = previous && frame.mediaTime - previous.mediaTime;
        if (gap > 0 && gap < 0.5) {
          const count = frame.presentedFrames - previous.presentedFrames;
          const sample = count / gap;
          sourceFps = sourceFps ? 0.85 * sourceFps + 0.15 * sample : sample;
        } else previous = undefined;
        if (!previous) renderer.reset();
        const began = showInfo ? performance.now() : null;
        renderer.upload(video,frame.mediaTime,sourceFps);
        if (began !== null) browserMs += performance.now() - began;
      } catch { failCapture(); }
    }
    function render(now) {
      raf = requestAnimationFrame(render);
      if (issue || document.hidden) return;
      renderer.tick?.(now);
      if (issue || !renderer) return;
      // Fixed-rate renderers already schedule individual frames on their own timeline.
      const capped = frameLimit && (!renderer.outputRate || renderer.outputRate > frameLimit * 1.01);
      if (latest && previous && !video.paused && !video.seeking && (!capped || now + 0.2 >= next)) {
        // Keep two decoded intervals of lookahead so repeated source frames
        // can be bridged using the next distinct pose and its real timestamp.
        const playhead = latest.mediaTime + (now-latest.expectedDisplayTime)*video.playbackRate/1000;
        const delay = Math.max((renderer.delay || 0) * video.playbackRate, 2.25 / (sourceFps || 30));
        const began = showInfo ? performance.now() : null;
        const presented = renderer.drawAt(playhead - delay);
        if (began !== null) browserMs += performance.now() - began;
        if (presented === null) canvas.hidden = true;
        else if (presented) {
          canvas.hidden = false;
          output++;
        }
        if (capped) {
          const step = 1000 / frameLimit;
          next = next && now - next < 2 * step ? next + step : now + step;
        } else next = 0;
      }
      const elapsed = now - started;
      if (elapsed >= 1000) {
        if (!contextAlive()) return;
        updateHud(Math.round(output * 1000 / elapsed), elapsed);
        started = now;
        output = 0;
      }
    }
    reset();
    layout();
    function start() {
      if (document.hidden || callback !== undefined) return;
      callback = video.requestVideoFrameCallback(capture);
      raf = requestAnimationFrame(render);
    }
    function stop() {
      if (callback !== undefined) video.cancelVideoFrameCallback(callback);
      if (raf !== undefined) cancelAnimationFrame(raf);
      callback = raf = undefined;
    }
    document.addEventListener("visibilitychange", () => {
      if (!contextAlive()) return;
      stop();
      if (issue) return;
      // A background tab can advance the video without delivering frame callbacks.
      sourceFps = undefined;
      reset();
      if (renderer) start();
    }, {signal: events.signal});
    function startFlow(error) {
      if (disposed || fallback || !contextAlive()) return;
      fallback = true;
      if (error) console.warn("KittyPlays: " + requested + " renderer unavailable", error);
      select("flow");
      stop();
      renderer?.dispose();
      renderer = undefined;
      const replacement = canvas.cloneNode(false);
      canvas.replaceWith(replacement);
      canvas = replacement;
      canvas.addEventListener("webglcontextlost", () => fail("Видеокарта недоступна"), {signal: events.signal});
      mode = "Оптический поток";
      reset();
      try { renderer = kittyRenderer(canvas, failCapture); start(); }
      catch { select(undefined); fail("Ускорение WebGL 2 недоступно"); }
    }
    select(preferred);
    if (requested === "fidelityfx") {
      const button = modeOptions.querySelector('[value="fidelityfx"]');
      const title = button.title;
      function fallbackFromFidelityFx(error) {
        if (disposed || !contextAlive()) return;
        button.title = /not found/i.test(error.message)
          ? "Install the local AMD FidelityFX helper" : error.message;
        startFlow(error);
      }
      createFidelityFxRenderer(canvas, events.signal, fallbackFromFidelityFx, () => frameLimit).then(nativeRenderer => {
        if (disposed || !contextAlive()) { nativeRenderer.dispose(); return; }
        renderer = nativeRenderer;
        mode = "AMD FidelityFX";
        button.title = title;
        reset(); start();
      }).catch(fallbackFromFidelityFx);
    } else if (requested === "vfg") {
      const controller = new AbortController();
      events.signal.addEventListener("abort", () => controller.abort(), {once: true});
      function failed(error) {
        if (disposed || !contextAlive()) return;
        stop();
        renderer?.dispose();
        renderer = undefined;
        select(undefined);
        fail(error.message);
        const button = controls.querySelector('[value="vfg"]');
        button.title = error.message;
      }
      createVfgRenderer(canvas, controller.signal, failed, () => frameLimit).then(vfg => {
        if (disposed || !contextAlive()) { vfg.dispose(); return; }
        renderer = vfg;
        mode = "NVIDIA VFG";
        controls.querySelector('[value="vfg"]').title = "Generate frames with NVIDIA VFG up to the selected FPS";
        reset(); start();
      }).catch(failed);
    } else if (preferred === "flow") startFlow();
    else kittyNeuralRenderer(canvas,startFlow,preferred === "hybrid").then(neural => {
      if (disposed || fallback || !contextAlive()) { neural.dispose(); return; }
      renderer = neural;
      mode = preferred === "hybrid" ? "Hybrid" : "Нейросеть RIFE-student";
      reset(); start();
    }).catch(startFlow);
    return {video, setInfoVisible(visible) {
      hud.hidden = !visible;
      if (visible && !issue) {
        updateHud(0, 0);
        started = performance.now();
        output = 0;
      }
    }, dispose() {
      disposed = true;
      events.abort();
      size.disconnect();
      style.disconnect();
      stop();
      renderer?.dispose();
      canvas.remove();
      hud.remove();
    }};
  }
  function contextAlive() {
    if (chrome.runtime?.id) return true;
    observer.disconnect();
    document.removeEventListener("yt-navigate-finish", sync);
    active?.dispose();
    active = undefined;
    toolbar.remove();
    return false;
  }
  function sync() {
    if (!contextAlive()) return;
    const host = document.querySelector("#movie_player");
    const watch = location.pathname === "/watch";
    const bar = watch && host?.querySelector(".ytp-right-controls");
    if (bar && toolbar.parentElement !== bar) bar.prepend(toolbar);
    else if (!bar && toolbar.isConnected) toolbar.remove();
    const video = enabled && watch && host?.querySelector("video.html5-main-video");
    if (active && active.video !== video) { active.dispose(); active = undefined; }
    if (!video) select(enabled ? undefined : "original");
    if (video && !active) active = attach(video, host);
  }
  // YouTube reuses the document and may replace the video after navigation.
  let scheduled = false;
  const observer = new MutationObserver(() => {
    if (scheduled || (controls.isConnected && active?.video.isConnected && location.pathname === "/watch")) return;
    scheduled = true;
    requestAnimationFrame(() => { scheduled = false; sync(); });
  });
  chrome.runtime.onMessage.addListener(message => {
    if (message.type === "kittyplays-toggle") {
      enabled = !enabled;
      save({enabled});
      sync();
    }
  });
  Promise.all([
    chrome.storage.local.get(["enabled", "preferred", "rate", "showInfo"]).catch(() => ({})),
    detectGraphics().catch(() => ({})),
  ]).then(([saved, {amd, nvidia}]) => {
    if (typeof saved.enabled === "boolean") enabled = saved.enabled;
    if (amd) preferred = "fidelityfx";
    for (const button of modeOptions.children) {
      if (isNvidiaMode(button.value)) button.hidden = !nvidia;
      if (button.value === "fidelityfx") button.hidden = !amd;
      if (!button.hidden && button.value === saved.preferred && button.value !== "original") preferred = button.value;
    }
    if (["60", "120", "Max"].includes(saved.rate)) showRate(saved.rate);
    if (typeof saved.showInfo === "boolean") showInfo = saved.showInfo;
    infoButton.setAttribute("aria-pressed", String(showInfo));
  }).catch(() => {}).finally(() => {
    if (!contextAlive()) return;
    observer.observe(document.documentElement, {childList: true, subtree: true});
    document.addEventListener("yt-navigate-finish", sync);
    sync();
  });
})();
