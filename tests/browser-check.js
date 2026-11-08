// Real decoder, file-input change event, and GPU checks. Open tests/browser.html.
(async () => {
  const report = document.createElement('pre');
  report.setAttribute('role', 'status');
  Object.assign(report.style, {
    position: 'fixed',
    zIndex: '100',
    inset: '16px',
    padding: '24px',
    overflow: 'auto',
    background: '#050a16f5',
    color: '#dce7ff',
    whiteSpace: 'pre-wrap',
    font: '14px/1.7 monospace',
  });
  document.body.append(report);
  const lines = [];
  const fatalErrors = [];
  window.addEventListener('error', event => fatalErrors.push(event.message));
  window.addEventListener('unhandledrejection', event => fatalErrors.push(String(event.reason)));
  const check = (condition, message) => {
    if (!condition) throw new Error(message);
    lines.push(`PASS: ${message}`);
    report.textContent = lines.join('\n');
  };
  const until = async (condition) => {
    const deadline = performance.now() + 5000;
    while (!condition()) {
      if (performance.now() > deadline) throw new Error('Image input timed out');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };
  try {
    await examplesReady;
    check(!state.viewer, 'Landing starts without viewer controls');
    check(!document.querySelector('.example, .subtitle'), 'No photo cards or subcopy');
    await tryDemo();
    finishTransition();
    check(state.viewer && positions.length > 0, 'Local demo opens a pixel field');
    check(state.name === 'sample.jpg' && state.source.width / state.source.height > 1.7, 'sample.jpg demo preserves its aspect ratio');
    check(atmosphere.fragments.length > 500, 'Source RGB debris and halo created');
    check(sound.context === null, 'Audio stays off until a SOUND gesture');
    check(hand.phase === 'OFF' && hand.stream == null && hand.video?.srcObject == null, 'Landing/demo never start a webcam automatically');
    backToLanding();

    const source = document.createElement('canvas');
    source.width = 360;
    source.height = 240;
    const ctx = source.getContext('2d');
    const gradient = ctx.createLinearGradient(0, 0, 360, 0);
    gradient.addColorStop(0, '#102038');
    gradient.addColorStop(1, '#f8deb5');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 360, 240);
    for (const type of ['image/png', 'image/jpeg', 'image/webp']) {
      const blob = await new Promise(resolve => source.toBlob(resolve, type));
      check(blob?.type === type, `${type} encoder available`);
      const filename = `verification-${type.split('/')[1]}`;
      const transfer = new DataTransfer();
      transfer.items.add(new File([blob], filename, { type }));
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await until(() => state.name === filename && state.viewer);
      finishTransition();
      check(positions.length > 0, `${type} file input decodes and enters Viewer`);
      check(baseLuminance[0] < baseLuminance[baseLuminance.length - 1], 'Source brightness preserved for sound');
      renderer.draw(positions, { ...view, opacity: 1 });
      const gl = renderer.gl;
      const pixels = new Uint8Array(32 * 32 * 4);
      gl.readPixels(
        Math.floor(renderer.canvas.width * (1 + view.offsetX) / 2) - 16,
        Math.floor(renderer.canvas.height * (1 + view.offset) / 2) - 16,
        32, 32, gl.RGBA, gl.UNSIGNED_BYTE, pixels
      );
      check(gl.getError() === gl.NO_ERROR, `${type} WebGL draw has no GPU error`);
      check(pixels.some((value, index) => index % 4 === 3 && value > 0), `${type} image pixels actually reach the framebuffer`);
    }
    const beforeSize = view.size;
    density.value = '360';
    buildField();
    check(fieldDensity === effectiveDensity(360) && view.size < beforeSize, 'Density 360 makes smaller pixels');
    pointer.active = true;
    pointer.x = view.offsetX;
    pointer.y = view.offset;
    pointer.speed = .4;
    finishTransition();
    const schedule = window.requestAnimationFrame;
    window.requestAnimationFrame = () => 0;
    try {
      for (let frame = 0; frame < 12; frame++) animate(performance.now() + frame * 16);
    } finally {
      window.requestAnimationFrame = schedule;
      frameTime = performance.now();
    }
    check(offsets.some((value, index) => index % 3 === 2 && value > .02), 'Cursor lift and ripple run with finite geometry');
    pointer.active = false;
    check(positions.every(Number.isFinite), 'Sculpture coordinates stay finite');

    const offline = new OfflineAudioContext(1, 88200, 44100);
    const instrument = new PixelSound();
    instrument.context = offline;
    instrument.connectOutput();
    check(instrument.noteForBrightness(0) < instrument.noteForBrightness(1), 'Dark pixels map to lower notes than bright pixels');
    instrument.playNote(60, .3);
    check(instrument.voices.size === 1 && [...instrument.voices][0].oscillators.length === 4, 'Piano/glass notes combine four damped partials');
    const rendered = await offline.startRendering();
    const samples = rendered.getChannelData(0);
    let peak = 0;
    for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]));
    check(peak > .001 && peak < .5, 'Actual filtered/compressed envelope renders nonzero, bounded audio');
    check(new Set([[1,0,0],[0,1,0],[0,0,1],[1,1,0]].map(rgb => instrument.noteForColor(...rgb).note)).size === 4, 'Red/green/blue/yellow choose distinct quantized notes');
    check(instrument.noteForColor(.1,0,0).note < instrument.noteForColor(1,.8,.8).note, 'HSL lightness selects lower/higher octaves');
    // Compare with the previous release's actual graph/envelopes, not a gain proxy.
    const legacy = new OfflineAudioContext(1, 88200, 44100);
    const legacyMaster = legacy.createGain();
    legacyMaster.gain.value = .7;
    legacyMaster.connect(legacy.destination);
    const legacyDelay = legacy.createDelay(.5), legacyTail = legacy.createGain();
    legacyDelay.delayTime.value = .19;
    legacyTail.gain.value = .14;
    legacyMaster.connect(legacyDelay); legacyDelay.connect(legacyTail); legacyTail.connect(legacy.destination);
    const oldEnvelope = legacy.createGain(), oldLevel = .023 + .3 * .012;
    oldEnvelope.gain.setValueAtTime(0, 0);
    oldEnvelope.gain.linearRampToValueAtTime(oldLevel, .012);
    oldEnvelope.gain.exponentialRampToValueAtTime(oldLevel * .28, .23);
    oldEnvelope.gain.exponentialRampToValueAtTime(.0001, 1.6);
    oldEnvelope.connect(legacyMaster);
    [1,2,3].forEach((harmonic, i) => {
      const osc = legacy.createOscillator(), partial = legacy.createGain();
      osc.frequency.value = 440 * 2 ** ((60 - 69) / 12) * harmonic;
      partial.gain.setValueAtTime([.72,.2,.08][i], 0);
      partial.gain.exponentialRampToValueAtTime(.0001, i === 0 ? 1.65 : .7 - i * .12);
      osc.connect(partial); partial.connect(oldEnvelope); osc.start(); osc.stop(1.7);
    });
    const oldSamples = (await legacy.startRendering()).getChannelData(0);
    const rms = data => Math.sqrt(data.reduce((sum, sample) => sum + sample * sample, 0) / data.length);
    const volumeRatio = rms(samples) / rms(oldSamples);
    check(volumeRatio >= 1.5 && volumeRatio <= 2.5, `New/previous RMS amplitude ratio: ${volumeRatio.toFixed(2)} (listening still required)`);
    const chordContext = new OfflineAudioContext(1, 88200, 44100), chord = new PixelSound();
    chord.context = chordContext; chord.connectOutput();
    [36,48,60,64,79,84,72].forEach(note => chord.playNote(note, 1, 1));
    check(chord.voices.size === 6, 'Polyphony never exceeds six voices');
    const chordSamples = (await chordContext.startRendering()).getChannelData(0);
    check(chordSamples.every(Number.isFinite) && Math.max(...chordSamples.subarray(0, 40000).map(Math.abs)) < .98, 'Worst-velocity overlapping chord remains below full scale');
    instrument.enabled = true;
    instrument.silence();
    check(!instrument.wasActive, 'Sound OFF releases note activity');

    const previous = state.source;
    await uploadFile(new File(['not an image'], 'broken.png', { type: 'image/png' }));
    check(state.source === previous, 'Corrupt file preserves the current work');
    await uploadFile(undefined);
    check(state.source === previous, 'Cancelled selection preserves the current work');
    const bitmapDecoder = window.createImageBitmap;
    try {
      window.createImageBitmap = async () => { throw new Error('test fallback'); };
      const blob = await new Promise(resolve => source.toBlob(resolve, 'image/png'));
      await uploadFile(new File([blob], 'fallback.png', { type: 'image/png' }));
      check(state.name === 'fallback.png', 'Image/object URL decoder fallback works');
    } finally {
      window.createImageBitmap = bitmapDecoder;
    }
    finishTransition();
    backToLanding();
    check(!state.viewer && !field, 'Home releases the image field');
    // srcdoc inherits this document's origin, including direct-file execution.
    {
      const fixture = document.documentElement.cloneNode(true);
      fixture.querySelector('script[src="tests/browser-check.js"]').remove();
      fixture.querySelector('pre').remove();
      fixture.querySelectorAll('video').forEach(video => video.remove());
      fixture.querySelector('base').href = document.baseURI;
      for (const [width, height] of [[390, 844], [430, 932], [768, 1024], [1440, 900]]) {
        const frame = document.createElement('iframe');
        frame.style.cssText = 'position:fixed;left:-10000px;top:0;border:0;';
        frame.width = width;
        frame.height = height;
        frame.srcdoc = '<!doctype html>' + fixture.outerHTML;
        const loaded = new Promise(resolve => frame.addEventListener('load', resolve, { once: true }));
        document.body.append(frame);
        await loaded;
        const child = frame.contentWindow;
        await child.eval('examplesReady');
        const title = child.document.querySelector('h1').getBoundingClientRect();
        check(title.left >= 0 && title.right <= width, `${width}px title stays inside the viewport`);
        await child.eval('tryDemo()');
        child.eval('finishTransition()');
        const panel = child.document.querySelector('.controls').getBoundingClientRect();
        check(panel.left >= 0 && panel.right <= width && panel.top >= 0 && panel.bottom <= height, `${width}px controls fit the viewport`);
        const bounds = child.eval(`({
          left: innerWidth * (1 + view.offsetX) / 2 - fieldWidth / view.width * innerWidth / 2,
          right: innerWidth * (1 + view.offsetX) / 2 + fieldWidth / view.width * innerWidth / 2,
          bottom: innerHeight * (1 - view.offset) / 2 + fieldHeight / view.height * innerHeight / 2
        })`);
        check(bounds.right <= panel.left || bounds.bottom <= panel.top, `${width}px initial image avoids controls`);
        child.eval('renderer.dispose(); atmosphere.clear();');
        frame.remove();
      }
    }
    await new Promise(resolve => setTimeout(resolve, 30));
    check(fatalErrors.length === 0, 'No fatal errors or unhandled promise rejections during checks');
    report.textContent = 'COMPLETE — Decoder, input, GPU, audio synthesis, and 390/430/768/1440px layout checks passed.\n\n' + report.textContent;
    document.title = 'PASS — PIXEL SPACE browser checks';
  } catch (error) {
    for (const frame of document.querySelectorAll('iframe')) frame.remove();
    report.textContent = `FAIL: ${error.stack || error}\n\n${lines.join('\n')}`;
    document.title = 'FAIL — PIXEL SPACE browser checks';
  }
})();
