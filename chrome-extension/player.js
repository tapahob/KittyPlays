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
  function select(mode) {
    selected = mode;
    for (const button of controls.querySelectorAll(".kittyplays-mode"))
      button.setAttribute("aria-pressed", String(button.value === mode));
  }
  for (const [value, label, title] of [
    ["ai", "AI", "Neural frame interpolation"],
    ["flow", "Optical Flow", "Optical flow interpolation"],
    ["hybrid", "Hybrid", "Neural interpolation with local optical flow correction"],
    ["original", "Original", "Play the original video without interpolation"],
    ["vfg", "NVIDIA VFG", "Generate frames with NVIDIA VFG up to the selected FPS"],
  ]) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "kittyplays-mode";
    button.value = value;
    button.textContent = label;
    button.title = value === "original" ? title : title + ". Click again to return to Original.";
    button.setAttribute("aria-pressed", "false");
    button.addEventListener("click", event => {
      event.stopPropagation();
      enabled = value !== "original" && selected !== value;
      if (value !== "original") preferred = value;
      save({enabled, preferred});
      active?.dispose();
      active = undefined;
      sync();
    });
    controls.append(button);
  }
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
  limitMenu.addEventListener("focusout", event => {
    if (!limitMenu.contains(event.relatedTarget)) limitMenu.open = false;
  });
  limitMenu.addEventListener("keydown", event => {
    if (event.key === "Escape" && limitMenu.open) {
      event.preventDefault();
      limitMenu.open = false;
      trigger.focus();
    }
  });
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
  controls.append(limitMenu);
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
    let mode = requested === "vfg" ? "Connecting to NVIDIA VFG" : "Загрузка нейросети";
    let disposed = false, fallback = false;
    let output = 0, started = performance.now(), next = 0;
    const events = new AbortController();
    function updateHud(fps, elapsed) {
      const lines = [mode + " · FPS " + (sourceFps ? Math.round(sourceFps) : "—") + " / " + fps];
      const stats = renderer?.resources?.(elapsed);
      if (stats) {
        const gpu = stats.gpu === null ? "—" : "≈" + Math.round(stats.gpu) + "%";
        lines.push("GPU " + gpu + " · Видеопамять ≈" + Math.round(stats.bytes / 1048576) + " МиБ");
      }
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
        renderer.upload(video,frame.mediaTime);
      } catch { fail("Браузер закрыл доступ к кадрам"); }
    }
    function render(now) {
      raf = requestAnimationFrame(render);
      if (issue || document.hidden) return;
      renderer.tick?.(now);
      if (latest && previous && !video.paused && !video.seeking && (!frameLimit || now + 0.2 >= next)) {
        // Keep two decoded intervals of lookahead so repeated source frames
        // can be bridged using the next distinct pose and its real timestamp.
        const playhead = latest.mediaTime + (now-latest.expectedDisplayTime)*video.playbackRate/1000;
        const delay = Math.max((renderer.delay || 0) * video.playbackRate, 2.25 / (sourceFps || 30));
        const presented = renderer.drawAt(playhead - delay);
        if (presented === null) canvas.hidden = true;
        else if (presented) {
          canvas.hidden = false;
          output++;
        }
        if (frameLimit) {
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
      if (error) console.warn("KittyPlays: neural renderer unavailable", error);
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
      try { renderer = kittyRenderer(canvas); start(); }
      catch { select(undefined); fail("Ускорение WebGL 2 недоступно"); }
    }
    select(preferred);
    if (requested === "vfg") {
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
    return {video, setInfoVisible(visible) { hud.hidden = !visible; }, dispose() {
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
  chrome.storage.local.get(["enabled", "preferred", "rate", "showInfo"]).then(saved => {
    if (typeof saved.enabled === "boolean") enabled = saved.enabled;
    if (["ai", "flow", "hybrid", "vfg"].includes(saved.preferred)) preferred = saved.preferred;
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
