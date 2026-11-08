// Deterministic landmark and resource tests. No webcam images leave the browser/app.
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const timers = new Map();
const timerDelays = new Map();
let timerId = 0, cameraRequests = 0, view, cursor, statuses, blocked = false;
const video = { setAttribute() {}, async play() {}, pause() {}, videoWidth: 640, videoHeight: 480, readyState: 4, currentTime: 1 };
const sandbox = {
  document: { baseURI: 'https://example.test/pixel-space/', hidden: false, createElement: () => video, body: { append() {} } },
  window: { isSecureContext: true },
  navigator: { mediaDevices: { getUserMedia: async () => { cameraRequests++; return stream(); } } },
  performance: { now: () => 1000 }, innerWidth: 1440, URL,
  setTimeout: (callback, delay) => { timers.set(++timerId, callback); timerDelays.set(timerId, delay); return timerId; },
  clearTimeout: id => { timers.delete(id); timerDelays.delete(id); }
};
function stream() {
  const track = { stopped: false, stop() { this.stopped = true; } };
  return { track, getTracks: () => [track], getVideoTracks: () => [track] };
}
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(require('node:path').join(__dirname, '../hand-control.js'), 'utf8') + '\nglobalThis.HandControl = HandControl;', sandbox);
function controller() {
  view = { rotationX: 0, rotationY: 0, rotationZ: 0, zoom: 1 };
  statuses = [];
  return new sandbox.HandControl({ readView: () => ({ ...view }), transform: values => Object.assign(view, values),
    point: point => { cursor = point; }, available: () => true, blocked: () => blocked,
    status: (...args) => statuses.push(args) });
}
const { handFixture: landmarks } = require('./hand-fixtures.js');
(async () => {
  const hand = controller();
  let now = 1000;
  const send = (points, frames = 1) => { for (let i=0;i<frames;i++) { now += 50; hand.consume(points, now); } };
  const fresh = () => { hand.interrupt(); hand.phase='ON'; view={rotationX:0,rotationY:0,rotationZ:0,zoom:1}; now+=1000; };
  assert.equal(cameraRequests, 0, 'constructor/landing must not request camera');
  fresh();
  send([landmarks()]);
  assert.equal(hand.gesture, 'FREE_ROTATE');
  assert.equal(view.rotationY, 0, 'acquisition anchors without a jump');
  send([landmarks(.48,.51)]);
  hand.tick(1/60);
  assert(view.rotationY>0 && view.rotationX>0, 'slow palm deltas rotate Y/X');
  assert(!hand.spinActive, 'slow movement does not launch spin');
  assert.equal(cursor,null, 'open-hand rotation does not also point');

  fresh(); send([landmarks()]); send([landmarks(.37)]);
  assert.equal(hand.gesture,'SPINNING');
  assert(hand.rotationVelocityY>2 && hand.rotationVelocityY<=6.5);
  const initialVelocity=hand.rotationVelocityY;
  send([]);
  assert.equal(hand.gesture,'SPINNING', 'hand loss preserves launched spin');
  for (let i=0;i<180;i++) hand.tick(1/60);
  assert(view.rotationY>3, 'swipe keeps rotating for several seconds');
  assert(Math.abs(hand.rotationVelocityY-initialVelocity*Math.exp(-.48*3))<1e-8, 'spin damping is exponential in seconds');
  view.rotationX=4;
  const beforePinch={...view};
  send([landmarks(.5,.5,'pinch')]);
  assert.equal(hand.gesture,'GRABBING');
  assert.equal(hand.rotationVelocityY,0);
  assert.deepEqual(view,beforePinch,'grabbing an X spin cannot snap orientation into the old X clamp');
  send([landmarks(.47,.5,'pinch')]);
  assert(view.rotationY>beforePinch.rotationY,'pinch still provides precision rotation');
  send([landmarks()],5);
  assert(!hand.spinActive && hand.rotationVelocityY===0,'pinch release cannot relaunch spin');

  fresh(); send([landmarks()]); send([landmarks(.37)]);
  send([landmarks(.37,.5,'fist')],5);
  assert.equal(hand.gesture,'FIST_BRAKE');
  assert.equal(hand.rotationVelocityY,0,'stable fist brakes a spin');
  assert.equal(hand.adjustment,null,'a brief fist does not change parameters');

  fresh(); send([landmarks(.5,.70)]);
  const beforeExit={...view};
  send([landmarks(.5,.86)]); hand.tick(.016);
  assert.deepEqual(view,beforeExit,'large downward boundary delta cannot rotate');
  assert(hand.exitLatched);
  fresh(); send([landmarks()]); send([landmarks(.37)]);
  const beforeEdgeVelocity=hand.rotationVelocityY;
  send([landmarks(.37,.86)]);
  assert.equal(hand.rotationVelocityY,beforeEdgeVelocity,'exit preserves existing spin without an extra impulse');
  send([]); assert(hand.spinActive);
  for (const [from,to] of [[[.15,.5],[.01,.5]],[[.85,.5],[.99,.5]],[[.5,.15],[.5,.01]]]) {
    fresh(); send([landmarks(...from)]); send([landmarks(...to)]);
    assert(!hand.spinActive && hand.rotationVelocityX===0 && hand.rotationVelocityY===0,'left/right/top edge exit cannot launch spin');
  }

  let depth=.55, density=240, previews=[], commits=[];
  hand.readParameters=()=>({depth,density});
  hand.previewParameter=(axis,value)=>{previews.push({axis,value});if(axis==='DEPTH') depth=value;};
  hand.finishAdjustment=(axis,value,commit)=>{if(commit){density=value;commits.push({axis,value});}};
  fresh(); send([landmarks(.5,.5,'fist')],15);
  assert.equal(hand.gesture,'FIST_ADJUST');
  assert.equal(depth,.55); assert.equal(density,240,'holding a fist alone cannot change density');
  for(let i=1;i<=12;i++) send([landmarks(.5,.5-i*.012,'fist')]);
  assert.equal(hand.adjustment.axis,'DEPTH');
  assert(depth>.65,'moving fist up increases depth');
  const highDepth=depth;
  for(let i=1;i<=12;i++) send([landmarks(.5-i*.005,.356+i*.012,'fist')]);
  assert(depth<highDepth,'moving fist down decreases depth');
  assert.equal(hand.adjustment.axis,'DEPTH','dominant axis cannot switch while held');
  assert.equal(commits.length,0);
  send([],1);
  assert.equal(hand.adjustment,null,'tracking loss finalizes an adjustment');

  fresh(); send([landmarks(.5,.5,'fist')],15);
  for(let i=1;i<=16;i++) send([landmarks(.5-i*.009,.5,'fist')]);
  assert.equal(hand.adjustment.axis,'DENSITY');
  assert(hand.adjustment.value>240);
  assert.equal(density,240,'density remains a preview before release');
  assert.equal(commits.length,0,'no per-frame geometry rebuild');
  send([landmarks(.356,.5)],6);
  assert.equal(commits.length,1,'fist release commits density exactly once');
  send([]); send([]); assert.equal(commits.length,1,'loss cannot double-commit');

  fresh(); send([landmarks(.35),landmarks(.65)],4);
  assert.equal(hand.gesture,'TWO_HAND_TRANSFORM');
  for(let i=0;i<8;i++) send([landmarks(.25,.53),landmarks(.75,.47)]);
  assert(view.zoom>1 && Math.abs(view.rotationZ)>.005 && Math.abs(view.rotationZ)<=.65,'two-hand zoom and subtle roll remain');
  for(let i=0;i<8;i++) send([landmarks(.4),landmarks(.6)]);
  assert(view.zoom<1,'bringing hands together zooms out');

  fresh(); send([landmarks(.5,.5,'point')]); send([landmarks(.43,.52,'point')]);
  assert.equal(hand.gesture,'POINTING');
  assert(cursor && cursor.speed>0,'index-only pointing still emits the pixel/sound cursor');
  assert(Math.abs(cursor.x-(1-landmarks(.43,.52,'point')[8].x))<.08,'point coordinates mirror exactly once');
  hand.tick(.05); assert.equal(view.rotationY,0,'pointing cannot also rotate');
  blocked=true; hand.tick(.016); assert.equal(hand.gesture,'IDLE'); blocked=false;
  hand.stop();
  // Denial is caught, clears resources, and leaves all other controls independent.
  sandbox.navigator.mediaDevices.getUserMedia = async () => { throw Object.assign(new Error('denied'), { name: 'NotAllowedError' }); };
  await hand.start();
  assert.equal(hand.phase, 'ERROR');
  assert.match(statuses.at(-1)[1], /Camera unavailable/);
  assert.equal(timers.size, 0);
  // Turning OFF while permission is pending stops even the late stream.
  let resolveCamera;
  sandbox.navigator.mediaDevices.getUserMedia = () => new Promise(resolve => { resolveCamera = resolve; });
  const starting = hand.start();
  hand.stop();
  const late = stream();
  resolveCamera(late);
  await starting;
  assert(late.track.stopped);
  assert.equal(hand.phase, 'OFF');
  // Button activation is synchronous up to the permission request; repeated
  // clicks while it is pending must not cancel it or create another stream.
  let requests = 0;
  sandbox.navigator.mediaDevices.getUserMedia = constraints => {
    requests++;
    assert.equal(constraints.video.facingMode, 'user');
    assert.equal(constraints.audio, false);
    assert.equal(hand.phase, 'STARTING', 'UI changes before the camera call');
    return new Promise(resolve => { resolveCamera = resolve; });
  };
  const clicked = hand.toggle();
  assert.equal(requests, 1, 'camera called before toggle returns to the event handler');
  await hand.toggle();
  assert.equal(requests, 1);
  assert.equal(hand.phase, 'STARTING', 'duplicate click must be ignored');
  hand.loadLandmarker = async () => { throw new Error('model test failure'); };
  const modelFailureStream = stream();
  resolveCamera(modelFailureStream);
  await clicked;
  assert.equal(hand.phase, 'ERROR');
  assert.match(statuses.at(-1)[1], /Hand model unavailable/);
  assert(modelFailureStream.track.stopped && video.srcObject === null);
  assert.equal(timers.size, 0);
  // Normal ON/OFF and duplicate-start protection.
  const live = stream();
  sandbox.navigator.mediaDevices.getUserMedia = async () => live;
  let closes = 0, detections = 0;
  hand.loadLandmarker = async () => ({ close() { closes++; }, detectForVideo() { detections++; return { landmarks: [] }; } });
  await hand.toggle();
  assert.equal(hand.phase, 'ON');
  assert.equal(timers.size, 1);
  await hand.start();
  assert.equal(timers.size, 1, 'no duplicate inference timer');
  hand.detect(hand.session);
  hand.detect(hand.session);
  assert.equal(detections, 1, 'same video frame never inferred twice');
  await hand.toggle();
  assert.equal(hand.phase, 'OFF');
  assert(live.track.stopped && closes === 1 && video.srcObject === null);
  // A pending model load cannot restore ON after HOME/OFF.
  let resolveModel;
  const pending = stream();
  sandbox.navigator.mediaDevices.getUserMedia = async () => pending;
  hand.loadLandmarker = () => new Promise(resolve => { resolveModel = resolve; });
  const loading = hand.start();
  for (let i = 0; i < 12 && !resolveModel; i++) await Promise.resolve();
  hand.stop();
  resolveModel({ close() { closes++; } });
  await loading;
  assert.equal(hand.phase, 'OFF');
  assert(pending.track.stopped && closes === 2);
  // Inference failures must stop the camera and expose a retryable ERROR.
  const failedDetectionStream = stream();
  sandbox.navigator.mediaDevices.getUserMedia = async () => failedDetectionStream;
  hand.loadLandmarker = async () => ({ close() {}, detectForVideo() { throw new Error('inference test failure'); } });
  await hand.toggle();
  hand.detect(hand.session);
  assert.equal(hand.phase, 'ERROR');
  assert.match(statuses.at(-1)[1], /Hand tracking failed/);
  assert(failedDetectionStream.track.stopped && video.srcObject === null);
  assert.equal(timers.size, 0);
  // Real timer scheduling semantics, without wall-clock sleeps or a webcam.
  const flush = async () => { for(let i=0;i<16;i++) await Promise.resolve(); };
  const fireDebounce = () => {
    const ids=[...timers.keys()].filter(id=>timerDelays.get(id)===300);
    assert.equal(ids.length,1,'all slider input coalesces to one 300ms timer');
    const id=ids[0], callback=timers.get(id); timers.delete(id); timerDelays.delete(id); callback();
  };
  const tuned=controller(), tuningStream=stream();
  let tuningCloses=0, tuningDetections=0, updates=[], releaseUpdate;
  const detector={close(){tuningCloses++;},detectForVideo(){tuningDetections++;return {landmarks:[]};},
    async setOptions(options){updates.push({...options});}};
  sandbox.navigator.mediaDevices.getUserMedia=async()=>tuningStream;
  tuned.loadLandmarker=async()=>detector;
  await tuned.start();
  assert.deepEqual({...tuned.appliedConfidence},{minHandDetectionConfidence:.4,minHandPresenceConfidence:.4,minTrackingConfidence:.45});
  tuned.setConfidence({minHandDetectionConfidence:.6});
  tuned.setConfidence({minHandDetectionConfidence:.3,minHandPresenceConfidence:.3,minTrackingConfidence:.35});
  fireDebounce(); await flush();
  assert.equal(updates.length,1);
  assert.deepEqual(updates[0],{minHandDetectionConfidence:.3,minHandPresenceConfidence:.3,minTrackingConfidence:.35});
  assert.equal(tuned.stream,tuningStream,'confidence updates reuse the camera');
  assert.equal(tuned.landmarker,detector,'setOptions reuses the detector instance');
  assert.equal(tuningCloses,0);
  detector.setOptions=options=>{updates.push({...options});return new Promise(resolve=>{releaseUpdate=resolve;});};
  tuned.setConfidence({minTrackingConfidence:.6}); fireDebounce(); await flush();
  tuned.detect(tuned.session);
  assert.equal(tuningDetections,0,'inference cannot run concurrently with graph updates');
  tuned.setConfidence({minTrackingConfidence:.5});
  // Simulate the second debounce firing while the first API call is pending.
  fireDebounce(); await flush(); assert.equal(updates.length,2,'setOptions never overlaps');
  releaseUpdate(); await flush();
  assert.equal(tuned.appliedConfidence.minTrackingConfidence,.6);
  fireDebounce(); await flush(); assert.equal(updates.length,3);
  tuned.stop();
  assert(tuningStream.track.stopped,'OFF stops the camera immediately even during tuning');
  assert.equal(tuningCloses,0,'OFF waits before closing a detector with an active setOptions');
  releaseUpdate(); await flush();
  assert.equal(tuningCloses,1);
  assert.equal(tuned.phase,'OFF'); assert.equal(timers.size,0,'late option update cannot revive a stopped controller');
  assert.equal(tuned.confidence.minTrackingConfidence,.5,'settings survive OFF/HOME');
  tuned.setConfidence({minTrackingConfidence:99,minHandPresenceConfidence:-1,minHandDetectionConfidence:NaN});
  assert.equal(tuned.confidence.minTrackingConfidence,.8);
  assert.equal(tuned.confidence.minHandPresenceConfidence,.2);
  assert.equal(tuned.confidence.minHandDetectionConfidence,.3);
  console.log('PASS: slow rotation, persistent spin, frame-independent damping, pinch/fist brakes, all edge exits, fist depth/density axis lock and single commit, two-hand zoom/roll, exclusive pointing, camera/error lifecycle, 300ms confidence debounce, serialized setOptions, and OFF during an update.');
})().catch(error => { console.error(error); process.exitCode = 1; });
