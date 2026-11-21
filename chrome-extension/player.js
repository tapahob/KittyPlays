(() => {
  let interpolate = true, preferred = "ai", selected, active;
  let frameLimit = 120;
  let showInfo = true;
  let forceWindowsHdrShadows;
  let initialized = false;
  let fidelityFxLabel;
  const availability = {};
  function save(setting) {
    if (chrome.runtime?.id) chrome.storage.local.set(setting).catch(() => {});
  }
  const toolbar = document.createElement("div");
  toolbar.className = "kittyplays-toolbar kittyplays-glass";
  const controls = document.createElement("div");
  controls.className = "kittyplays-modes";
  controls.setAttribute("role", "group");
  controls.setAttribute("aria-label", "Интерполяция KittyPlays");
  const modeMenu = document.createElement("details");
  modeMenu.className = "kittyplays-limit kittyplays-mode-menu";
  const modeTrigger = document.createElement("summary");
  modeTrigger.className = "kittyplays-gloss";
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
    modeTrigger.replaceChildren(kittyPlaysIcon(mode ?? "original"), label);
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
    button.append(kittyPlaysIcon(value), label);
    button.title = title;
    button.hidden = value === "fidelityfx";
    button.setAttribute("aria-pressed", "false");
    button.addEventListener("click", event => {
      event.stopPropagation();
      if (button.hidden) return;
      modeMenu.open = false;
      modeTrigger.focus();
      if (selected === value && !(value === "original" && interpolate)) return;
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
    for (const button of choices.querySelectorAll("button"))
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
  const infoState = document.createElement("span");
  infoState.className = "kittyplays-info-state";
  infoState.setAttribute("aria-hidden", "true");
  infoButton.append(kittyPlaysIcon("info"), infoState);
  infoButton.title = "Toggle playback statistics";
  infoButton.setAttribute("aria-label", "Playback statistics");
  function updateInfoButton() {
    infoButton.setAttribute("aria-pressed", String(showInfo));
    infoState.textContent = showInfo ? "ON" : "OFF";
  }
  updateInfoButton();
  function setShowInfo(visible) {
    if (showInfo === visible) return;
    showInfo = visible;
    updateInfoButton();
    active?.setInfoVisible(showInfo);
  }
  infoButton.addEventListener("click", () => {
    setShowInfo(!showInfo);
    save({showInfo});
  });
  for (const event of ["click", "keydown", "keyup"])
    toolbar.addEventListener(event, e => e.stopPropagation());
  const infoBar = document.createElement("div");
  infoBar.className = "kittyplays-info-bar";
  infoBar.append(infoButton);
  toolbar.append(controls, infoBar);
  controls.append(modeMenu, limitMenu);
  const sparkle = document.createElement("span");
  sparkle.className = "kittyplays-star kittyplays-toolbar-star";
  sparkle.setAttribute("aria-hidden", "true");
  toolbar.append(sparkle);
  for (const menu of [modeOptions, choices]) {
    const menuStar = sparkle.cloneNode();
    menuStar.className = "kittyplays-star kittyplays-menu-star";
    menu.append(menuStar);
  }
  function attach(video, host, requested, profile, retryConverted) {
    const converted = profile === "converted";
    const matchBt709 = profile === "bt709-on-hdr";
    const colorSpace = converted || matchBt709 ? "srgb" : profile;
    const hdr = colorSpace === "pq" || colorSpace === "hlg";
    let canvas = document.createElement("canvas");
    const hud = document.createElement("div");
    canvas.className = "kittyplays-surface";
    canvas.hidden = true;
    hud.className = "kittyplays-fps kittyplays-glass";
    hud.hidden = !showInfo;
    hud.setAttribute("role", "group");
    hud.setAttribute("aria-label", "KittyPlays playback statistics");
    const ribbon = document.createElement("span");
    ribbon.className = "kittyplays-ribbon";
    ribbon.setAttribute("aria-hidden", "true");
    const watermark = kittyPlaysIcon("paw");
    watermark.classList.add("kittyplays-fps-paw");
    const statsStar = sparkle.cloneNode();
    statsStar.className = "kittyplays-star kittyplays-fps-star";
    const statsMote = statsStar.cloneNode();
    statsMote.classList.add("kittyplays-fps-mote");
    hud.append(ribbon, watermark, statsStar, statsMote);
    const metrics = new Map();
    for (const [key, icon] of [
      ["fps", requested], ["gpu", "fidelityfx"], ["memory", "memory"], ["thread", "flow"],
      ["resolution", "screen"], ["interval", "clock"], ["busy", "warning"], ["drops", "original"],
      ["error", "warning"],
    ]) {
      const row = document.createElement("div");
      row.className = "kittyplays-fps-row";
      row.hidden = true;
      const text = document.createElement("span");
      row.append(kittyPlaysIcon(icon), text);
      hud.append(row);
      metrics.set(key, {row, text});
    }
    const headline = document.createTextNode("");
    const sourceRate = document.createTextNode("");
    const outputRate = document.createElement("strong");
    metrics.get("fps").text.append(headline, sourceRate, " / ", outputRate);
    const displayFilter = matchBt709 ? kittyBt709DisplayFilter() : null;
    if (displayFilter) {
      host.append(displayFilter);
      canvas.style.filter = `url("#${displayFilter.firstElementChild.id}")`;
    }
    video.after(canvas);
    host.append(hud);
    let renderer, raf, previous, latest, sourceFps, issue;
    const modeName = modeButtons.get(requested).textContent;
    let mode = "Loading " + modeName;
    let disposed = false, fallback = false;
    let fallbackAvailable;
    let output = 0, started = performance.now(), next = 0;
    let browserMs = 0;
    const drawIntervals = [];
    let lastDraw;
    let lastVideoSample;
    const events = new AbortController();
    function setMetric(key, content) {
      const {row, text} = metrics.get(key);
      if (text.textContent !== content) text.textContent = content;
      row.hidden = !content;
    }
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
      const setText = (node, value) => { if (node.textContent !== value) node.textContent = value; };
      metrics.get("fps").row.hidden = false;
      setText(headline, mode + (converted ? " · SDR output" : hdr ? " · HDR" : "") + " · FPS ");
      setText(sourceRate, sourceFps ? String(Math.round(sourceFps)) : "—");
      setText(outputRate, String(fps));
      const load = (label, value) => Number.isFinite(value) ? label + " ≈" + Math.round(value) + "%" : "";
      const memory = (label, bytes) => Number.isFinite(bytes) ? label + " ≈" + Math.round(bytes / 1048576) + " MiB" : "";
      setMetric("gpu", load("GPU", stats?.gpu));
      setMetric("memory", memory("GPU memory", stats?.bytes));
      setMetric("thread", load("Chrome thread", browserLoad));
      setMetric("resolution", stats?.resolution?.join(" × ") ?? "");
      let interval = "";
      if (drawIntervals.length) {
        drawIntervals.sort((a, b) => a - b);
        interval = "Frame interval p95 " + Math.round(drawIntervals[Math.ceil(0.95 * drawIntervals.length) - 1]) + " ms";
        drawIntervals.length = 0;
      }
      setMetric("interval", interval);
      setMetric("busy", stats?.resolution && elapsed > 0 && Number.isFinite(stats.dropped)
        ? "Dropped while busy " + (stats.dropped * 1000 / elapsed).toFixed(1) + "/s" : "");
      setMetric("drops", Number.isFinite(videoDrops) ? "Chrome video drops " + videoDrops.toFixed(1) + "/s" : "");
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
      for (const {row} of metrics.values()) row.hidden = true;
      setMetric("error", "KittyPlays · " + message);
    }
    function failCapture() {
      if (hdr) { retryConverted(); return; }
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
    function capture(frame, decoded) {
      if (disposed || issue || !renderer || video.paused || video.seeking || document.hidden || !video.videoWidth) return;
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
        renderer.upload(video,frame.mediaTime,sourceFps,decoded);
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
        let presented;
        try { presented = renderer.drawAt(playhead - delay); }
        catch { failCapture(); return; }
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
      if (document.hidden || raf !== undefined) return;
      raf = requestAnimationFrame(render);
    }
    function stop() {
      if (raf !== undefined) cancelAnimationFrame(raf);
      raf = undefined;
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
      if (hdr) { retryConverted(); return; }
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
      mode = modeButtons.get("flow").textContent;
      metrics.get("fps").row.firstChild.replaceWith(kittyPlaysIcon("flow"));
      reset();
      try { renderer = kittyRenderer(canvas, failCapture, isWindows); start(); }
      catch { select(undefined); fail("Ускорение WebGL 2 недоступно"); }
    }
    select(requested);
    if (colorSpace === "protected") {
      select("original");
      fail("Защищённое видео");
    } else if (requested === "fidelityfx" || (requested === "flow" && hdr)) {
      // Use the WebGPU optical-flow estimator when presenting HDR. The WebGL
      // drawing buffer used by Optical Flow on SDR sources is eight-bit.
      const button = modeButtons.get(requested);
      const title = button.title;
      function fallbackFromFidelityFx(error) {
        if (disposed || !contextAlive()) return;
        if (!hdr) button.title = error.message;
        startFlow(error);
      }
      createFidelityFxRenderer(canvas, events.signal, fallbackFromFidelityFx, () => frameLimit, 8, colorSpace).then(fidelityFx => {
        if (disposed || issue || fallback || !contextAlive()) { fidelityFx.dispose(); return; }
        renderer = fidelityFx;
        mode = modeName;
        button.title = title;
        reset(); start();
      }).catch(fallbackFromFidelityFx);
    } else if (requested === "flow") startFlow();
    else kittyNeuralRenderer(canvas,startFlow,requested === "hybrid",colorSpace).then(neural => {
      if (disposed || issue || fallback || !contextAlive()) { neural.dispose(); return; }
      renderer = neural;
      mode = modeName;
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
      displayFilter?.remove();
      hud.remove();
    }
    return {capture, dispose, get needsRestart() {
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
  // YouTube can switch transfer functions without changing the video element
  // or its resolution. Check metadata before feeding each frame to a renderer.
  function watchColor(video, host, requested) {
    let playback, colorSpace, converted = false;
    const display = matchMedia("(dynamic-range: high)");
    const videoDisplay = matchMedia("(video-dynamic-range: high)");
    function capture(_, frame) {
      if (!contextAlive()) return;
      callback = video.requestVideoFrameCallback(capture);
      if (document.hidden || video.seeking || !video.videoWidth) return;
      let decoded, next = video.mediaKeys ? "protected" : "srgb";
      if (!video.mediaKeys) {
        try {
          decoded = new VideoFrame(video);
          next = kittyVideoColorSpace(decoded, {
            hdrCanvas: display.matches,
            matchBt709: isWindows && (display.matches || videoDisplay.matches || forceWindowsHdrShadows),
          });
        }
        catch { /* The regular renderer can still try importing the video element. */ }
      }
      try {
        if (next !== colorSpace) {
          playback?.dispose();
          playback = undefined;
          colorSpace = next;
          converted = false;
        }
        playback ??= attach(video, host, requested, converted ? "converted" : colorSpace, () => {
          // Retry this same mode with browser-converted frames. Keep this
          // decision until the source profile or display capability changes.
          converted = true;
          playback?.dispose();
          playback = undefined;
        });
        playback.capture(frame, decoded);
      } finally {
        decoded?.close();
      }
    }
    select(requested);
    let callback = video.requestVideoFrameCallback(capture);
    return {video, requested, get needsRestart() { return playback?.needsRestart; },
      setInfoVisible(visible) { playback?.setInfoVisible(visible); },
      dispose() {
        video.cancelVideoFrameCallback(callback);
        playback?.dispose();
      }
    };
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
    else if (!active) active = watchColor(video, host, requested);
  }
  // YouTube reuses the document and may replace the video after navigation.
  let scheduled = false;
  const observer = new MutationObserver(() => {
    if (availability.extensionEnabled === false || scheduled ||
      (controls.isConnected && active?.video.isConnected && location.pathname === "/watch")) return;
    scheduled = true;
    requestAnimationFrame(() => { scheduled = false; sync(); });
  });
  let receivedInfoChange = false;
  function onSettingsChange(changes) {
    if (Object.hasOwn(changes, "forceWindowsHdrShadows"))
      forceWindowsHdrShadows = changes.forceWindowsHdrShadows.newValue === true;
    if (Object.hasOwn(changes, "showInfo")) {
      receivedInfoChange = true;
      setShowInfo(changes.showInfo.newValue !== false);
    }
    const keys = kittyPlaysAvailabilityKeys.filter(key => Object.hasOwn(changes, key));
    if (!keys.length) return;
    for (const key of keys) availability[key] = changes[key].newValue;
    if (!initialized) return;
    updateModeVisibility();
    sync();
  }
  chrome.storage.local.onChanged.addListener(onSettingsChange);
  Promise.all([
    chrome.storage.local.get([...kittyPlaysAvailabilityKeys, "enabled", "preferred", "rate", "showInfo", "forceWindowsHdrShadows"]).catch(() => ({})),
    detectKittyPlaysGraphics().catch(() => ({})),
  ]).then(([saved, graphics]) => {
    const {nvidia, appleM1} = graphics;
    fidelityFxLabel = graphics.fidelityFxLabel;
    if (fidelityFxLabel)
      modeButtons.get("fidelityfx").replaceChildren(kittyPlaysIcon("fidelityfx"), fidelityFxLabel);
    for (const key of kittyPlaysAvailabilityKeys) {
      if (!Object.hasOwn(availability, key)) availability[key] = saved[key];
    }
    updateModeVisibility();
    if (typeof saved.enabled === "boolean") interpolate = saved.enabled;
    if (isModeAvailable("fidelityfx")) preferred = "fidelityfx";
    if (appleM1) preferred = "flow";
    if (saved.preferred !== "original" && modeButtons.has(saved.preferred) && supportsMode(saved.preferred))
      preferred = saved.preferred;
    if (saved.preferred === "vfg" || saved.preferred === "fruc") {
      if (nvidia) preferred = "fidelityfx";
      save({preferred});
    }
    if (["60", "120", "Max"].includes(saved.rate)) showRate(saved.rate);
    if (!receivedInfoChange) setShowInfo(saved.showInfo !== false);
    forceWindowsHdrShadows ??= saved.forceWindowsHdrShadows === true;
  }).catch(() => {}).finally(() => {
    if (!contextAlive()) return;
    initialized = true;
    observer.observe(document.documentElement, {childList: true, subtree: true});
    document.addEventListener("yt-navigate-finish", sync);
    sync();
  });
})();
