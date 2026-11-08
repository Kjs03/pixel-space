// Diagnostic view only. It never requests a camera or runs MediaPipe inference.
class HandDebugView {
  static presets = {
    SENSITIVE: [.30, .30, .35], BALANCED: [.40, .40, .45], STRICT: [.60, .60, .60]
  };
  static fields = [
    ['minHandDetectionConfidence', 'DETECTION', 'How easily a hand is initially detected'],
    ['minHandPresenceConfidence', 'PRESENCE', 'How confidently the landmarks must represent a hand'],
    ['minTrackingConfidence', 'TRACKING', 'How confidently the same hand is tracked frame-to-frame']
  ];
  // MediaPipe's 21-point hand topology: thumb, four fingers, and palm perimeter.
  static connections = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],
    [5,9],[9,10],[10,11],[11,12],[9,13],[13,14],[14,15],[15,16],
    [13,17],[0,17],[17,18],[18,19],[19,20]];

  constructor(controller) {
    this.controller = controller;
    this.root = document.createElement('aside');
    this.root.id = 'hand-debug';
    this.root.setAttribute('aria-label', 'Hand tracking camera and settings');
    this.root.hidden = true;
    this.root.innerHTML = `
      <header class="hand-debug-heading">
        <span>CAMERA PREVIEW</span>
        <button type="button" id="hand-preview-toggle" aria-expanded="true" aria-controls="hand-debug-content" title="Collapse camera preview">−</button>
      </header>
      <div id="hand-debug-content">
        <div class="hand-camera">
          <div class="hand-camera-image"><canvas id="hand-skeleton" width="400" height="300" aria-hidden="true"></canvas></div>
          <span class="hand-camera-placeholder">CAMERA STARTING</span>
        </div>
        <details class="hand-tuning" ${innerWidth > 600 ? 'open' : ''}>
          <summary>TRACKING SETTINGS</summary>
          <div class="hand-presets" role="group" aria-label="Confidence presets">
            ${Object.keys(HandDebugView.presets).map(name => `<button type="button" data-hand-preset="${name}" aria-pressed="${name === 'BALANCED'}">${name}</button>`).join('')}
          </div>
          ${HandDebugView.fields.map(([key, label, title]) => `
            <label for="hand-${key}" title="${title}"><span>${label}</span><output for="hand-${key}">0.00</output></label>
            <input id="hand-${key}" data-confidence="${key}" type="range" min="0.20" max="0.80" step="0.05" title="${title}">
          `).join('')}
          <p class="hand-applied"></p>
          <p class="hand-threshold-note">Lower = more sensitive; may add false positives.</p>
          <button type="button" class="hand-settings-reset">RESET TRACKING SETTINGS</button>
          <div class="hand-spin-settings">
            <label for="hand-spin-threshold" title="Palm speed in aspect-corrected camera units per second. Lower values launch spin more easily.">SPIN THRESHOLD <output for="hand-spin-threshold">1.10</output></label>
            <input id="hand-spin-threshold" type="range" min="0.6" max="2.0" step="0.05" value="1.1">
            <label for="hand-spin-power">SPIN POWER <output for="hand-spin-power">1.00</output></label>
            <input id="hand-spin-power" type="range" min="0.5" max="2.0" step="0.05" value="1">
            <span class="hand-spin-velocity">SPIN X 0.00 · Y 0.00</span>
          </div>
        </details>
      </div>
      <div class="hand-debug-status" role="status" aria-live="polite">
        <span class="hand-tracking-status">CAMERA STARTING</span>
        <span class="hand-gesture-status">0 HANDS</span>
      </div>
      <div class="hand-debug-metrics"><span class="hand-pinch-distance" title="Normalized thumb–index distance. Grab below 0.30; release above 0.46.">PINCH DIST —</span><span class="hand-inference-fps">HAND FPS 0</span></div>
      <p class="hand-debug-error"></p>`;
    this.content = this.root.querySelector('#hand-debug-content');
    this.camera = this.root.querySelector('.hand-camera');
    this.image = this.root.querySelector('.hand-camera-image');
    this.canvas = this.root.querySelector('canvas');
    this.context = this.canvas.getContext('2d');
    this.video = controller.video;
    // Both raw video and raw landmark canvas share ONE CSS mirror. Gesture
    // coordinates keep their existing 1-x conversion, entirely independently.
    this.video.className = 'hand-preview-video';
    this.image.prepend(this.video);
    this.toggle = this.root.querySelector('#hand-preview-toggle');
    this.toggle.addEventListener('click', () => {
      this.content.hidden = !this.content.hidden;
      this.toggle.textContent = this.content.hidden ? '+' : '−';
      this.toggle.setAttribute('aria-expanded', String(!this.content.hidden));
      this.toggle.title = this.content.hidden ? 'Expand camera preview' : 'Collapse camera preview';
      this.drawnLandmarks = null;
      this.root.querySelector('.hand-debug-metrics').hidden = this.content.hidden;
      this.render(this.snapshot);
    });
    this.inputs = [...this.root.querySelectorAll('[data-confidence]')];
    this.presetButtons = [...this.root.querySelectorAll('[data-hand-preset]')];
    for (const input of this.inputs) input.addEventListener('input', () => {
      controller.setConfidence({ [input.dataset.confidence]: Number(input.value) });
    });
    for (const button of this.presetButtons) button.addEventListener('click', () => {
      controller.setConfidence(Object.fromEntries(HandDebugView.fields.map(([key], i) => [key, HandDebugView.presets[button.dataset.handPreset][i]])));
    });
    this.root.querySelector('.hand-settings-reset').addEventListener('click', () => controller.setConfidence(HandControl.defaults));
    for (const [id, key] of [['hand-spin-threshold', 'swipeThreshold'], ['hand-spin-power', 'spinPower']]) {
      this.root.querySelector(`#${id}`).addEventListener('input', event => controller.setGestureConfig({ [key]: Number(event.target.value) }));
    }
    (document.querySelector('#viewer') || document.body).append(this.root);
    controller.onDebug = snapshot => this.render(snapshot);
    controller.publishDebug();
  }

  text(selector, value) {
    const node = this.root.querySelector(selector);
    if (node.textContent !== value) node.textContent = value;
  }

  render(snapshot) {
    if (!snapshot) return;
    this.snapshot = snapshot;
    this.root.hidden = snapshot.phase === 'OFF';
    const cameraReady = !!this.video.srcObject && this.video.readyState >= 2;
    this.camera.classList.toggle('has-video', cameraReady);
    this.text('.hand-camera-placeholder', snapshot.tracking);
    this.text('.hand-tracking-status', snapshot.tracking);
    const count = `${snapshot.handCount} ${snapshot.handCount === 1 ? 'HAND' : 'HANDS'}`;
    this.text('.hand-gesture-status', count + (snapshot.handCount || snapshot.state === 'SPINNING' ? ` · ${snapshot.gesture}` : ''));
    this.text('.hand-pinch-distance', 'PINCH DIST ' + (snapshot.pinches.length
      ? snapshot.pinches.map(hand => Number.isFinite(hand.ratio) ? hand.ratio.toFixed(2) : '—').join(' / ') : '—'));
    this.text('.hand-inference-fps', `HAND FPS ${Math.round(snapshot.inferenceFPS)}`);
    if (snapshot.gestureConfig) {
      for (const [id, key] of [['hand-spin-threshold', 'swipeThreshold'], ['hand-spin-power', 'spinPower']]) {
        const value = snapshot.gestureConfig[key].toFixed(2);
        this.root.querySelector(`#${id}`).value = value;
        this.text(`output[for="${id}"]`, value);
      }
      const velocity = snapshot.angularVelocity;
      this.text('.hand-spin-velocity', `SPIN X ${velocity.x.toFixed(2)} · Y ${velocity.y.toFixed(2)}`);
    }
    this.text('.hand-debug-error', snapshot.phase === 'ERROR' ? snapshot.detail : '');
    for (const input of this.inputs) {
      const value = snapshot.confidence[input.dataset.confidence].toFixed(2);
      if (Number(input.value) !== Number(value)) input.value = value;
      const output = this.root.querySelector(`output[for="${input.id}"]`);
      if (output.textContent !== value) output.textContent = value;
    }
    for (const button of this.presetButtons) {
      const preset = HandDebugView.presets[button.dataset.handPreset];
      button.setAttribute('aria-pressed', String(HandDebugView.fields.every(([key], i) => snapshot.confidence[key] === preset[i])));
    }
    this.text('.hand-applied', snapshot.appliedConfidence
      ? 'APPLIED ' + HandDebugView.fields.map(([key]) => snapshot.appliedConfidence[key].toFixed(2)).join(' / ')
      : 'APPLIES WHEN TRACKER STARTS');
    if (this.root.hidden || this.content.hidden) return;
    if (this.drawnLandmarks !== snapshot.landmarks) {
      this.draw(snapshot.landmarks, snapshot.pinches);
      this.drawnLandmarks = snapshot.landmarks;
    }
  }

  draw(hands, pinches) {
    const ctx = this.context;
    if (!ctx) return;
    const width = this.canvas.width;
    // Contain the full camera frame without cropping; video uses the same box.
    const aspect = this.video.videoWidth / this.video.videoHeight || 4 / 3;
    const height = Math.round(width / aspect);
    if (this.canvas.height !== height) this.canvas.height = height;
    this.image.style.aspectRatio = String(aspect);
    ctx.clearRect(0, 0, width, height);
    for (let i = 0; i < Math.min(2, hands.length); i++) {
      const points = hands[i];
      ctx.strokeStyle = '#bed4dfb8';
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (const [a, b] of HandDebugView.connections) {
        ctx.moveTo(points[a].x * width, points[a].y * height);
        ctx.lineTo(points[b].x * width, points[b].y * height);
      }
      ctx.stroke();
      points.forEach((point, index) => {
        const emphasized = pinches[i]?.pinched && (index === 4 || index === 8);
        ctx.fillStyle = emphasized ? '#efd4a9' : '#dce7f1';
        ctx.beginPath();
        ctx.arc(point.x * width, point.y * height, emphasized ? 5 : 2.7, 0, Math.PI * 2);
        ctx.fill();
      });
      if (pinches[i]?.pinched) {
        ctx.strokeStyle = '#efd4a9';
        ctx.beginPath();
        ctx.moveTo(points[4].x * width, points[4].y * height);
        ctx.lineTo(points[8].x * width, points[8].y * height);
        ctx.stroke();
      }
    }
  }
}
