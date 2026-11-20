(() => {
  let interpolate = true, preferred = "ai", selected, active;
  let frameLimit = 120;
  let showInfo = true;
  let fidelityFxMultiplier = 2;
  let initialized = false;
  let fidelityFxLabel;
  const availability = {};
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

  const isWindows = /^win/i.test(kittyPlaysPlatform);
  const modeButtons = new Map();
  const supportsMode = mode => mode !== "fidelityfx" || Boolean(fidelityFxLabel);
  const isModeAvailable = mode => supportsMode(mode) && availability[kittyPlaysModeKey(mode)] !== false;
  function updateModeVisibility() {
    for (const [mode, button] of modeButtons)
      button.hidden = mode !== "original" && !isModeAvailable(mode);
  }

  function select(mode) {
    const label = modeButtons.get(mode)?.textContent ?? "Mode";
    if (selected === mode && modeTrigger.textContent === label) return;
    selected = mode;
    for (const [value, button] of modeButtons)
      button.setAttribute("aria-pressed", String(value === mode));
    modeTrigger.textContent = label;
    modeTrigger.setAttribute("aria-label", "Playback mode, " + label);
  }
  for (const [value, label, title] of [
    ...kittyPlaysModes,
    ["original", "Original", "Play the original video without interpolation"],
  ]) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "kittyplays-mode";
    button.value = value;
    button.textContent = label;
    button.title = title;
    button.hidden = value === "fidelityfx";
    button.setAttribute("aria-pressed", "false");
    button.addEventListener("click", event => {
      event.stopPropagation();
      if (button.hidden) return;
      modeMenu.open = false;
      modeTrigger.focus();
      if (selected === value) return;
      interpolate = value !== "original";
      if (interpolate) {
        preferred = value;
        save({enabled: interpolate, preferred});
      } else save({enabled: interpolate});
      active?.dispose();
      active = undefined;
      sync();
    });
    modeButtons.set(value, button);
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
  function attach(video, host, requested) {
    let canvas = document.createElement("canvas");
    const hud = document.createElement("span");
    canvas.className = "kittyplays-surface";
    canvas.hidden = true;
    hud.className = "kittyplays-fps";
    hud.hidden = !showInfo;
    video.after(canvas);
    host.append(hud);
    let renderer, raf, callback, previous, latest, sourceFps, issue;
    let mode = requested === "fidelityfx" ? "Loading FidelityFX (WebGPU)" : "Загрузка нейросети";
    let disposed = false, fallback = false;
    let fallbackAvailable;
    let output = 0, started = performance.now(), next = 0;
    let browserMs = 0;
    const drawIntervals = [];
    let lastDraw;
    let lastVideoSample;
    const events = new AbortController();
    function updateHud(fps, elapsed) {
      const stats = renderer?.resources?.(elapsed, showInfo);
      const browserLoad = elapsed > 0 ? Math.min(100, 100 * (browserMs + (stats?.browserMs || 0)) / elapsed) : null;
      browserMs = 0;
      if (!showInfo) return;
      const quality = video.getVideoPlaybackQuality?.();
      let videoDrops;
      if (quality && lastVideoSample) {
        const seconds = (quality.creationTime - lastVideoSample.creationTime) / 1000;
        const frames = quality.totalVideoFrames - lastVideoSample.totalVideoFrames;
        const drops = quality.droppedVideoFrames - lastVideoSample.droppedVideoFrames;
        if (seconds > 0 && frames >= drops && drops >= 0) {
          videoDrops = drops / seconds;
          if (stats?.passthrough) fps = Math.round((frames - drops) / seconds);
        }
      }
      lastVideoSample = quality;
      const lines = [mode + " · FPS " + (sourceFps ? Math.round(sourceFps) : "—") + " / " + fps];
      const load = (label, value) => Number.isFinite(value) ? label + " ≈" + Math.round(value) + "%" : "";
      const memory = (label, bytes) => Number.isFinite(bytes) ? label + " ≈" + Math.round(bytes / 1048576) + " МиБ" : "";
      const add = (...items) => { if (items.some(Boolean)) lines.push(items.filter(Boolean).join(" · ")); };
      add(load("GPU", stats?.gpu), memory("Видеопамять", stats?.bytes));
      add(load("Поток Chrome", browserLoad));
      add(stats?.resolution?.join(" × "));
      if (drawIntervals.length) {
        drawIntervals.sort((a, b) => a - b);
        add("Интервал отрисовки p95 " + Math.round(drawIntervals[Math.ceil(0.95 * drawIntervals.length) - 1]) + " мс");
        drawIntervals.length = 0;
      }
      if (stats?.resolution && elapsed > 0 && Number.isFinite(stats.dropped))
        add("Пропуски при занятости " + (stats.dropped * 1000 / elapsed).toFixed(1) + "/с");
      if (Number.isFinite(videoDrops)) add("Пропуски видео Chrome " + videoDrops.toFixed(1) + "/с");
      hud.textContent = lines.join("\n");
    }
    function reset() {
      lastVideoSample = undefined;
      previous = latest = undefined;
      renderer?.reset();
      next = output = 0;
      drawIntervals.length = 0;
      lastDraw = undefined;
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
        if (presented === null) {
          canvas.hidden = true;
          lastDraw = undefined;
        }
        else if (presented) {
          canvas.hidden = false;
          output++;
          if (showInfo) {
            const drawn = performance.now();
            if (lastDraw !== undefined) drawIntervals.push(drawn - lastDraw);
            lastDraw = drawn;
          }
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
      fallbackAvailable = isModeAvailable("flow");
      if (!fallbackAvailable) {
        dispose();
        select("original");
        return;
      }
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
      try { renderer = kittyRenderer(canvas, failCapture, isWindows); start(); }
      catch { select(undefined); fail("Ускорение WebGL 2 недоступно"); }
    }
    select(requested);
    if (requested === "fidelityfx") {
      const button = modeButtons.get("fidelityfx");
      const title = button.title;
      function fallbackFromFidelityFx(error) {
        if (disposed || !contextAlive()) return;
        button.title = error.message;
        startFlow(error);
      }
      createFidelityFxRenderer(canvas, events.signal, fallbackFromFidelityFx, () => frameLimit, fidelityFxMultiplier).then(fidelityFx => {
        if (disposed || !contextAlive()) { fidelityFx.dispose(); return; }
        renderer = fidelityFx;
        mode = button.textContent;
        button.title = title;
        reset(); start();
      }).catch(fallbackFromFidelityFx);
    } else if (requested === "flow") startFlow();
    else kittyNeuralRenderer(canvas,startFlow,requested === "hybrid").then(neural => {
      if (disposed || fallback || !contextAlive()) { neural.dispose(); return; }
      renderer = neural;
      mode = requested === "hybrid" ? "Hybrid" : "Нейросеть RIFE-student";
      reset(); start();
    }).catch(startFlow);
    function dispose() {
      if (disposed) return;
      disposed = true;
      events.abort();
      size.disconnect();
      style.disconnect();
      stop();
      renderer?.dispose();
      canvas.remove();
      hud.remove();
    }
    return {video, requested, dispose, get needsRestart() {
      return fallback && fallbackAvailable !== isModeAvailable("flow");
    }, setInfoVisible(visible) {
      if (disposed) return;
      lastVideoSample = undefined;
      hud.hidden = !visible;
      drawIntervals.length = 0;
      lastDraw = undefined;
      if (visible && !issue) {
        updateHud(0, 0);
        started = performance.now();
        output = 0;
      }
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
    const extensionEnabled = availability.extensionEnabled !== false;
    const bar = extensionEnabled && watch && host?.querySelector(".ytp-right-controls");
    if (bar && toolbar.parentElement !== bar) bar.prepend(toolbar);
    else if (!bar && toolbar.isConnected) toolbar.remove();
    const requested = extensionEnabled && interpolate && isModeAvailable(preferred) ? preferred : "original";
    const video = requested !== "original" && watch && host?.querySelector("video.html5-main-video");
    if (active && (active.video !== video || active.requested !== requested || active.needsRestart)) {
      active.dispose();
      active = undefined;
    }
    if (!video) select(requested === "original" ? "original" : undefined);
    else if (!active) active = attach(video, host, requested);
  }
  // YouTube reuses the document and may replace the video after navigation.
  let scheduled = false;
  const observer = new MutationObserver(() => {
    if (availability.extensionEnabled === false || scheduled ||
      (controls.isConnected && active?.video.isConnected && location.pathname === "/watch")) return;
    scheduled = true;
    requestAnimationFrame(() => { scheduled = false; sync(); });
  });
  function onAvailabilityChange(changes) {
    const keys = kittyPlaysAvailabilityKeys.filter(key => Object.hasOwn(changes, key));
    if (!keys.length) return;
    for (const key of keys) availability[key] = changes[key].newValue;
    if (!initialized) return;
    updateModeVisibility();
    sync();
  }
  chrome.storage.local.onChanged.addListener(onAvailabilityChange);
  Promise.all([
    chrome.storage.local.get([...kittyPlaysAvailabilityKeys, "enabled", "preferred", "rate", "showInfo"]).catch(() => ({})),
    detectKittyPlaysGraphics().catch(() => ({})),
  ]).then(([saved, graphics]) => {
    const {amd, nvidia, appleM1} = graphics;
    fidelityFxLabel = graphics.fidelityFxLabel;
    if (fidelityFxLabel) modeButtons.get("fidelityfx").textContent = fidelityFxLabel;
    if (nvidia) {
      fidelityFxMultiplier = 8;
      modeButtons.get("fidelityfx").title = "Generate frames in Chrome at source resolution up to the selected FPS";
    }
    for (const key of kittyPlaysAvailabilityKeys) {
      if (!Object.hasOwn(availability, key)) availability[key] = saved[key];
    }
    updateModeVisibility();
    if (typeof saved.enabled === "boolean") interpolate = saved.enabled;
    if (amd && !isWindows) preferred = "fidelityfx";
    if (appleM1) preferred = "flow";
    if (saved.preferred !== "original" && modeButtons.has(saved.preferred) && supportsMode(saved.preferred))
      preferred = saved.preferred;
    if (saved.preferred === "vfg" || saved.preferred === "fruc") {
      if (nvidia) preferred = "fidelityfx";
      save({preferred});
    }
    if (["60", "120", "Max"].includes(saved.rate)) showRate(saved.rate);
    if (typeof saved.showInfo === "boolean") showInfo = saved.showInfo;
    infoButton.setAttribute("aria-pressed", String(showInfo));
  }).catch(() => {}).finally(() => {
    if (!contextAlive()) return;
    initialized = true;
    observer.observe(document.documentElement, {childList: true, subtree: true});
    document.addEventListener("yt-navigate-finish", sync);
    sync();
  });
})();
