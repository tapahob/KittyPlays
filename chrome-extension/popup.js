(() => {
  const modes = document.querySelector("#modes");
  const status = document.querySelector("#status");
  const switches = new Map([
    ["extensionEnabled", document.querySelector("#enabled")],
    ["showInfo", document.querySelector("#show-info")],
  ]);
  const settings = {};
  if (/^win/i.test(kittyPlaysPlatform)) {
    const shadows = document.querySelector("#windows-hdr-shadows");
    shadows.closest("label").hidden = false;
    switches.set("forceWindowsHdrShadows", shadows);
  }

  for (const slot of document.querySelectorAll("[data-icon]"))
    slot.append(kittyPlaysIcon(slot.dataset.icon));
  document.querySelector("#version").textContent = "Version " + chrome.runtime.getManifest().version;
  for (const [mode, label, title] of kittyPlaysModes) {
    const row = document.createElement("label");
    row.className = "setting";
    row.title = title;
    row.hidden = mode === "fidelityfx";
    const name = document.createElement("span");
    name.textContent = label;
    const input = document.createElement("input");
    input.type = "checkbox";
    input.setAttribute("role", "switch");
    input.disabled = true;
    row.append(kittyPlaysIcon(mode), name, input);
    modes.append(row);
    switches.set(kittyPlaysModeKey(mode), input);

    if (mode === "fidelityfx") {
      detectKittyPlaysGraphics().then(({fidelityFxLabel}) => {
        if (!fidelityFxLabel) return;
        name.textContent = fidelityFxLabel;
        row.hidden = false;
      }).catch(() => {});
    }
  }

  function setChecked(key, value) {
    settings[key] = value;
    switches.get(key).checked = key === "forceWindowsHdrShadows" ? value === true : value !== false;
  }
  chrome.storage.local.onChanged.addListener(changes => {
    for (const key of switches.keys()) {
      if (Object.hasOwn(changes, key)) setChecked(key, changes[key].newValue);
    }
  });

  chrome.storage.local.get([...switches.keys()]).then(saved => {
    for (const [key, input] of switches) {
      if (!Object.hasOwn(settings, key)) setChecked(key, saved[key]);
      input.disabled = false;
      input.addEventListener("change", () => {
        status.hidden = true;
        chrome.storage.local.set({[key]: input.checked}).catch(() => {
          setChecked(key, settings[key]);
          status.textContent = "Could not save settings.";
          status.hidden = false;
        });
      });
    }
  }).catch(() => {
    status.textContent = "Could not load settings.";
    status.hidden = false;
  });
})();
