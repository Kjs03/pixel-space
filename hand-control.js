// Palm speed uses aspect-corrected camera units/second; spin uses radians/second.
const HAND_GESTURE_CONFIG = Object.freeze({
  swipeThreshold: 1.1, spinPower: 1, spinGain: 4.2,
  maxSpinX: 4.5, maxSpinY: 6.5, spinDamping: .48, freeDamping: 7,
  movementDeadZone: .0025, maxTrackingJump: .24, swipeMinDistance: .025,
  exitZoneLeft: .05, exitZoneRight: .95, exitZoneTop: .05, exitZoneBottom: .84,
  exitVelocity: .25, reentryMargin: .08,
  pinchStart: .30, pinchRelease: .46, fistHoldMs: 420,
  fingerStraightCosine: -.65, fingerExtendedRatio: 1.08, fingerCurledRatio: 1.04,
  grabDeadZone: .004, grabGainX: 5, grabGainY: 6, freeGainX: 3, freeGainY: 3.5,
  settleAngularVelocity: .008,
  fistWindow: 5, fistStartVotes: 4, fistReleaseVotes: 1,
  axisLockMs: 200, axisLockRatio: 1.25, axisLockDistance: .025,
  depthGain: 1.65, densityGain: 720, parameterSmoothing: 9,
  densityMin: 96, densityMax: 360, densityStep: 12,
  relaunchCooldownMs: 300, releaseCooldownMs: 180
});

// Optional, lazy-loaded input. Nothing requests a camera or downloads MediaPipe on landing.
class HandControl {
  static defaults = { minHandDetectionConfidence: .40, minHandPresenceConfidence: .40, minTrackingConfidence: .45 };

  constructor({ readView, transform, point, status, available, blocked, onDebug = () => {},
    readParameters = () => ({ depth: .55, density: 240 }), previewParameter = () => {}, finishAdjustment = () => {} }) {
    Object.assign(this, { readView, transform, point, status, available, blocked, onDebug, readParameters, previewParameter, finishAdjustment });
    this.gestureConfig = { ...HAND_GESTURE_CONFIG };
    this.confidence = { ...HandControl.defaults };
    this.appliedConfidence = null;
    this.debugInfo = { landmarks: [], pinches: [], handCount: 0, tracking: 'SEARCHING...', gesture: 'TRACKING', inferenceFPS: 0 };
    this.inferenceTimes = [];
    this.lastSeenAt = null;
    this.phase = 'OFF';
    this.session = 0;
    this.fps = innerWidth < 600 ? 12 : 20;
    this.rotationVelocityX = 0;
    this.rotationVelocityY = 0;
    this.rotationVelocityZ = 0;
    this.spinActive = false;
    this.spinLaunchedAt = -Infinity;
    this.video = document.createElement('video');
    this.video.muted = true;
    this.video.autoplay = true;
    this.video.playsInline = true;
    this.video.className = 'visually-hidden';
    this.video.setAttribute('aria-hidden', 'true');
    this.video.tabIndex = -1;
    document.body.append(this.video);
    this.resetGesture();
  }

  setStatus(phase, detail = '') {
    if (this.phase === phase && this.detail === detail) return;
    this.phase = phase;
    this.detail = detail;
    this.status(phase, detail);
    this.publishDebug();
  }

  publishDebug() {
    const tracking = this.phase === 'OFF' ? 'HAND OFF'
      : this.phase === 'ERROR' ? this.errorKind || 'TRACKER ERROR'
      : this.phase === 'STARTING' ? (this.stream ? 'STARTING TRACKER...' : 'CAMERA STARTING')
      : this.tuneOperation || this.tuneTimer ? 'TUNING...' : this.debugInfo.tracking;
    try {
      this.onDebug({ ...this.debugInfo, phase: this.phase, detail: this.detail, tracking,
        confidence: { ...this.confidence }, appliedConfidence: this.appliedConfidence && { ...this.appliedConfidence },
        gestureConfig: { ...this.gestureConfig }, angularVelocity: { x: this.rotationVelocityX, y: this.rotationVelocityY, z: this.rotationVelocityZ },
        gesture: this.gestureLabel(), state: this.gesture });
    } catch (error) { console.warn('[Hand] preview update failed', error); }
  }

  gestureLabel() {
    if (this.gesture === 'FIST_ADJUST') return this.adjustment?.axis ? `FIST · ${this.adjustment.axis}` : 'FIST · ADJUST';
    if (this.gesture === 'SPINNING' && this.debugInfo.handCount && performance.now() - this.spinLaunchedAt < 300) return 'FAST SWIPE';
    return ({ IDLE: 'TRACKING', POINTING: 'POINTING', FREE_ROTATE: 'ROTATE', SPINNING: 'SPINNING',
      GRABBING: 'GRAB · BRAKE', FIST_BRAKE: 'FIST · BRAKE', TWO_HAND_TRANSFORM: 'TRANSFORM' })[this.gesture] || 'TRACKING';
  }

  setGestureConfig(values) {
    if (Number.isFinite(Number(values.swipeThreshold))) this.gestureConfig.swipeThreshold = this.clamp(Number(values.swipeThreshold), .6, 2);
    if (Number.isFinite(Number(values.spinPower))) this.gestureConfig.spinPower = this.clamp(Number(values.spinPower), .5, 2);
    this.publishDebug();
  }

  setConfidence(values) {
    for (const key of Object.keys(HandControl.defaults)) {
      if (values[key] === undefined || !Number.isFinite(Number(values[key]))) continue;
      this.confidence[key] = Math.round(this.clamp(Number(values[key]), .2, .8) * 20) / 20;
    }
    clearTimeout(this.tuneTimer);
    this.tuneTimer = null;
    if (this.phase === 'ON' && JSON.stringify(this.confidence) !== JSON.stringify(this.appliedConfidence)) {
      this.tuneTimer = setTimeout(() => { this.tuneTimer = null; void this.applyConfidence(); }, 300);
    }
    this.publishDebug();
  }

  async applyConfidence() {
    if (this.phase !== 'ON' || !this.landmarker || this.tuneOperation) return;
    const session = this.session, detector = this.landmarker;
    const values = { ...this.confidence };
    const operation = { detector, promise: null };
    this.tuneOperation = operation;
    clearTimeout(this.timer);
    this.timer = null;
    this.interrupt();
    this.clearDebugResult();
    this.publishDebug();
    try {
      // MediaPipe setOptions rebuilds its graph asynchronously. Never infer or
      // close this detector until that promise settles. Keep the camera alive.
      operation.promise = Promise.resolve().then(() => detector.setOptions(values));
      await operation.promise;
      if (session !== this.session || this.landmarker !== detector) return;
      this.appliedConfidence = values;
      this.lastVideoTime = -1;
      this.lastDetection = -Infinity;
    } catch (error) {
      if (session === this.session) {
        console.warn('[Hand] confidence update failed', error);
        this.fail('Tracker settings could not be applied. Click Hand Control to retry.');
      }
    } finally {
      if (this.tuneOperation === operation) {
        this.tuneOperation = null;
        if (session === this.session && this.phase === 'ON') {
          // Changes arriving during setOptions are serialized and debounced again.
          this.setConfidence({});
          this.schedule(session);
        }
        this.publishDebug();
      }
    }
  }

  clearDebugResult() {
    this.lastSeenAt = null;
    this.inferenceTimes = [];
    Object.assign(this.debugInfo, { landmarks: [], pinches: [], handCount: 0, tracking: 'SEARCHING...', gesture: 'TRACKING', inferenceFPS: 0 });
  }

  publishResult(landmarks, now, blocked = false) {
    const valid = (landmarks || []).slice(0, 2).filter(hand => hand.length >= 21 && hand.every(p => Number.isFinite(p.x) && Number.isFinite(p.y)));
    if (valid.length) this.lastSeenAt = now;
    this.inferenceTimes.push(now);
    this.inferenceTimes = this.inferenceTimes.filter(time => now - time <= 1000);
    const times = this.inferenceTimes;
    const fps = times.length > 1 ? (times.length - 1) * 1000 / Math.max(1, now - times[0]) : 0;
    const aspect = this.video.videoWidth / this.video.videoHeight || 4 / 3;
    const metric = (a, b) => Math.hypot((a.x - b.x) * aspect, a.y - b.y);
    const pinches = valid.map((points, index) => ({
      ratio: blocked ? metric(points[4], points[8]) / Math.max(.025, metric(points[5], points[17])) : this.tracked[index]?.pinchRatio,
      pinched: !blocked && !!this.tracked[index]?.pinched
    }));
    const gesture = this.gesture === 'GRABBING' ? 'GRAB'
      : this.gesture === 'TWO_HAND_TRANSFORM' ? 'TRANSFORM'
      : this.gesture === 'POINTING' ? (this.swipeActive ? 'SWIPE' : 'POINTING') : 'TRACKING';
    Object.assign(this.debugInfo, { landmarks: valid, pinches, handCount: valid.length, gesture,
      tracking: valid.length ? 'TRACKING' : this.lastSeenAt !== null && now - this.lastSeenAt < 900 ? 'TRACKING LOST' : 'SEARCHING...',
      inferenceFPS: fps, blocked });
    this.publishDebug();
  }

  resetGesture() {
    this.gesture = 'IDLE';
    this.anchor = null;
    this.tracked = [];
    this.twoFrames = 0;
    this.lastResultTime = 0;
    this.lastTip = null;
    this.swipePalm = null;
    this.swipeActive = false;
    this.point(null);
  }

  async toggle() {
    if (this.phase === 'STARTING') return;
    if (this.phase === 'ON') this.stop();
    else await this.start();
  }

  debug(message) {
    if (window.PIXEL_HAND_DEBUG) console.debug(`[Hand] ${message}`);
  }

  // A rejected or abandoned asynchronous startup must never revive an old session.
  async start() {
    if (!this.available() || this.phase === 'STARTING' || this.phase === 'ON') return;
    const session = ++this.session;
    let pendingStream;
    let step = 'camera';
    try {
      this.clearDebugResult();
      this.errorKind = null;
      this.setStatus('STARTING', 'REQUESTING CAMERA…');
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw new Error('secure-context');
      this.debug('starting camera');
      // Keep this before any await/import: it runs in the button's user gesture.
      pendingStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: 'user' }
      });
      if (session !== this.session) {
        pendingStream.getTracks().forEach(track => track.stop());
        return;
      }
      this.stream = pendingStream;
      for (const track of this.stream.getVideoTracks()) {
        track.onended = () => { if (session === this.session) this.fail('Camera unavailable: disconnected. Click to retry.', 'CAMERA ERROR'); };
      }
      this.video.srcObject = pendingStream;
      this.startTimer = setTimeout(() => {
        if (session === this.session) this.fail(step === 'camera'
          ? 'Camera unavailable: video timed out. Click to retry.'
          : 'Hand model unavailable: loading timed out. Click to retry.', step === 'camera' ? 'CAMERA ERROR' : 'TRACKER ERROR');
      }, 25000);
      await this.video.play();
      if (session !== this.session) return;
      this.debug('camera ready');
      step = 'model';
      this.setStatus('STARTING', 'LOADING TRACKER…');
      const confidence = { ...this.confidence };
      const landmarker = await this.loadLandmarker(session, confidence);
      if (session !== this.session) {
        landmarker.close();
        return;
      }
      this.landmarker = landmarker;
      this.appliedConfidence = confidence;
      this.debug('MediaPipe ready');
      clearTimeout(this.startTimer);
      this.lastVideoTime = -1;
      this.lastDetection = -Infinity;
      this.fps = innerWidth < 600 ? 12 : 20;
      this.resetGesture();
      this.setStatus('ON', 'SEARCHING…');
      this.setConfidence({});
      this.schedule(session);
    } catch (error) {
      pendingStream?.getTracks().forEach(track => track.stop());
      if (session === this.session) {
        console.warn(`[Hand] ${step} startup failed`, error);
        this.fail(step === 'camera'
          ? 'Camera unavailable. Check camera permission and click to retry.'
          : 'Hand model unavailable. Click to retry.', step === 'camera' ? 'CAMERA ERROR' : 'TRACKER ERROR');
      }
    }
  }

  async loadLandmarker(session = this.session, confidence = { ...this.confidence }) {
    // Pin the module and WASM to the same release. No bundler/server required.
    const base = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.32';
    const { FilesetResolver, HandLandmarker } = await import(`${base}/vision_bundle.mjs`);
    const checkSession = () => { if (session !== this.session) throw new Error('cancelled'); };
    checkSession();
    const vision = await FilesetResolver.forVisionTasks(`${base}/wasm`);
    checkSession();
    this.modelAbort = new AbortController();
    let model;
    // Prefer the repository asset. The official versioned URL keeps hand input
    // usable in checkouts where the optional model download has not yet run.
    for (const url of [new URL('assets/models/hand_landmarker.task', document.baseURI).href,
      'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task']) {
      try {
        const response = await fetch(url, { signal: this.modelAbort.signal });
        if (!response.ok) throw new Error('model unavailable');
        const bytes = new Uint8Array(await response.arrayBuffer());
        const zipHeader = bytes.subarray(0, 16).some((value, i) => value === 80 && bytes[i + 1] === 75 && bytes[i + 2] === 3 && bytes[i + 3] === 4);
        if (bytes.length < 1000000 || !zipHeader) throw new Error('invalid model');
        model = bytes;
        break;
      } catch (error) {
        checkSession();
        if (error.name === 'AbortError') throw error;
      }
    }
    checkSession();
    if (!model) throw new Error('model unavailable');
    const options = {
      baseOptions: { modelAssetBuffer: model, delegate: 'GPU' },
      runningMode: 'VIDEO', numHands: 2,
      ...confidence
    };
    try {
      return await HandLandmarker.createFromOptions(vision, options);
    } catch {
      checkSession();
      options.baseOptions.delegate = 'CPU';
      return await HandLandmarker.createFromOptions(vision, options);
    }
  }

  schedule(session) {
    this.timer = setTimeout(() => this.detect(session), 1000 / this.fps);
  }

  detect(session) {
    if (session !== this.session || this.phase !== 'ON' || this.tuneOperation) return;
    clearTimeout(this.timer);
    this.timer = null;
    try {
      const now = performance.now();
      if (document.hidden || !this.available()) {
        this.interrupt();
        this.clearDebugResult();
        this.publishDebug();
      } else if (this.video.readyState >= 2 && this.video.currentTime !== this.lastVideoTime
          && now - this.lastDetection >= 1000 / this.fps - 1) {
        this.lastVideoTime = this.video.currentTime;
        this.lastDetection = now;
        const result = this.landmarker.detectForVideo(this.video, now);
        const duration = performance.now() - now;
        // Slow machines spend at most a modest fraction of time in inference.
        if (duration > 32) this.fps = Math.max(innerWidth < 600 ? 8 : 12, this.fps - 1);
        // Mouse priority blocks transforms, not the diagnostic camera feed.
        const blocked = this.blocked();
        if (blocked) this.interrupt();
        else this.consume(result.landmarks, now);
        this.lastResultTime = now;
        this.publishResult(result.landmarks, now, blocked);
      } else if (now - this.lastResultTime > 250) {
        this.releaseInput(now);
        this.setStatus('ON', 'SEARCHING…');
        this.clearDebugResult();
        this.publishDebug();
      }
    } catch (error) {
      console.warn('[Hand] detection failed', error);
      this.fail('Hand tracking failed. Click to retry.');
      return;
    }
    if (session === this.session && this.phase === 'ON') this.schedule(session);
  }

  // Pose classification uses existing landmarks only, with distance ratios and
  // joint angles so an in-plane rotation does not change the finger pose.
  classifyPose(points, metric) {
    const extended = [], curled = [];
    for (const [mcp, pip, tip] of [[5,6,8],[9,10,12],[13,14,16],[17,18,20]]) {
      const a = points[mcp], b = points[pip], c = points[tip];
      const aspect = this.video.videoWidth / this.video.videoHeight || 4 / 3;
      const u = [(a.x-b.x)*aspect, a.y-b.y], v = [(c.x-b.x)*aspect, c.y-b.y];
      const cosine = (u[0]*v[0]+u[1]*v[1]) / Math.max(.00001, Math.hypot(...u)*Math.hypot(...v));
      const straight = cosine < this.gestureConfig.fingerStraightCosine;
      extended.push(straight && metric(c, points[0]) > metric(b, points[0]) * this.gestureConfig.fingerExtendedRatio);
      curled.push(!straight || metric(c, points[0]) < metric(b, points[0]) * this.gestureConfig.fingerCurledRatio);
    }
    const curledCount = curled.filter(Boolean).length;
    return { fist: curled[0] && curledCount >= 3, curledCount,
      pointing: extended[0] && curled.slice(1).filter(Boolean).length >= 2 };
  }

  endAdjustment() {
    const adjustment = this.adjustment;
    this.adjustment = null;
    if (adjustment?.axis) this.finishAdjustment(adjustment.axis, adjustment.value,
      adjustment.axis === 'DENSITY' && adjustment.value !== adjustment.initial.density);
  }

  brake() {
    this.spinActive = false;
    this.rotationVelocityX = this.rotationVelocityY = this.rotationVelocityZ = 0;
  }

  releaseInput(now = performance.now()) {
    this.endAdjustment();
    if (!this.spinActive) this.brake();
    this.resetGesture();
    this.gesture = this.spinActive ? 'SPINNING' : 'IDLE';
    this.swipeReadyAt = now + this.gestureConfig.releaseCooldownMs;
  }

  consume(landmarks, now = performance.now()) {
    const cfg = this.gestureConfig;
    this.swipeActive = false;
    const elapsed = this.lastResultTime ? Math.max(.008, Math.min(.15, (now - this.lastResultTime) / 1000)) : .05;
    this.lastResultTime = now;
    const valid = (landmarks || []).slice(0, 2).filter(l => l.length >= 21 && l.every(p => Number.isFinite(p.x) && Number.isFinite(p.y)));
    if (!valid.length) {
      this.releaseInput(now);
      this.setStatus('ON', 'SEARCHING…');
      return;
    }
    const aspect = this.video.videoWidth / this.video.videoHeight || 4 / 3;
    const metric = (a, b) => Math.hypot((a.x - b.x) * aspect, a.y - b.y);
    const previous = [...this.tracked];
    this.tracked = valid.map(l => {
      const rawPalm = [0,5,9,13,17].reduce((p,i) => ({ x:p.x+(1-l[i].x)/5, y:p.y+l[i].y/5 }), {x:0,y:0});
      let match = -1, distance = .3;
      previous.forEach((old, i) => {
        if (!old) return;
        const next = metric(old.rawPalm, rawPalm);
        if (next < distance) { distance = next; match = i; }
      });
      const old = match < 0 ? null : previous[match];
      if (match >= 0) previous[match] = null;
      const pose = this.classifyPose(l, metric);
      const votes = [...(old?.fistVotes || []), pose.fist].slice(-cfg.fistWindow);
      const voteCount = votes.filter(Boolean).length;
      const fist = old?.fist ? voteCount > cfg.fistReleaseVotes : votes.length >= cfg.fistStartVotes && voteCount >= cfg.fistStartVotes;
      const ratio = metric(l[4],l[8]) / Math.max(.025, metric(l[5],l[17]));
      const pinchRatio = old ? old.pinchRatio*.35+ratio*.65 : ratio;
      const alpha = 1-Math.exp(-elapsed*(distance > .06 ? 22 : 11));
      const filter = (a,b) => ({x:a.x+(b.x-a.x)*alpha, y:a.y+(b.y-a.y)*alpha});
      const rawTip = {x:1-l[8].x,y:l[8].y};
      return { rawPalm, previousRawPalm:old?.rawPalm, palm:old ? filter(old.palm,rawPalm) : rawPalm,
        tip:old ? filter(old.tip,rawTip) : rawTip, pinchRatio,
        pinched:!pose.fist && pose.curledCount < 3 && pinchRatio < (old?.pinched ? cfg.pinchRelease : cfg.pinchStart),
        fist, fistVotes:votes, pointing:pose.pointing, matched:!!old };
    });
    this.setStatus('ON', '● TRACKING');
    // Highest priority: two hands, with the original zoom and subtle roll math.
    if (this.tracked.length === 2) {
      this.endAdjustment();
      this.brake();
      this.point(null);
      this.swipePalm = null;
      this.twoFrames++;
      if (this.tracked.some(hand => !hand.matched)) this.twoFrames = 1;
      if (this.twoFrames < 3) { this.gesture='IDLE'; this.anchor=null; return; }
      const [a,b] = [...this.tracked].sort((a,b)=>a.palm.x-b.palm.x);
      const dx=(b.palm.x-a.palm.x)*aspect, dy=b.palm.y-a.palm.y;
      const distance=Math.hypot(dx,dy), angle=Math.atan2(dy,dx);
      if (distance < .12) { this.gesture='IDLE'; this.anchor=null; return; }
      if (this.gesture !== 'TWO_HAND_TRANSFORM') {
        this.anchor={distance,angle,...this.readView()}; this.gesture='TWO_HAND_TRANSFORM';
      }
      const ratio=this.clamp(distance/this.anchor.distance,.5,2);
      const roll=Math.atan2(Math.sin(angle-this.anchor.angle),Math.cos(angle-this.anchor.angle));
      this.transform({zoom:this.clamp(this.anchor.zoom*(1+this.dead(ratio-1,.025)),.45,3.5),
        rotationZ:this.clamp(this.anchor.rotationZ-this.dead(roll,.055)*.55,-.65,.65)});
      return;
    }
    this.twoFrames=0;
    const hand=this.tracked[0], raw=hand.rawPalm, old=hand.previousRawPalm;
    const dx=old ? raw.x-old.x : 0, dy=old ? raw.y-old.y : 0;
    const outward = (raw.x < cfg.exitZoneLeft && dx/elapsed < -cfg.exitVelocity)
      || (raw.x > cfg.exitZoneRight && dx/elapsed > cfg.exitVelocity)
      || (raw.y < cfg.exitZoneTop && dy/elapsed < -cfg.exitVelocity)
      || (raw.y > cfg.exitZoneBottom && dy/elapsed > cfg.exitVelocity);
    const inside=raw.x > cfg.reentryMargin && raw.x < 1-cfg.reentryMargin
      && raw.y > cfg.reentryMargin && raw.y < cfg.exitZoneBottom-.04;
    if (outward || (old && Math.hypot(dx*aspect,dy)>cfg.maxTrackingJump) || (this.exitLatched && !inside)) {
      this.exitLatched=true;
      this.releaseInput(now);
      return; // No final edge delta can launch or steer a spin.
    }
    if (this.exitLatched && inside) { this.exitLatched=false; hand.matched=false; }
    if (!hand.matched || this.gesture === 'TWO_HAND_TRANSFORM') {
      this.endAdjustment();
      this.anchor=null; this.swipePalm=null; this.fistStartedAt=null;
      if (!this.spinActive) this.brake();
      this.gesture=this.spinActive ? 'SPINNING' : 'IDLE';
    }
    // Pinch wins over a stabilized fist, but a closed set of curled fingers is
    // not mistaken for a thumb-index pinch merely because its tips are nearby.
    if (hand.pinched) {
      this.endAdjustment();
      this.brake(); this.point(null); this.fistStartedAt=null; this.swipePalm=null;
      if (this.gesture !== 'GRABBING') this.anchor={palm:{...hand.palm},...this.readView()};
      this.gesture='GRABBING';
      this.transform({rotationY:this.anchor.rotationY+this.dead(hand.palm.x-this.anchor.palm.x,cfg.grabDeadZone)*cfg.grabGainY,
        rotationX:this.anchor.rotationX+this.clamp(this.dead(hand.palm.y-this.anchor.palm.y,cfg.grabDeadZone)*cfg.grabGainX,-1.3,1.3)});
      return;
    }
    if (hand.fist) {
      this.brake(); this.point(null); this.swipePalm=null;
      if (this.fistStartedAt == null) this.fistStartedAt=now;
      if (now-this.fistStartedAt < cfg.fistHoldMs) { this.gesture='FIST_BRAKE'; return; }
      if (this.gesture !== 'FIST_ADJUST') {
        const initial=this.readParameters();
        this.adjustment={palm:{...hand.palm},initial,enteredAt:now,axis:null,value:null};
        this.gesture='FIST_ADJUST';
      }
      const a=this.adjustment, deltaX=hand.palm.x-a.palm.x, deltaY=hand.palm.y-a.palm.y;
      if (!a.axis && now-a.enteredAt >= cfg.axisLockMs) {
        if (Math.abs(deltaY) > cfg.axisLockDistance && Math.abs(deltaY)>Math.abs(deltaX)*cfg.axisLockRatio) a.axis='DEPTH';
        else if (Math.abs(deltaX)>cfg.axisLockDistance && Math.abs(deltaX)>Math.abs(deltaY)*cfg.axisLockRatio) a.axis='DENSITY';
        if (a.axis) a.smoothed=a.axis==='DEPTH' ? a.initial.depth : a.initial.density;
      }
      if (a.axis) {
        const target=a.axis==='DEPTH' ? this.clamp(a.initial.depth-deltaY*cfg.depthGain,0,1)
          : this.clamp(a.initial.density+deltaX*cfg.densityGain,cfg.densityMin,cfg.densityMax);
        a.smoothed+=(target-a.smoothed)*(1-Math.exp(-elapsed*cfg.parameterSmoothing));
        a.value=a.axis==='DEPTH' ? a.smoothed : this.clamp(Math.round(a.smoothed/cfg.densityStep)*cfg.densityStep,cfg.densityMin,cfg.densityMax);
        this.previewParameter(a.axis,a.value);
      }
      return;
    }
    if (this.gesture==='FIST_ADJUST' || this.gesture==='FIST_BRAKE' || this.gesture==='GRABBING') {
      this.endAdjustment(); this.brake(); this.swipePalm=null; this.anchor=null;
      this.swipeReadyAt=now+cfg.releaseCooldownMs;
    }
    this.fistStartedAt=null;
    // A distinct index-only pose is surface interaction, with zero rotation.
    if (hand.pointing) {
      this.brake(); this.swipePalm=null; this.anchor=null;
      const moved=this.lastTip ? metric(this.lastTip,hand.tip) : 0;
      this.point({x:hand.tip.x,y:hand.tip.y,speed:Math.min(1,moved/elapsed*1.3)});
      this.lastTip={...hand.tip}; this.gesture='POINTING';
      return;
    }
    this.point(null); this.lastTip=null;
    if (this.gesture==='POINTING') { this.swipePalm=null; this.swipeReadyAt=now+cfg.releaseCooldownMs; }
    if (this.swipePalm && now >= (this.swipeReadyAt || 0)) {
      const moveX=this.dead(hand.palm.x-this.swipePalm.x,cfg.movementDeadZone);
      const moveY=this.dead(hand.palm.y-this.swipePalm.y,cfg.movementDeadZone);
      const vx=moveX/elapsed, vy=moveY/elapsed;
      const fast=Math.hypot(vx*aspect,vy)>=cfg.swipeThreshold && Math.hypot(moveX*aspect,moveY)>=cfg.swipeMinDistance;
      if (fast && now-this.spinLaunchedAt >= cfg.relaunchCooldownMs) {
        this.rotationVelocityX=this.clamp(vy*cfg.spinGain*cfg.spinPower,-cfg.maxSpinX,cfg.maxSpinX);
        this.rotationVelocityY=this.clamp(vx*cfg.spinGain*cfg.spinPower,-cfg.maxSpinY,cfg.maxSpinY);
        this.rotationVelocityZ=0;
        this.spinActive=true; this.spinLaunchedAt=now; this.swipeActive=true;
      } else if (!this.spinActive) {
        this.rotationVelocityX=this.clamp(vy*cfg.freeGainX,-2.6,2.6);
        this.rotationVelocityY=this.clamp(vx*cfg.freeGainY,-3.5,3.5);
        this.swipeActive=!!(moveX||moveY);
      }
    }
    this.swipePalm={...hand.palm};
    this.gesture=this.spinActive ? 'SPINNING' : 'FREE_ROTATE';
  }

  dead(value, zone) { return Math.sign(value) * Math.max(0, Math.abs(value) - zone); }
  clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }

  tick(dt) {
    if (this.phase !== 'ON' || this.tuneOperation) return;
    if (!this.available() || this.blocked()) { this.interrupt(); return; }
    if (['GRABBING','FIST_BRAKE','FIST_ADJUST','TWO_HAND_TRANSFORM','POINTING'].includes(this.gesture) || this.tracked.length===2) return;
    const current=this.readView();
    this.transform({rotationX:current.rotationX+this.rotationVelocityX*dt,
      rotationY:current.rotationY+this.rotationVelocityY*dt,
      rotationZ:current.rotationZ+this.rotationVelocityZ*dt});
    const friction=Math.exp(-(this.spinActive ? this.gestureConfig.spinDamping : this.gestureConfig.freeDamping)*dt);
    this.rotationVelocityX*=friction; this.rotationVelocityY*=friction; this.rotationVelocityZ*=friction;
    for (const key of ['rotationVelocityX','rotationVelocityY','rotationVelocityZ']) if (Math.abs(this[key])<this.gestureConfig.settleAngularVelocity) this[key]=0;
    if (!this.rotationVelocityX && !this.rotationVelocityY && !this.rotationVelocityZ) {
      this.spinActive=false;
      if (this.gesture==='SPINNING') this.gesture=this.tracked.length ? 'FREE_ROTATE' : 'IDLE';
    }
    // Numeric spin continues in the render loop; diagnostics update at 10 Hz.
    this.debugElapsed=(this.debugElapsed || 0)+dt;
    if (this.debugElapsed>=.1) { this.debugElapsed=0; this.publishDebug(); }
  }

  interrupt() {
    this.endAdjustment();
    this.brake();
    this.resetGesture();
    this.fistStartedAt=null;
    this.exitLatched=false;
  }

  stop() {
    ++this.session;
    clearTimeout(this.timer);
    clearTimeout(this.startTimer);
    clearTimeout(this.tuneTimer);
    this.tuneTimer = null;
    this.modelAbort?.abort();
    this.modelAbort = null;
    this.timer = null;
    for (const track of this.stream?.getTracks() || []) { track.onended = null; track.stop(); }
    this.stream = null;
    this.video.pause();
    this.video.srcObject = null;
    const detector = this.landmarker;
    const operation = this.tuneOperation;
    const close = () => { try { detector?.close(); } catch { /* Already closed. */ } };
    if (operation?.detector === detector && operation?.promise) operation.promise.catch(() => {}).then(close);
    else close();
    this.tuneOperation = null;
    this.landmarker = null;
    this.appliedConfidence = null;
    this.clearDebugResult();
    this.lastVideoTime = -1;
    this.lastTip = null;
    this.interrupt();
    this.setStatus('OFF');
  }

  fail(message, kind = 'TRACKER ERROR') {
    this.stop();
    this.errorKind = kind;
    this.setStatus('ERROR', message);
  }
}
