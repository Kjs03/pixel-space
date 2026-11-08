(async () => {
  const report = document.querySelector('#report'), lines = [];
  const realModel = new URLSearchParams(location.search).has('model');
  const check = (condition, message) => {
    if (!condition) throw new Error(message);
    lines.push(`PASS: ${message}`); report.textContent = lines.join('\n');
  };
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (condition, label) => {
    const deadline = performance.now() + (realModel ? 45000 : 12000);
    while (!condition()) { if (performance.now() > deadline) throw new Error(`Timeout: ${label}`); await wait(30); }
  };
  let child, cameraInterval;
  try {
    const base = new URL('../', location.href).href;
    const source = await (await fetch(new URL('index.html', base), { cache: 'no-store' })).text();
    const fixture = new DOMParser().parseFromString(source, 'text/html');
    const baseNode = fixture.createElement('base'); baseNode.href = base; fixture.head.prepend(baseNode);
    const frame = document.createElement('iframe'); frame.title = 'Real PIXEL SPACE application under test'; frame.style.width='1000px';
    const loaded = new Promise(resolve => frame.addEventListener('load', resolve, { once: true }));
    frame.srcdoc = '<!doctype html>' + fixture.documentElement.outerHTML; document.body.append(frame); await loaded;
    child = frame.contentWindow;
    await child.tryDemo(); child.finishTransition();
    const camera = child.document.createElement('canvas'); camera.width = 400; camera.height = 300;
    const ctx = camera.getContext('2d');
    const paint = () => {
      ctx.fillStyle='#172235'; ctx.fillRect(0,0,400,300);
      ctx.fillStyle='#617087'; ctx.font='16px monospace'; ctx.fillText('SYNTHETIC CAMERA', 20, 275);
      ctx.fillStyle='#b6a293'; ctx.beginPath(); ctx.ellipse(200,160,52,55,0,0,Math.PI*2); ctx.fill();
    };
    paint(); cameraInterval=setInterval(paint, 50);
    const stream = camera.captureStream(20);
    let cameras=0, detections=0, optionUpdates=[];
    Object.defineProperty(child.navigator,'mediaDevices',{configurable:true,value:{getUserMedia:async()=>{cameras++;return stream;}}});
    child.testDetector={
      detectForVideo(){ detections++; return {landmarks:[]}; },
      async setOptions(options){ optionUpdates.push({...options}); await wait(20); },
      close(){}
    };
    if (!realModel) child.eval('HandControl.prototype.loadLandmarker = async () => window.testDetector;');
    const button=child.document.querySelector('#hand-control'); button.click();
    check(button.textContent==='HAND CONTROL STARTING...','button still acknowledges synchronously');
    await until(()=>{
      if (child.eval('hand.phase === "ERROR"')) throw new Error(child.eval('hand.detail'));
      return child.eval('hand.phase === "ON"');
    },'HAND ON');
    const hand=child.eval('hand'), debug=child.document.querySelector('#hand-debug');
    if (realModel) {
      const detector=hand.landmarker;
      const detect=detector.detectForVideo.bind(detector), update=detector.setOptions.bind(detector);
      detector.detectForVideo=(...args)=>{detections++;return detect(...args);};
      detector.setOptions=async options=>{optionUpdates.push({...options});await update(options);};
      check(detector!==child.testDetector,'real MediaPipe model and WASM initialize without a detector double');
    }
    check(!debug.hidden && hand.video.parentElement.className==='hand-camera-image','ON mounts the same live camera video in the preview');
    check(Math.abs(debug.getBoundingClientRect().width-202)<1,'desktop preview frame is 202px (200px content)');
    check(child.getComputedStyle(hand.video.parentElement).transform==='matrix(-1, 0, 0, 1, 0, 0)','video and skeleton share one horizontal mirror');
    await until(()=>detections>=3,'inference loop');
    const before=detections;
    child.clearTimeout(hand.timer); hand.timer=null;
    // Deterministic landmark playback is independent of where a person happens
    // to move the mouse while these browser tests run. Priority has unit checks.
    const realBlocked=hand.blocked; hand.blocked=()=>false;
    hand.lastVideoTime=hand.video.currentTime; hand.detect(hand.session); child.clearTimeout(hand.timer); hand.timer=null;
    check(detections===before,'same video frame is never inferred twice');
    const confidenceKeys=['minHandDetectionConfidence','minHandPresenceConfidence','minTrackingConfidence'];
    for(const [preset,values] of [['SENSITIVE',[.3,.3,.35]],['BALANCED',[.4,.4,.45]],['STRICT',[.6,.6,.6]]]) {
      const oldUpdates=optionUpdates.length;
      debug.querySelector(`[data-hand-preset="${preset}"]`).click();
      check(confidenceKeys.every((key,i)=>Number(debug.querySelector(`[data-confidence="${key}"]`).value)===values[i]),`${preset}: actual slider values`);
      await until(()=>optionUpdates.length>oldUpdates && !hand.tuneOperation && !hand.tuneTimer,`${preset} applied`);
      check(confidenceKeys.every((key,i)=>hand.appliedConfidence[key]===values[i] && optionUpdates.at(-1)[key]===values[i]),`${preset}: values reach detector setOptions`);
      check(cameras===1 && hand.stream===stream,`${preset}: camera stream is preserved`);
    }
    const input=debug.querySelector('[data-confidence="minHandDetectionConfidence"]');
    const countUpdates=optionUpdates.length;
    for(const value of [.25,.35,.5]) {input.value=String(value);input.dispatchEvent(new child.Event('input',{bubbles:true}));}
    check(debug.querySelector(`output[for="${input.id}"]`).textContent==='0.50','slider number changes immediately');
    check(debug.textContent.includes('TUNING...'),'pending update reports TUNING');
    await until(()=>optionUpdates.length>countUpdates && !hand.tuneOperation && !hand.tuneTimer,'debounced slider');
    check(optionUpdates.length===countUpdates+1 && hand.appliedConfidence.minHandDetectionConfidence===.5,'rapid slider inputs produce one detector update');
    child.clearTimeout(hand.timer); hand.timer=null;
    let now=performance.now();
    const feed=(points,frames=1)=>{for(let i=0;i<frames;i++){now+=50;hand.consume(points,now);hand.publishResult(points,now);}};
    const fresh=()=>{hand.interrupt();child.eval('state.rotationX=0;state.rotationY=0;state.rotationZ=0;state.zoom=1;');now+=1000;};
    fresh();feed([handFixture()]);feed([handFixture(.48,.51)]);hand.tick(.05);
    check(child.eval('state.rotationY>0 && state.rotationX>0'),'A: slow open-hand delta rotates the real application');
    fresh();feed([handFixture()]);feed([handFixture(.37)]);feed([]);
    const beforeSpin=child.eval('state.rotationY');for(let i=0;i<180;i++) hand.tick(1/60);
    check(hand.spinActive && child.eval('state.rotationY')>beforeSpin+3,'B: spin continues after removing the hand');
    feed([handFixture(.5,.5,'pinch')]);check(hand.gesture==='GRABBING' && hand.rotationVelocityY===0,'C: pinch brakes spin');
    fresh();feed([handFixture()]);feed([handFixture(.37)]);feed([handFixture(.37,.5,'fist')],5);
    check(hand.gesture==='FIST_BRAKE' && hand.rotationVelocityY===0,'D: a short stable fist brakes spin');
    fresh();feed([handFixture(.5,.70)]);feed([handFixture(.5,.86)]);hand.tick(.05);
    check(child.eval('state.rotationX===0 && state.rotationY===0'),'E: lowering a hand through the exit boundary adds no rotation');
    fresh();feed([handFixture(.5,.5,'fist')],15);
    for(let i=1;i<=12;i++) feed([handFixture(.5,.5-i*.012,'fist')]);
    check(child.eval('state.depth>.65') && child.document.querySelector('#hand-parameter-hud').textContent.includes('DEPTH'),'F: fist up changes real Depth and HUD');
    const highDepth=child.eval('state.depth');for(let i=1;i<=12;i++) feed([handFixture(.5,.356+i*.012,'fist')]);
    check(child.eval('state.depth')<highDepth,'F: fist down reduces Depth');feed([]);
    fresh();
    child.eval('window.originalBuildField=buildField;window.testRebuilds=0;buildField=function(){window.testRebuilds++;return window.originalBuildField();};');
    feed([handFixture(.5,.5,'fist')],15);for(let i=1;i<=16;i++)feed([handFixture(.5-i*.009,.5,'fist')]);
    check(child.testRebuilds===0 && hand.adjustment.value>240,'G: density is previewed without geometry rebuild');
    feed([handFixture(.356)],6);check(child.testRebuilds===1 && Number(child.document.querySelector('#density').value)>240,'G: fist release rebuilds real GPU geometry exactly once');
    feed([]);check(child.testRebuilds===1,'G: subsequent tracking loss cannot double rebuild');
    child.eval('buildField=window.originalBuildField;');
    fresh();feed([handFixture(.35),handFixture(.65)],4);for(let i=0;i<8;i++)feed([handFixture(.25,.53),handFixture(.75,.47)]);
    check(child.eval('state.zoom>1 && Math.abs(state.rotationZ)>.005'),'H: two hands zoom and roll the real image');
    fresh();feed([handFixture(.5,.5,'point')]);feed([handFixture(.43,.52,'point')]);
    check(hand.gesture==='POINTING' && child.eval('handPointer.active && handPointer.speed>0 && state.rotationY===0'),'I: exclusive pointing reaches the existing pixel/color-sound pointer');
    const overlay=debug.querySelector('canvas');
    check(overlay.getContext('2d').getImageData(0,0,overlay.width,overlay.height).data.some((value,index)=>index%4===3 && value>0),'actual canvas contains the hand skeleton');
    feed([handFixture(.5,.5,'pinch')]);
    check(debug.querySelector('.hand-pinch-distance').textContent!=='PINCH DIST —','normalized pinch distance is visible');
    const proof=document.createElement('img');proof.alt='Actual preview canvas rendered from a synthetic pinch result';proof.src=overlay.toDataURL();document.body.append(proof);
    feed([]);check(!overlay.getContext('2d').getImageData(0,0,overlay.width,overlay.height).data.some((value,index)=>index%4===3 && value>0),'no landmarks clears the skeleton immediately');
    debug.querySelector('#hand-preview-toggle').click();check(debug.querySelector('#hand-debug-content').hidden,'collapse keeps only compact status');
    debug.querySelector('#hand-preview-toggle').click();check(!debug.querySelector('#hand-debug-content').hidden,'preview expands again');
    hand.blocked=realBlocked;
    const retained={...hand.confidence};hand.stop();
    check(debug.hidden && stream.getTracks().every(track=>track.readyState==='ended'),'OFF hides preview and ends the camera stream');
    child.backToLanding();await child.tryDemo();child.finishTransition();
    check(confidenceKeys.every(key=>hand.confidence[key]===retained[key]),'HOME → Viewer preserves tracking settings');
    frame.style.width='390px';await wait(80);
    check(Math.abs(debug.getBoundingClientRect().width)===0,'OFF preview remains hidden on mobile');
    report.textContent=`COMPLETE — ${lines.length} checks passed. ${realModel ? 'Real MediaPipe model/setOptions; ' : ''}Synthetic camera/gesture landmarks. Live hand accuracy still requires a person.\n\n`+lines.join('\n');
    document.title='PASS — Hand studio integration';
  } catch(error) {
    report.textContent=`FAIL: ${error.stack||error}\n\n`+lines.join('\n');document.title='FAIL — Hand studio integration';
  } finally {
    clearInterval(cameraInterval);
    child?.eval('if(typeof hand.stop === "function")hand.stop();');
  }
})();
