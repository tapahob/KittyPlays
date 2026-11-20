// Read the packaged files from the extension origin. Chrome extension
// messages use JSON serialization, so encode the binary only during setup.
async function loadModel() {
  async function read(name) {
    const response = await fetch(chrome.runtime.getURL("neural/" + name));
    if (!response.ok) throw new Error("Missing model asset: " + name);
    return response;
  }
  const [data, manifest] = await Promise.all([
    read("rt_tfact2.bin").then(r => r.arrayBuffer()),
    read("rt_tfact2.json").then(r => r.json())
  ]);
  const bytes = new Uint8Array(data);
  // Each non-final chunk is a multiple of three, so only the last has padding.
  const chunks = [];
  for (let offset = 0; offset < bytes.length; offset += 24576) {
    chunks.push(btoa(String.fromCharCode(...bytes.subarray(offset, offset + 24576))));
  }
  return {weights: chunks.join(""), manifest};
}

async function loadIcons() {
  return Object.fromEntries(await Promise.all(["60", "120", "Max"].map(async rate => {
    const response = await fetch(chrome.runtime.getURL("icons/cat-" + rate.toLowerCase() + ".webp"));
    if (!response.ok) throw new Error("Cannot load FPS icon");
    const bytes = new Uint8Array(await response.arrayBuffer());
    return [rate, "data:image/webp;base64," + btoa(String.fromCharCode(...bytes))];
  })));
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id) return;
  const load = message?.type === "kittyplays-load-model" ? loadModel :
    message?.type === "kittyplays-load-icons" ? loadIcons : null;
  if (!load) return;
  load().then(reply, error => reply({error: error.message}));
  return true;
});
