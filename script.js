const $ = (selector) => document.querySelector(selector);
const handButton = $('#hand-control');
const handState = $('#hand-state');
const handStatus = $('#hand-status');
// Register before any application/dependency constructors can throw.
if (handButton) {
  handButton.addEventListener('click', handleHandControlClick);
} else {
  console.warn('[Hand] #hand-control button not found');
}

// Other controls can use these lifecycle hooks before the first hand click.
let hand = {
  phase: 'OFF',
  tick() {},
  interrupt() {},
  stop() { this.phase = 'OFF'; handOptions.status('OFF', ''); }
};
let handDebugView = null;
let handParameterHUD = null;
let handHUDTimer;
function showHandParameter(kind, value, released = false) {
  if (!handParameterHUD) {
    handParameterHUD = document.createElement('div');
    handParameterHUD.id = 'hand-parameter-hud';
    handParameterHUD.setAttribute('role', 'status');
    handParameterHUD.setAttribute('aria-live', 'polite');
    handParameterHUD.innerHTML = '<span></span><meter min="0" max="1"></meter><strong></strong>';
    $('#viewer').append(handParameterHUD);
  }
  clearTimeout(handHUDTimer);
  handParameterHUD.querySelector('span').textContent = kind + (kind === 'DENSITY' && !released ? ' PREVIEW' : '');
  handParameterHUD.querySelector('strong').textContent = String(Math.round(kind === 'DEPTH' ? value * 100 : value));
  handParameterHUD.querySelector('meter').value = kind === 'DEPTH' ? value : (value - 96) / (360 - 96);
  handParameterHUD.classList.add('visible');
  if (released) handHUDTimer = setTimeout(() => handParameterHUD.classList.remove('visible'), 650);
}
async function handleHandControlClick() {
  console.log('[Hand] CLICK');
  if (handState) handState.textContent = 'STARTING...';
  else handButton.textContent = 'HAND CONTROL STARTING...';
  handButton.setAttribute('aria-busy', 'true');
  // A microtask keeps user activation and lets .click() return STARTING even
  // when a dependency/secure-context check fails synchronously.
  await Promise.resolve();
  try {
    if (typeof hand.toggle !== 'function') hand = new HandControl(handOptions);
    if (!handDebugView && typeof HandDebugView === 'function') {
      try { handDebugView = new HandDebugView(hand); }
      catch (error) { console.warn('[Hand] preview initialization failed', error); }
    }
    await hand.toggle();
  } catch (error) {
    console.warn('[Hand] controller initialization failed', error);
    handOptions.status('ERROR', 'Hand control unavailable. Click to retry.');
  }
}

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const input = $('#file-input');
const depth = $('#depth');
const density = $('#density');
const pointer = {
  x: 0,
  y: 0,
  active: false,
  speed: 0,
  lastX: null,
  lastY: null,
  time: 0
};

const view = {
  rotationX: 0,
  rotationY: 0,
  rotationZ: 0,
  zoom: 1,
  width: 1,
  height: 1,
  size: 1,
  offset: 0,
  offsetX: 0,
  opacity: 0
};

const hit = {
  x: 0,
  y: 0
};

let positions;
let origins;
let offsets;
let velocities;
let baseDepth;
let baseLuminance;
let baseColors;
let renderer;
let field = false;
const DEFAULT_DENSITY = 240;
let fieldDensity = DEFAULT_DENSITY;
let compactViewer = innerWidth < 600;
let fieldWidth = 1;
let fieldHeight = 1;
let viewWidth = 1;
let viewHeight = 1;
let frameTime = 0;
let reveal = 0;
const state = {
  source: null,
  name: '',
  viewer: false,
  transitioning: false,
  loading: 0,
  depth: .55,
  rotationX: 0,
  rotationY: 0,
  rotationZ: 0,
  zoom: 1
};

let statusTimer;
let transitionStart = 0;
let transitionSource = null;
const space = new CosmicSpace($('#cosmos'));
const atmosphere = new ImageAtmosphere($('#image-atmosphere'));
let rippleX = 0;
let rippleY = 0;
let rippleAge = 10;
let lastRipple = -1;
const sound = new PixelSound();
const handPointer = { x: 0, y: 0, active: false, speed: 0 };
let mousePriorityUntil = 0;
const handOptions = {
  readView: () => ({ rotationX: state.rotationX, rotationY: state.rotationY, rotationZ: state.rotationZ, zoom: state.zoom }),
  transform: values => Object.assign(state, values),
  available: () => state.viewer && !state.transitioning,
  blocked: () => touches.size > 0 || performance.now() < mousePriorityUntil || document.hidden,
  readParameters: () => ({ depth: state.depth, density: Number(density.value) }),
  previewParameter: (kind, value) => {
    if (kind === 'DEPTH') {
      state.depth = value;
      depth.value = String(Math.round(value * 100));
      $('#depth-value').textContent = depth.value;
    }
    showHandParameter(kind, value);
  },
  finishAdjustment: (kind, value, commitDensity) => {
    if (commitDensity) {
      density.value = String(value);
      $('#density-value').textContent = density.value;
      buildField();
    }
    showHandParameter(kind, value, true);
  },
  point: tip => {
    handPointer.active = !!tip;
    if (!tip) { handPointer.speed = 0; return; }
    handPointer.x = tip.x * 2 - 1;
    handPointer.y = 1 - tip.y * 2;
    handPointer.speed = tip.speed;
    const panel = $('.controls').getBoundingClientRect();
    const x = tip.x * innerWidth, y = tip.y * innerHeight;
    if (x >= panel.left && x <= panel.right && y >= panel.top && y <= panel.bottom) handPointer.active = false;
    const debugPanel = handDebugView?.root;
    if (debugPanel && !debugPanel.hidden) {
      const bounds = debugPanel.getBoundingClientRect();
      if (x >= bounds.left && x <= bounds.right && y >= bounds.top && y <= bounds.bottom) handPointer.active = false;
    }
  },
  status: (phase, detail) => {
    if (handState) handState.textContent = phase === 'STARTING' ? 'STARTING...' : phase;
    handButton?.setAttribute('aria-pressed', String(phase === 'ON'));
    handButton?.setAttribute('aria-busy', String(phase === 'STARTING'));
    if (handStatus) handStatus.textContent = detail;
    if (renderer) resizeViewer();
  }
};
let demoSource;
const transitionCanvas = $('#transition-image');
const transitionContext = transitionCanvas.getContext('2d');
function clearStatus() {
  clearTimeout(statusTimer);
  $('#status').classList.remove('visible');
  $('#status').textContent = '';
}

function announce(message, persistent = false) {
  clearTimeout(statusTimer);
  $('#status').textContent = message;
  $('#status').classList.add('visible');
  if (!persistent) {
    statusTimer = setTimeout(clearStatus, 5000);
  }
}

// A separate, low-resolution star canvas keeps the landing alive without WebGL.
const starCanvas = $('#stars');
const starContext = starCanvas.getContext('2d');
let stars = [];
let starWidth = 0;
let starHeight = 0;
let starTime = 0;
const random = (seed) => {
  const n = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
  return n - Math.floor(n);
};

function resizeStars() {
  starWidth = innerWidth;
  starHeight = innerHeight;
  const ratio = Math.min(devicePixelRatio || 1, 1.5);
  starCanvas.width = Math.round(starWidth * ratio);
  starCanvas.height = Math.round(starHeight * ratio);
  starContext.setTransform(ratio, 0, 0, ratio, 0, 0);
  stars = Array.from({
    length: Math.min(1250, Math.round(starWidth * starHeight / 1100))
  }, (_, i) => ({
    x: random(i + 1),
    y: random(i + 401),
    size: .35 + random(i + 801) * .85,
    alpha: .2 + random(i + 1201) * .62,
    layer: .3 + random(i + 1601) * .7,
    z: 1800 + random(i + 2401) * 2000,
    phase: random(i + 2001) * 6.28
  }));
}

function drawStars(dt) {
  starContext.clearRect(0, 0, starWidth, starHeight);
  const motion = state.viewer ? .42 : 1;
  if (!reducedMotion.matches) {
    starTime += dt * .07 * motion;
  }
  const t = starTime;
  const parallax = reducedMotion.matches ? 0 : 3 * motion;
  starContext.fillStyle = '#b4c6e9';
  for (const star of stars) {
    const travel = reducedMotion.matches ? 0 : starTime * 25.2;
    const z = 1800 + ((star.z - 1800 - travel) % 2000 + 2000) % 2000;
    const perspective = 2200 / z;
    const x = starWidth / 2 + (star.x - .5) * starWidth * perspective
      - pointer.x * star.layer * parallax;
    const y = starHeight / 2 + (star.y - .5) * starHeight * perspective
      + pointer.y * star.layer * parallax;
    starContext.globalAlpha = star.alpha * (.83 + .17 * Math.sin(t * 3 + star.phase));
    starContext.fillRect(x, y, star.size, star.size);
  }
  starContext.globalAlpha = 1;
}

// Procedural artworks are fully local and remain available with an empty assets folder.
function createArtwork(index) {
  const canvas = document.createElement('canvas');
  canvas.width = 480;
  canvas.height = index === 1 ? 560 : index === 4 ? 400 : 360;
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  const palettes = [
    ['#101e39', '#657eae', '#d5b3a3'],
    ['#091b29', '#3a8185', '#b9c7b0'],
    ['#20192e', '#9c768a', '#e1b3a2'],
    ['#10172d', '#596caa', '#e1caba'],
    ['#121e35', '#9c8cba', '#d6a994']
  ];
  const colors = palettes[index];
  const bg = ctx.createLinearGradient(0, 0, w * .6, h);
  bg.addColorStop(0, colors[0]);
  bg.addColorStop(.65, colors[1]);
  bg.addColorStop(1, colors[2]);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);
  if (index === 1 || index === 3) {
    const cx = w * .5;
    const cy = h * .46;
    const radius = w * .28;
    const sphere = ctx.createRadialGradient(cx - radius * .5, cy - radius * .6, 0, cx, cy, radius);
    sphere.addColorStop(0, colors[2]);
    sphere.addColorStop(.5, colors[1]);
    sphere.addColorStop(1, colors[0]);
    ctx.fillStyle = sphere;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = colors[2] + '66';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(cx, cy, radius * 1.5, radius * .35, -.4, 0, Math.PI * 2);
    ctx.stroke();
  } else {
    ctx.fillStyle = colors[2];
    ctx.beginPath();
    ctx.arc(w * .64, h * .31, w * .085, 0, Math.PI * 2);
    ctx.fill();
    for (let layer = 0; layer < 5; layer++) {
      ctx.beginPath();
      ctx.moveTo(0, h);
      for (let x = 0; x <= w + 8; x += 8) {
        const y = h * (.42 + layer * .105) + Math.sin(x * .011 + layer * 1.8 + index) * (24 + layer * 5) + Math.sin(x * .026 + layer) * 9;
        ctx.lineTo(x, y);
      }
      ctx.lineTo(w, h);
      ctx.closePath();
      ctx.fillStyle = [
        '#444560', '#323a54', '#232e46', '#18243a', '#111c31'
      ][layer];
      ctx.fill();
    }
  }
  const pixels = ctx.getImageData(0, 0, w, h);
  for (let i = 0; i < pixels.data.length; i += 4) {
    const noise = (random(i + index) - .5) * 10;
    pixels.data[i] += noise;
    pixels.data[i + 1] += noise;
    pixels.data[i + 2] += noise;
  }
  ctx.putImageData(pixels, 0, 0);
  return canvas;
}

function smoothstep(min, max, value) {
  const t = Math.max(0, Math.min(1, (value - min) / (max - min)));
  return t * t * (3 - 2 * t);
}

async function initExamples() {
  const source = createArtwork(0);
  try {
    const image = new Image();
    image.src = /^https?:$/.test(location.protocol)
      ? 'assets/examples/sample.jpg'
      : PIXEL_EXAMPLE_DATA[0];
    await image.decode();
    const scale = Math.min(1, 1024 / Math.max(image.width, image.height));
    source.width = Math.max(1, Math.round(image.width * scale));
    source.height = Math.max(1, Math.round(image.height * scale));
    source.getContext('2d').drawImage(image, 0, 0, source.width, source.height);
  } catch {
    // The demo stays available if an image asset cannot be decoded.
  }
  demoSource = source;
  atmosphere.setSource(source);
}

async function tryDemo() {
  const token = ++state.loading;
  announce('Entering space…', true);
  await examplesReady;
  if (await ensureRenderer() && token === state.loading) {
    showSource(demoSource, 'sample.jpg');
    clearStatus();
  }
}

async function ensureRenderer() {
  if (renderer) {
    return true;
  }
  const canvas = document.createElement('canvas');
  try {
    renderer = new PixelRenderer(canvas);
    $('#stage').replaceChildren(canvas);
    canvas.addEventListener('webglcontextlost', (event) => {
      event.preventDefault();
      field = false;
      pointer.active = false;
      sound.silence();
      announce('Graphics paused. Restoring the image…', true);
    });
    canvas.addEventListener('webglcontextrestored', async () => {
      renderer.dispose();
      renderer = null;
      if (await ensureRenderer()) {
        buildField();
        clearStatus();
      }
    });
    resizeViewer();
    return true;
  } catch (error) {
    renderer?.dispose();
    renderer = null;
    announce('The viewer needs WebGL. Try a browser with hardware acceleration enabled.', true);
    return false;
  }
}

async function decodeFile(file) {
  if ('createImageBitmap' in window) {
    try {
      return await createImageBitmap(file);
    } catch {
      // Fall through to the browser image decoder.
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    return image;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function uploadFile(file) {
  if (!file) {
    return;
  }
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
    announce('Choose a PNG, JPG, or WebP image.');
    return;
  }
  if (file.size > 30 * 1024 * 1024) {
    announce('Choose an image smaller than 30 MB.');
    return;
  }
  const token = ++state.loading;
  announce('Finding a little depth…', true);
  let decoded;
  try {
    decoded = await decodeFile(file);
    if (token !== state.loading) {
      return;
    }
    if (!(await ensureRenderer()) || token !== state.loading) {
      return;
    }
    const width = decoded.width || decoded.naturalWidth;
    const height = decoded.height || decoded.naturalHeight;
    if (!width || !height) {
      throw new Error('Empty image');
    }
    const scale = Math.min(1, 1024 / Math.max(width, height));
    const source = document.createElement('canvas');
    source.width = Math.max(1, Math.round(width * scale));
    source.height = Math.max(1, Math.round(height * scale));
    source.getContext('2d').drawImage(decoded, 0, 0, source.width, source.height);
    showSource(source, file.name);
    clearStatus();
  } catch (error) {
    if (token === state.loading) {
      announce(error.message.includes('fully transparent')
        ? error.message
        : 'This image could not be read. Try another PNG, JPG, or WebP.');
    }
  } finally {
    decoded?.close?.();
    input.value = '';
  }
}

function showSource(source, name) {
  // Validate and sample before replacing the current work or its controls.
  const prepared = sampleField(source, effectiveDensity(DEFAULT_DENSITY), .55);
  sound.silence();
  atmosphere.setSource(source);
  rippleAge = 10;
  state.source = source;
  state.name = name;
  resetAll(false);
  state.rotationY = 0;
  installField(prepared);
  view.rotationX = 0;
  view.rotationY = 0;
  view.rotationZ = 0;
  view.zoom = 1;
  state.viewer = true;
  pointer.active = false;
  document.body.classList.add('is-viewer');
  $('#landing').inert = true;
  $('#landing').setAttribute('aria-hidden', 'true');
  $('#viewer').inert = false;
  $('#viewer').setAttribute('aria-hidden', 'false');
  $('#stage').setAttribute('aria-hidden', 'false');
  $('#stage').setAttribute('aria-label', `Interactive pixel image: ${name}. Drag to rotate, scroll to zoom, double click for front view.`);
  startTransition(source);
}

function startTransition(source) {
  state.transitioning = !reducedMotion.matches;
  transitionStart = performance.now();
  const scale = Math.min(1, 720 / Math.max(source.width, source.height));
  transitionCanvas.width = Math.max(1, Math.round(source.width * scale));
  transitionCanvas.height = Math.max(1, Math.round(source.height * scale));
  transitionSource = document.createElement('canvas');
  transitionSource.width = transitionCanvas.width;
  transitionSource.height = transitionCanvas.height;
  transitionSource.getContext('2d').drawImage(source, 0, 0, transitionSource.width, transitionSource.height);
  sizeTransition();
  if (state.transitioning) {
    document.body.classList.add('is-entering');
    $('#viewer').inert = true;
    transitionContext.clearRect(0, 0, transitionCanvas.width, transitionCanvas.height);
    transitionCanvas.style.opacity = '0';
  } else {
    finishTransition();
  }
}

function sizeTransition() {
  if (!transitionSource) {
    return;
  }
  transitionCanvas.style.left = `${(1 + view.offsetX) * 50}%`;
  transitionCanvas.style.top = `${(1 - view.offset) * 50}%`;
  transitionCanvas.style.width = `${fieldWidth / viewWidth * innerWidth}px`;
  transitionCanvas.style.height = `${fieldHeight / viewHeight * innerHeight}px`;
}

function drawTransition(time) {
  if (!state.transitioning) {
    return;
  }
  const progress = Math.min(1, Math.max(0, (time - transitionStart) / 1050));
  const fadeIn = Math.min(1, progress / .25);
  const dissolve = Math.max(0, (progress - .28) / .72);
  const ctx = transitionContext;
  const w = transitionCanvas.width;
  const h = transitionCanvas.height;
  ctx.clearRect(0, 0, w, h);
  const step = 12;
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const seed = x * 17 + y * 7;
      const scatter = dissolve * dissolve;
      const size = 1 - scatter * (.2 + random(seed) * .65);
      ctx.globalAlpha = 1 - dissolve * (.3 + random(seed + 4) * .7);
      ctx.drawImage(
        transitionSource,
        x, y, Math.min(step, w - x), Math.min(step, h - y),
        x + (random(seed + 2) - .5) * scatter * 40,
        y + (random(seed + 3) - .5) * scatter * 32,
        Math.min(step, w - x) * size,
        Math.min(step, h - y) * size
      );
    }
  }
  ctx.globalAlpha = 1;
  transitionCanvas.style.opacity = String(fadeIn * (1 - dissolve));
  transitionCanvas.style.transform = `translate(-50%, -50%) scale(${.78 + (1 - (1 - progress) ** 3) * .22})`;
  view.opacity = dissolve;
  if (progress >= 1) {
    finishTransition();
  }
}

function finishTransition() {
  state.transitioning = false;
  transitionSource = null;
  document.body.classList.remove('is-entering');
  $('#viewer').inert = false;
  reveal = 1;
  view.opacity = 1;
  if (state.viewer) {
    $('#upload-new').focus({
      preventScroll: true
    });
  }
}

function backToLanding() {
  hand.stop();
  ++state.loading;
  state.viewer = false;
  state.transitioning = false;
  transitionSource = null;
  pointer.active = false;
  touches.clear();
  sound.silence();
  document.body.classList.remove('is-viewer', 'is-entering', 'is-dragging');
  $('#viewer').inert = true;
  $('#viewer').setAttribute('aria-hidden', 'true');
  $('#stage').setAttribute('aria-hidden', 'true');
  $('#landing').inert = false;
  $('#landing').removeAttribute('aria-hidden');
  clearStatus();
  renderer?.clearField();
  field = false;
  positions = null;
  origins = null;
  offsets = null;
  baseDepth = null;
  baseLuminance = null;
  baseColors = null;
  velocities = null;
  state.source = null;
  $('#try-demo').focus({
    preventScroll: true
  });
}

function effectiveDensity(value) {
  const limit = innerWidth < 600 ? 156 : innerWidth < 1000 ? 264 : 360;
  return Math.round(value * limit / 360);
}

function buildField() {
  if (!state.source || !renderer) return;
  sound.silence();
  installField(sampleField(state.source, effectiveDensity(Number(density.value)), state.depth));
}

function sampleField(source, longest, depthAmount) {
  const scale = longest / Math.max(source.width, source.height);
  const w = Math.max(1, Math.round(source.width * scale));
  const h = Math.max(1, Math.round(source.height * scale));
  const sample = document.createElement('canvas');
  sample.width = w;
  sample.height = h;
  const ctx = sample.getContext('2d', {
    willReadFrequently: true
  });
  ctx.drawImage(source, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;
  const luminance = new Float32Array(w * h);
  for (let i = 0; i < luminance.length; i++) {
    luminance[i] = (.2126 * data[i * 4] + .7152 * data[i * 4 + 1] + .0722 * data[i * 4 + 2]) / 255;
  }
  const points = [];
  const colors = [];
  const depths = [];
  const brightness = [];
  const sampleLuma = (x, y) => luminance[Math.max(0, Math.min(h - 1, y)) * w + Math.max(0, Math.min(w - 1, x))];
  const spacing = 5.6 / longest;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const p = i * 4;
      if (data[p + 3] < 40) {
        continue;
      }
      const l = luminance[i];
      const left = sampleLuma(x - 1, y);
      const right = sampleLuma(x + 1, y);
      const up = sampleLuma(x, y - 1);
      const down = sampleLuma(x, y + 1);
      const edge = Math.hypot(right - left, down - up);
      const contrast = l - (left + right + up + down) / 4;
      const smoothed = l * .5 + (left + right + up + down) * .125;
      const z = (smoothed - .5) * 1.45 + edge * .82 + contrast * .32
        + (random(i + 3) - .5) * .008 * (edge + .05);
      points.push((x - (w - 1) / 2) * spacing, ((h - 1) / 2 - y) * spacing, z * depthAmount * 2);
      depths.push(z);
      brightness.push(l);
      colors.push(data[p] / 255, data[p + 1] / 255, data[p + 2] / 255);
    }
  }
  if (!points.length) {
    throw new Error('This image is fully transparent. Try another image.');
  }
  return {
    positions: new Float32Array(points),
    colors: new Float32Array(colors),
    depths: new Float32Array(depths),
    brightness: new Float32Array(brightness),
    width: w * spacing,
    height: h * spacing,
    density: longest,
  };
}

function installField(prepared) {
  positions = prepared.positions;
  origins = new Float32Array(positions);
  offsets = new Float32Array(positions.length);
  velocities = new Float32Array(positions.length);
  baseDepth = prepared.depths;
  baseLuminance = prepared.brightness;
  baseColors = prepared.colors;
  fieldDensity = prepared.density;
  renderer.setField(positions, prepared.colors);
  field = true;
  fieldWidth = prepared.width;
  fieldHeight = prepared.height;
  reveal = 0;
  resizeViewer();
}

function resizeViewer() {
  if (!renderer) {
    return;
  }
  renderer.resize(innerWidth, innerHeight);
  const controls = $('.controls').getBoundingClientRect();
  const margin = innerWidth < 600 ? 18 : 28;
  const aboveWidth = innerWidth - margin * 2;
  const aboveHeight = Math.max(80, innerHeight - controls.height - margin * 2);
  const besideWidth = Math.max(80, innerWidth - controls.width - margin * 2);
  const besideHeight = innerHeight - margin * 2;
  const aboveFit = Math.min(aboveWidth / fieldWidth, aboveHeight / fieldHeight);
  const besideFit = Math.min(besideWidth / fieldWidth, besideHeight / fieldHeight);
  const useAbove = innerWidth < 600 || aboveFit >= besideFit;
  const pixelsPerUnit = useAbove ? aboveFit : besideFit;
  viewHeight = innerHeight / pixelsPerUnit;
  viewWidth = innerWidth / pixelsPerUnit;
  view.width = viewWidth;
  view.height = viewHeight;
  view.offsetX = useAbove ? 0 : -(controls.width + margin) / innerWidth;
  view.offset = useAbove ? (controls.height + margin) / innerHeight : 0;
  updatePointSize();
}

function updatePointSize() {
  const fill = .92 - smoothstep(96, 360, fieldDensity) * .16;
  view.size = Math.max(.65, innerHeight / viewHeight * (5.6 / fieldDensity) * fill);
}

// Inverse rotation of a perspective ray, intersected with the original image plane.
function pointerOnField(source = pointer) {
  const cy = Math.cos(view.rotationY);
  const sy = Math.sin(view.rotationY);
  const cx = Math.cos(view.rotationX);
  const sx = Math.sin(view.rotationX);
  const screenX = (source.x - view.offsetX) * viewWidth / (2 * view.zoom);
  const screenY = (source.y - view.offset) * viewHeight / (2 * view.zoom);
  const cz = Math.cos(view.rotationZ), sz = Math.sin(view.rotationZ);
  const px = screenX * cz + screenY * sz;
  const py = -screenX * sz + screenY * cz;
  const ox = -12 * sy;
  const oy = 12 * cy * sx;
  const oz = 12 * cy * cx;
  const dx = px / 12 * cy + sy;
  const intermediateZ = px / 12 * sy - cy;
  const dy = py / 12 * cx + intermediateZ * sx;
  const dz = -py / 12 * sx + intermediateZ * cx;
  if (Math.abs(dz) < .03) {
    return false;
  }
  const distance = -oz / dz;
  if (distance <= 0) {
    return false;
  }
  hit.x = ox + dx * distance;
  hit.y = oy + dy * distance;
  return Math.abs(hit.x) < fieldWidth / 2 + .3 && Math.abs(hit.y) < fieldHeight / 2 + .3;
}

function resetView() {
  hand.interrupt();
  state.rotationX = 0;
  state.rotationY = Math.round(state.rotationY / (Math.PI * 2)) * Math.PI * 2;
  state.zoom = 1;
  state.rotationZ = 0;
  pointer.active = false;
}

function resetAll(rebuild = true) {
  resetView();
  if (offsets) {
    offsets.fill(0);
  }
  if (velocities) {
    velocities.fill(0);
  }
  depth.value = '55';
  density.value = String(DEFAULT_DENSITY);
  state.depth = .55;
  $('#depth-value').textContent = '55';
  $('#density-value').textContent = String(DEFAULT_DENSITY);
  if (rebuild && state.source) {
    buildField();
  }
}

const touches = new Map();
let pinchDistance = 0;
const stage = $('#stage');
stage.addEventListener('pointerdown', (event) => {
  if (!state.viewer || state.transitioning || (event.pointerType === 'mouse' && event.button !== 0)) {
    return;
  }
  stage.setPointerCapture(event.pointerId);
  mousePriorityUntil = performance.now() + 900;
  hand.interrupt();
  touches.set(event.pointerId, {
    x: event.clientX,
    y: event.clientY
  });
  pointer.active = false;
  document.body.classList.add('is-dragging');
  if (touches.size === 2) {
    const [a, b] = [...touches.values()];
    pinchDistance = Math.hypot(a.x - b.x, a.y - b.y);
  }
});
stage.addEventListener('pointermove', (event) => {
  const previous = touches.get(event.pointerId);
  if (!previous) {
    return;
  }
  if (touches.size === 1) {
    state.rotationY += (event.clientX - previous.x) * .007;
    // Continue from a spun orientation without snapping X back into ±1.3 rad.
    const nextRotationX = state.rotationX + (event.clientY - previous.y) * .006;
    state.rotationX = Math.abs(state.rotationX) <= 1.3
      ? Math.max(-1.3, Math.min(1.3, nextRotationX)) : nextRotationX;
  }
  touches.set(event.pointerId, {
    x: event.clientX,
    y: event.clientY
  });
  if (touches.size === 2) {
    const [a, b] = [...touches.values()];
    const next = Math.hypot(a.x - b.x, a.y - b.y);
    if (pinchDistance > 0) {
      state.zoom = Math.max(.45, Math.min(3.5, state.zoom * next / pinchDistance));
    }
    pinchDistance = next;
  }
});
function releasePointer(event) {
  touches.delete(event.pointerId);
  if (!touches.size) {
    document.body.classList.remove('is-dragging');
  }
  pinchDistance = 0;
}
stage.addEventListener('pointerup', releasePointer);
stage.addEventListener('pointercancel', releasePointer);
stage.addEventListener('lostpointercapture', releasePointer);
stage.addEventListener('wheel', (event) => {
  if (!state.viewer || state.transitioning) {
    return;
  }
  event.preventDefault();
  mousePriorityUntil = performance.now() + 900;
  hand.interrupt();
  const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? innerHeight : 1);
  state.zoom = Math.max(.45, Math.min(3.5, state.zoom * Math.exp(-Math.max(-100, Math.min(100, delta)) * .0015)));
}, {
  passive: false
});
stage.addEventListener('dblclick', resetView);
stage.addEventListener('pointerleave', () => {
  pointer.active = false;
});
window.addEventListener('pointermove', (event) => {
  const now = performance.now();
  mousePriorityUntil = now + 900;
  if (pointer.lastX !== null) {
    const elapsed = Math.max(8, now - pointer.time);
    const speed = Math.hypot(event.clientX - pointer.lastX, event.clientY - pointer.lastY) / elapsed;
    pointer.speed = Math.min(1, Math.max(pointer.speed, speed / 2.4));
  }
  pointer.lastX = event.clientX;
  pointer.lastY = event.clientY;
  pointer.time = now;
  pointer.x = event.clientX / innerWidth * 2 - 1;
  pointer.y = -(event.clientY / innerHeight * 2 - 1);
  pointer.active = state.viewer && !state.transitioning
    && event.target === renderer?.canvas
    && event.pointerType !== 'touch' && !touches.size;
});
window.addEventListener('blur', () => {
  hand.interrupt();
  sound.silence();
  pointer.lastX = null;
  pointer.active = false;
  touches.clear();
  document.body.classList.remove('is-dragging');
});
window.addEventListener('keydown', (event) => {
  if (
    state.viewer && !state.transitioning &&
    event.key.toLowerCase() === 'r' &&
    !event.ctrlKey && !event.metaKey && !event.altKey &&
    !event.target.matches('input')
  ) {
    resetAll();
  }
});
$('#reset').addEventListener('click', () => resetAll());
$('#back').addEventListener('click', backToLanding);
$('#try-demo').addEventListener('click', tryDemo);
document.addEventListener('pointerleave', () => {
  pointer.lastX = null;
  pointer.active = false;
  sound.silence();
});
$('#sound').addEventListener('click', async () => {
  try {
    await sound.toggle();
  } catch {
    announce('Audio could not start. You can keep exploring in silence.');
  }
  $('#sound').textContent = sound.enabled ? 'SOUND ON' : 'SOUND OFF';
  $('#sound').setAttribute('aria-pressed', String(sound.enabled));
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    hand.stop();
    pointer.active = false;
    pointer.lastX = null;
    sound.silence();
  }
});
depth.addEventListener('input', () => {
  const value = depth.value;
  hand.interrupt();
  depth.value = value;
  mousePriorityUntil = performance.now() + 900;
  state.depth = Number(depth.value) / 100;
  $('#depth-value').textContent = depth.value;
});
density.addEventListener('input', () => {
  const value = density.value;
  hand.interrupt();
  density.value = value;
  mousePriorityUntil = performance.now() + 900;
  $('#density-value').textContent = density.value;
});
density.addEventListener('change', buildField);
for (const button of [$('#upload'), $('#upload-new')]) {
  button.addEventListener('click', () => {
    sound.silence();
    input.value = '';
    input.click();
  });
}
input.addEventListener('change', () => uploadFile(input.files[0]));
let dragLevel = 0;
window.addEventListener('dragenter', (event) => {
  event.preventDefault();
  if (event.dataTransfer.types.includes('Files')) {
    dragLevel++;
    document.body.classList.add('drop-active');
  }
});
window.addEventListener('dragover', (event) => {
  event.preventDefault();
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = 'copy';
  }
});
window.addEventListener('dragleave', (event) => {
  event.preventDefault();
  if (--dragLevel <= 0) {
    dragLevel = 0;
    document.body.classList.remove('drop-active');
  }
});
window.addEventListener('drop', (event) => {
  event.preventDefault();
  dragLevel = 0;
  document.body.classList.remove('drop-active');
  const files = event.dataTransfer.files;
  if (files.length > 1) {
    announce('Choose one image at a time.');
  } else {
    uploadFile(files[0]);
  }
});
window.addEventListener('resize', () => {
  resizeStars();
  space.resize();
  atmosphere.resize();
  const nextCompact = innerWidth < 600;
  if (state.source && fieldDensity !== effectiveDensity(Number(density.value))) {
    compactViewer = nextCompact;
    buildField();
  } else {
    compactViewer = nextCompact;
    resizeViewer();
  }
  sizeTransition();
});
function animate(time) {
  requestAnimationFrame(animate);
  if (document.hidden) {
    frameTime = time;
    return;
  }
  const dt = Math.max(0, Math.min((time - frameTime) / 1000 || .016, .032));
  frameTime = time;
  pointer.speed *= Math.exp(-dt * 4);
  hand.tick(dt);
  const interaction = hand.phase === 'ON' && time > mousePriorityUntil ? handPointer : pointer;
  handPointer.speed *= Math.exp(-dt * 4);
  drawStars(dt);
  space.draw(dt, pointer, !state.viewer, reducedMotion.matches, view);
  atmosphere.draw(dt, view, fieldWidth, fieldHeight, state.viewer, reducedMotion.matches, pointer);
  if (!field || !state.viewer) {
    return;
  }
  const easing = reducedMotion.matches ? 1 : 1 - Math.exp(-dt * 9);
  view.rotationX += (state.rotationX - view.rotationX) * easing;
  view.rotationY += (state.rotationY - view.rotationY) * easing;
  view.rotationZ += (state.rotationZ - view.rotationZ) * easing;
  view.zoom += (state.zoom - view.zoom) * easing;
  if (!state.transitioning) {
    reveal = Math.min(1, reveal + dt / .85);
    view.opacity = reducedMotion.matches ? 1 : reveal;
  }
  drawTransition(time);
  updatePointSize();
  const active = interaction.active && pointerOnField(interaction);
  rippleAge += dt;
  if (active && interaction.speed > .06 && time - lastRipple > 170) {
    rippleX = hit.x;
    rippleY = hit.y;
    rippleAge = 0;
    lastRipple = time;
  }
  const radius = .82;
  const strength = reducedMotion.matches ? .12 : .7 + interaction.speed * .5;
  let nearest = -1;
  let nearestDistance = .24;
  for (let i = 0; i < baseDepth.length; i++) {
    const p = i * 3;
    const dx = active ? origins[p] - hit.x : 0;
    const dy = active ? origins[p + 1] - hit.y : 0;
    const distance = active ? Math.hypot(dx, dy) : radius;
    const influence = 1 - smoothstep(0, radius, distance);
    if (active && distance < nearestDistance) { nearestDistance = distance; nearest = p; }
    const spread = influence * strength * .18;
    const norm = Math.max(distance, .08);
    const targetX = dx / norm * spread;
    const targetY = dy / norm * spread;
    let wave = 0;
    if (!reducedMotion.matches && rippleAge < 1.5) {
      const waveDistance = Math.hypot(origins[p] - rippleX, origins[p + 1] - rippleY);
      const wavefront = rippleAge * 1.8;
      const irregularity = .07 * Math.sin(origins[p] * 5 + origins[p + 1] * 3);
      wave = Math.exp(-(((waveDistance - wavefront + irregularity) / .22) ** 2))
        * Math.exp(-rippleAge * 3) * .075;
    }
    const targetZ = influence * strength + wave;
    // Critically damped, independent XYZ springs; no per-frame allocations.
    for (let axis = 0; axis < 3; axis++) {
      const target = axis === 0 ? targetX : axis === 1 ? targetY : targetZ;
      velocities[p + axis] += ((target - offsets[p + axis]) * 80 - velocities[p + axis] * 15) * dt;
      offsets[p + axis] += velocities[p + axis] * dt;
    }
    positions[p] = origins[p] + offsets[p];
    positions[p + 1] = origins[p + 1] + offsets[p + 1];
    const relief = baseDepth[i] * state.depth * 2;
    positions[p + 2] += (relief + offsets[p + 2] - positions[p + 2]) * easing;
  }
  sound.update(nearest >= 0 ? baseColors.subarray(nearest, nearest + 3) : [0, 0, 0], active && nearest >= 0, interaction.speed);
  renderer.draw(positions, view);
}

window.addEventListener('pagehide', (event) => {
  hand.stop();
  sound.silence();
  if (event.persisted) {
    return;
  }
  renderer?.dispose();
  sound.dispose().catch(() => {});
  atmosphere.clear();
  state.source = null;
});
const examplesReady = initExamples();
space.draw(0, pointer, true, reducedMotion.matches, view);
resizeStars();
drawStars(0);
requestAnimationFrame(animate);
