// Logic and resource-lifecycle checks. These do not emulate a GPU or browser layout.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const elements = new Map();
const events = {};
const documentEvents = {};
const buffers = new Set();
const programs = new Set();
let nextId = 1;
let lastDraw = 0;
const gl = new Proxy({
  createBuffer() {
    const buffer = nextId++;
    buffers.add(buffer);
    return buffer;
  },
  deleteBuffer(buffer) {
    buffers.delete(buffer);
  },
  createProgram() {
    const program = nextId++;
    programs.add(program);
    return program;
  },
  deleteProgram(program) {
    programs.delete(program);
  },
  createShader() { return nextId++; },
  getShaderParameter() { return true; },
  getProgramParameter() { return true; },
  getAttribLocation() { return 0; },
  getUniformLocation() { return 1; },
  drawArrays(mode, first, count) { lastDraw = count; },
}, {
  get(target, key) {
    return key in target ? target[key] : () => {};
  },
});

class Element {
  constructor() {
    this.width = 1;
    this.height = 1;
    this.value = '';
    this.children = [];
    this.events = {};
    this.attributes = {};
    this.style = { setProperty() {} };
    const classes = new Set();
    this.classList = {
      add(...names) { names.forEach(name => classes.add(name)); },
      remove(...names) { names.forEach(name => classes.delete(name)); },
      contains(name) { return classes.has(name); },
    };
  }
  addEventListener(type, callback) { this.events[type] = callback; }
  append(child) { this.children.push(child); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this.attributes[name] = value; }
  removeAttribute(name) { delete this.attributes[name]; }
  focus() {}
  pause() {}
  async play() {}
  click() { this.clicked = true; }
  setPointerCapture() {}
  getBoundingClientRect() { return { left: 0, top: 0, width: 470, height: 400 }; }
  getContext(type) {
    if (type === 'webgl') return gl;
    const element = this;
    return new Proxy({
      createLinearGradient() { return { addColorStop() {} }; },
      createRadialGradient() { return { addColorStop() {} }; },
      drawImage(source) { element.source = source; },
      getImageData() {
        const data = new Uint8ClampedArray(element.width * element.height * 4);
        for (let y = 0; y < element.height; y++) {
          for (let x = 0; x < element.width; x++) {
            const p = (y * element.width + x) * 4;
            data[p] = x / Math.max(1, element.width - 1) * 255;
            data[p + 1] = y / Math.max(1, element.height - 1) * 255;
            data[p + 2] = 128;
            data[p + 3] = element.source?.transparent ? 0 : 255;
          }
        }
        return { data };
      },
    }, { get: (target, key) => key in target ? target[key] : () => {} });
  }
}

function element(id) {
  if (!elements.has(id)) elements.set(id, new Element());
  return elements.get(id);
}
element('#density').value = '240';
element('#depth').value = '55';
const context = vm.createContext({
  console, Math, Float32Array, Uint8ClampedArray, Map, URL,
  document: {
    querySelector: element,
    createElement: () => new Element(),
    body: new Element(),
    hidden: false,
    addEventListener(name, callback) { documentEvents[name] = callback; },
  },
  window: { addEventListener: (name, callback) => { events[name] = callback; } },
  Image: class { constructor() { this.width = 1024; this.height = 576; } async decode() {} },
  PIXEL_EXAMPLE_DATA: ['data:image/jpeg;base64,test'],
  location: { protocol: 'file:' },
  performance: { now: () => 0 },
  matchMedia: () => ({ matches: false }),
  innerWidth: 1440,
  innerHeight: 900,
  devicePixelRatio: 2,
  setTimeout: () => 1,
  clearTimeout() {},
  requestAnimationFrame() {},
});
const run = source => vm.runInContext(source, context);
for (const file of ['renderer.js', 'cosmos.js', 'image-space.js', 'sound.js', 'hand-control.js', 'script.js']) {
  run(fs.readFileSync(path.join(root, file), 'utf8'));
}

(async () => {
  await run('examplesReady');
  assert.equal(run('state.viewer'), false);
  assert.equal(run('space.dust.length'), 850);
  assert(run('space.dust.some(dust => dust.z < 0) && space.dust.some(dust => dust.z > 0)'));
  assert.equal(run('sound.context'), null);
  await run('tryDemo()');
  assert.equal(run('state.viewer'), true);
  assert.equal(run('document.body.classList.contains("is-viewer")'), true);
  assert.equal(run('baseDepth.length'), 240 * 135);
  assert(run('positions.every(Number.isFinite)'));
  run('finishTransition(); animate(16);');
  assert.equal(lastDraw, 240 * 135);
  assert.equal(buffers.size, 2);
  assert.equal(programs.size, 1);

  // Exercise the actual button listener -> controller -> camera boundary.
  assert.equal(element('#hand-control').events.click.name, 'handleHandControlClick');
  let resolveCamera, cameraRequests = 0, stopped = false;
  context.window.isSecureContext = true;
  context.navigator = { mediaDevices: { getUserMedia(constraints) {
    cameraRequests++;
    assert.equal(element('#hand-state').textContent, 'STARTING...');
    assert.equal(constraints.video.facingMode, 'user');
    assert.equal(constraints.audio, false);
    return new Promise(resolve => { resolveCamera = resolve; });
  } } };
  run('HandControl.prototype.loadLandmarker = async () => ({ close() {} });');
  const activation = element('#hand-control').events.click();
  assert.equal(element('#hand-state').textContent, 'STARTING...', 'listener acknowledges synchronously');
  await Promise.resolve();
  assert.equal(cameraRequests, 1, 'camera starts in the click microtask');
  await element('#hand-control').events.click();
  assert.equal(cameraRequests, 1, 'STARTING ignores duplicate clicks');
  const track = { stop() { stopped = true; } };
  resolveCamera({ getTracks: () => [track], getVideoTracks: () => [track] });
  await activation;
  assert.equal(element('#hand-state').textContent, 'ON');
  await element('#hand-control').events.click();
  assert.equal(element('#hand-state').textContent, 'OFF');
  assert(stopped && run('hand.video.srcObject === null && hand.timer === null'));

  // Mouse drag/wheel still own the view and retain the usual X limits. A prior
  // full X spin is the exception: mouse takeover must preserve its orientation.
  run(`state.rotationX=0; state.rotationY=0; state.zoom=1;`);
  const stageElement = element('#stage');
  const down = { pointerId: 1, pointerType: 'mouse', button: 0, clientX: 300, clientY: 300 };
  stageElement.events.pointerdown(down);
  stageElement.events.pointermove({ ...down, clientX: 320, clientY: 310 });
  assert.equal(run('state.rotationY'), .14);
  assert.equal(run('state.rotationX'), .06);
  stageElement.events.wheel({ deltaY: 100, deltaMode: 0, preventDefault() {} });
  assert(run('state.zoom < 1'));
  stageElement.events.pointerup(down);
  run('state.rotationX=1.28;');
  stageElement.events.pointerdown(down);
  stageElement.events.pointermove({ ...down, clientY: 310 });
  assert.equal(run('state.rotationX'), 1.3);
  stageElement.events.pointerup(down);
  run('state.rotationX=4;');
  stageElement.events.pointerdown(down);
  stageElement.events.pointermove({ ...down, clientY: 310 });
  assert.equal(run('state.rotationX'), 4.06, 'mouse takeover after X spin never snaps');
  stageElement.events.pointerup(down);
  run('resetView(); mousePriorityUntil=0;');

  // Cursor lift/spread, bounded velocity, and the smooth spring return.
  run('pointer.active = true; pointer.x = view.offsetX + 0.05; pointer.y = view.offset; pointer.speed = 1;');
  for (let i = 2; i < 70; i++) run(`animate(${i * 16})`);
  assert(run('offsets.some((value, i) => i % 3 === 2 && value > .3)'));
  assert(run('offsets.some((value, i) => i % 3 !== 2 && Math.abs(value) > .01)'));
  run('pointer.active = false;');
  for (let i = 70; i < 370; i++) run(`animate(${i * 16})`);
  assert(run('offsets.every(value => Math.abs(value) < .0001)'));
  run('state.depth = 1; animate(6000);');
  assert(run('positions.every(Number.isFinite)'));

  // Inverse projection must hit the original point under different rotations.
  for (const [rx, ry, rz] of [[0, 0, 0], [.4, .7, .3], [-.5, -1.1, -.55]]) {
    run(`view.rotationX = ${rx}; view.rotationY = ${ry}; view.rotationZ = ${rz}; view.zoom = 1.4;`);
    const x = .6;
    const y = .3;
    const worldX = x * Math.cos(ry) + y * Math.sin(rx) * Math.sin(ry);
    const worldY = y * Math.cos(rx);
    const worldZ = -x * Math.sin(ry) + y * Math.sin(rx) * Math.cos(ry);
    const rolledX = worldX * Math.cos(rz) - worldY * Math.sin(rz);
    const rolledY = worldX * Math.sin(rz) + worldY * Math.cos(rz);
    run(`pointer.x = ${rolledX * 12 / (12 - worldZ)} * view.zoom / (viewWidth / 2) + view.offsetX;
      pointer.y = ${rolledY * 12 / (12 - worldZ)} * view.zoom / (viewHeight / 2) + view.offset;`);
    assert(run('pointerOnField()'));
    assert(Math.abs(run('hit.x') - x) < 1e-6);
    assert(Math.abs(run('hit.y') - y) < 1e-6);
  }
  run('view.rotationX = 0; view.rotationY = 0; view.rotationZ = 0;');

  // A virtual fingertip must use the same hit/spring/color path as the mouse.
  run('finishTransition(); hand.phase = "ON"; handPointer.active = true; handPointer.x = view.offsetX; handPointer.y = view.offset; handPointer.speed = .5;');
  for (let i = 0; i < 20; i++) run(`animate(${6100 + i * 16})`);
  assert(run('offsets.some((value, i) => i % 3 === 2 && value > .2)'));
  run('hand.stop(); pointer.active = false;');

  for (const [width, height] of [[390, 844], [430, 932], [768, 1024], [1440, 900], [1920, 1080]]) {
    context.innerWidth = width;
    context.innerHeight = height;
    run('resizeStars(); space.resize(); resizeViewer(); space.draw(.016, pointer, false, false);');
    assert.equal(run('space.dust.length'), width < 600 ? 280 : 850);
    assert(run('Number.isFinite(viewWidth) && Number.isFinite(viewHeight)'));
    assert(run('fieldWidth / viewWidth * innerWidth <= innerWidth * .98'));
    assert(run('fieldHeight / viewHeight * innerHeight <= innerHeight * .98'));
    run("density.value = '360'; buildField();");
    assert(run('baseDepth.length') <= (width < 600 ? 156 ** 2 : width < 1000 ? 264 ** 2 : 360 ** 2));
  }
  run("density.value = '96'; buildField();");
  const coarseSize = run('view.size');
  run("density.value = '360'; buildField();");
  assert(run('view.size') < coarseSize * .35);
  assert(run('atmosphere.fragments.length') > 500);
  const oldZ = run('space.dust[0].z');
  run('space.draw(.5, pointer, true, false, view);');
  assert(run('space.dust[0].z') > oldZ);
  for (let i = 0; i < 50; i++) run('buildField()');
  assert.equal(buffers.size, 2);
  assert.equal(programs.size, 1);
  await run("uploadFile({ type: 'text/plain', size: 100 })");
  assert.equal(element('#status').textContent, 'Choose a PNG, JPG, or WebP image.');
  await run("uploadFile({ type: 'image/png', size: 31 * 1024 * 1024 })");
  assert.equal(element('#status').textContent, 'Choose an image smaller than 30 MB.');
  for (const type of ['image/png', 'image/jpeg', 'image/webp']) {
    let closed = false;
    context.createImageBitmap = async () => ({ width: 800, height: 600, close() { closed = true; } });
    context.window.createImageBitmap = context.createImageBitmap;
    await run(`uploadFile({ type: '${type}', size: 1000, name: '<image>' })`);
    assert(closed);
    assert.equal(run('state.name'), '<image>');
    assert.equal(run('state.transitioning'), true);
  }
  // Decode failure and a transparent replacement must preserve the current image.
  const previousSource = run('state.source');
  context.createImageBitmap = async () => { throw new Error('corrupt'); };
  context.window.createImageBitmap = context.createImageBitmap;
  context.Image = class { async decode() { throw new Error('corrupt'); } };
  await run("uploadFile({ type: 'image/png', size: 10, name: 'bad.png' })");
  assert.equal(run('state.source'), previousSource);
  assert.throws(() => run("showSource({width: 100, height: 100, transparent: true}, 'empty')"), /transparent/);
  assert.equal(run('state.source'), previousSource);
  // A cancelled picker is a no-op; reopening it clears its previous selection.
  await run('uploadFile(undefined)');
  assert.equal(run('state.source'), previousSource);

  // Quantized notes, four partials per voice, rate limiting, and bounded polyphony.
  class AudioParam {
    constructor() { this.value = 0; }
    cancelScheduledValues() {}
    setTargetAtTime(value) { this.value = value; }
    setValueAtTime(value) { this.value = value; }
    linearRampToValueAtTime(value) { this.value = value; }
    exponentialRampToValueAtTime(value) { this.value = value; }
  }
  class AudioNode {
    constructor() {
      this.frequency = new AudioParam();
      this.gain = new AudioParam();
      this.delayTime = new AudioParam();
      for (const key of ["Q", "threshold", "knee", "ratio", "attack", "release"]) this[key] = new AudioParam();
    }
    connect() {}
    disconnect() {}
    start() {}
    stop() { this.stopped = true; }
  }
  let voices = 0;
  context.window.AudioContext = class {
    constructor() { this.currentTime = 0; this.state = 'suspended'; }
    createOscillator() { voices++; return new AudioNode(); }
    createDelay() { return new AudioNode(); }
    createGain() { return new AudioNode(); }
    createBiquadFilter() { return new AudioNode(); }
    createDynamicsCompressor() { return new AudioNode(); }
    async resume() { this.state = 'running'; }
    async close() { this.state = 'closed'; }
  };
  await element('#sound').events.click();
  assert.equal(element('#sound').attributes['aria-pressed'], 'true');
  assert.equal(run('sound.noteForBrightness(0)'), 36);
  assert.equal(run('sound.noteForBrightness(1)'), 84);
  assert(run('sound.scale.every(note => [0, 2, 4, 7, 9].includes(note % 12))'));
  run('sound.context.currentTime = 1; sound.update(0, true, 0);');
  assert.equal(voices, 4);
  run('sound.context.currentTime = 1.05; sound.update(1, true, 1);');
  assert.equal(voices, 4);
  for (let i = 0; i < 20; i++) {
    run(`sound.context.currentTime = ${2 + i * .3}; sound.update(${i % 2}, true, 100);`);
  }
  assert(run('sound.voices.size <= 6'));
  assert(voices <= 24);
  assert.equal(run('new Set([[1,0,0],[0,1,0],[0,0,1],[1,1,0]].map(rgb => sound.noteForColor(...rgb).note)).size'), 4);
  for (const rgb of [[.2,0,0], [0,.2,0], [0,0,.2]]) {
    context.testRGB = rgb;
    assert(run('sound.noteForColor(...testRGB).note < sound.noteForColor(...testRGB.map(v => v + .7)).note'));
  }
  run('sound.silence();');
  assert(run('[...sound.voices].every(voice => voice.gain.gain.value === 0)'));
  run('for (const voice of sound.voices) sound.releaseVoice(voice);');
  assert.equal(run('sound.voices.size'), 0);
  await element('#sound').events.click();
  await element('#sound').events.click();
  context.document.hidden = true;
  documentEvents.visibilitychange();
  assert.equal(run('pointer.active'), false);
  assert.equal(run('sound.wasActive'), false);
  context.document.hidden = false;
  run("resetAll(); finishTransition(); backToLanding();");
  assert.equal(run('state.source'), null);
  assert.equal(run('field'), false);
  assert.equal(element('#density').value, '240');
  assert.equal(element('#viewer').inert, true);
  assert.equal(element('#landing').inert, false);
  element('#upload').events.click();
  assert.equal(element('#file-input').clicked, true);
  element('#file-input').clicked = false;
  element('#upload-new').events.click();
  assert.equal(element('#file-input').clicked, true);
  events.pagehide({ persisted: false });
  assert.equal(buffers.size, 0);
  assert.equal(programs.size, 0);
  console.log('PASS: forward travel, RGB debris, upload/new-image/cancel/failure flows, XYZ springs, inverse projection, 390/430/768/1440/1920 framing, density 360/point size, pentatonic notes/rate/voice limits/OFF, 50 replacements, and GPU lifecycle.');
  console.log('This command uses API doubles. tests/browser.html checks real file input, image decoding, and GPU output.');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
