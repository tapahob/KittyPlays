const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

async function setup() {
  let announce, socket, now = 0;
  const requests = [], drawn = [], released = [];
  const input = {videoWidth: 2, videoHeight: 2, playbackRate: 1};
  const output = {getContext: () => ({
    putImageData: image => drawn.push(image.data[0]),
    drawImage: frame => drawn.push(frame.color),
  })};
  let color = 0;
  const capture = {getContext: () => ({
    drawImage() {},
    getImageData: () => ({width: 2, height: 2, data: new Uint8ClampedArray(16).fill(color)}),
  })};
  class Socket {
    constructor() { socket = this; }
    send(message) { if (message instanceof Blob) requests.push(message); }
    close() {}
  }
  const context = vm.createContext({
    WebSocket: Socket, Blob, setTimeout, clearTimeout,
    performance: {now: () => now},
    chrome: {runtime: {connect: () => ({
      onMessage: {addListener: fn => { announce = fn; }},
      onDisconnect: {addListener() {}}, disconnect() {},
    })}},
    document: {createElement: () => capture},
    ImageData: class { constructor(data) { this.data = data; } },
    VideoFrame: class {
      constructor() { this.color = color; }
      close() { released.push(this.color); }
    },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../chrome-extension/vfg.js"), "utf8"), context);
  const ready = context.createNvidiaRenderer(output, new AbortController().signal, assert.fail, () => 120, false);
  announce({version: 2, port: 12345, token: "0".repeat(64)});
  socket.onmessage({data: "ready"});
  const renderer = await ready;
  function upload(i, fps = 24) {
    now = i * 1000 / fps;
    color = i;
    renderer.upload(input, i / fps, fps);
  }
  const reply = (bytes, value) => socket.onmessage({data: new Uint8Array(bytes).fill(value).buffer});
  return {renderer, requests, drawn, released, upload, reply};
}

test("a slow host cannot discard originals or rewind the presentation timeline", async () => {
  const {renderer, requests, drawn, released, upload, reply} = await setup();
  try {
    upload(0);
    upload(1);
    upload(2);
    assert.equal(requests.length, 2);
    assert.equal(renderer.resources(1000, true).dropped, 1);
    assert.equal(renderer.drawAt(0), true);
    assert.equal(renderer.drawAt(1 / 24), true);
    reply(0);
    reply(16, 99); // Midpoint arrived after its second original was shown.
    assert.equal(renderer.drawAt(0.5 / 24), false);
    assert.equal(renderer.drawAt(2 / 24), true);
    assert.deepEqual(drawn, [0, 1, 2]);

    upload(3); // Re-prime the host after an unsent input.
    upload(4);
    const factors = await Promise.all(requests.map(async blob => new Uint8Array(await blob.arrayBuffer())[4]));
    assert.deepEqual(factors, [1, 2, 1, 2]);
    reply(0);
    reply(16, 77);
    assert.equal(renderer.drawAt(3.5 / 24), true);
    assert.equal(drawn.at(-1), 77);
    upload(5);
    renderer.reset();
    assert.deepEqual(released, [2]);
    reply(16, 55);
    assert.equal(renderer.drawAt(5 / 24), null);
  } finally { renderer.dispose(); }
});

test("persistent overload rests the host, then resumes only after a healthy probe", async () => {
  const {renderer, requests, upload, reply} = await setup();
  let answered = 0;
  async function answerOne() {
    if (answered === requests.length) return;
    const header = new Uint8Array(await requests[answered++].arrayBuffer());
    reply(16 * (header[4] - 1), 77);
  }
  try {
    for (let i = 0; i < 180; i++) {
      upload(i, 60);
      if (i % 3 === 0) await answerOne();
    }
    const resting = requests.length;
    assert.equal(renderer.resources(1000, true).passthrough, true);
    assert.equal(renderer.drawAt(2.9), null);
    while (answered < resting) await answerOne();
    for (let i = 180; i < 1000; i++) upload(i, 60);
    assert.equal(requests.length, resting);
    for (let i = 1000; i < 1090; i++) {
      upload(i, 60);
      await answerOne();
    }
    assert.ok(requests.length > resting);
    assert.equal(renderer.drawAt(18), null);
    for (let i = 1090; i < 1250; i++) {
      upload(i, 60);
      await answerOne();
    }
    assert.equal(renderer.resources(1000, true).passthrough, false);
    assert.equal(renderer.drawAt(1248.5 / 60), true);
  } finally { renderer.dispose(); }
});
