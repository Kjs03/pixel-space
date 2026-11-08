// Open /tests/hand-listener.html. Real DOM, real index and scripts; no webcam.
(async () => {
  const report = document.querySelector('#report');
  const lines = [];
  const check = (condition, message) => {
    if (!condition) throw new Error(message);
    lines.push(`PASS: ${message}`);
    report.textContent = lines.join('\n');
  };
  let frame;
  try {
    const base = new URL('../', location.href).href;
    const response = await fetch(new URL('index.html', base), { cache: 'no-store' });
    if (!response.ok) throw new Error(`index.html: ${response.status}`);
    const source = await response.text();
    check(source.includes('src="script.js?v=photo-only1"'), 'index requests the versioned application entry');
    check(source.includes('src="hand-control.js?v=handstudio4"'), 'index requests the versioned local hand dependency');
    for (const mode of ['pending-camera', 'missing-controller', 'throwing-constructor', 'denied-camera', 'missing-camera-api']) {
      const fixture = new DOMParser().parseFromString(source, 'text/html');
      const baseElement = fixture.createElement('base');
      baseElement.href = base;
      fixture.head.prepend(baseElement);
      const bootstrap = fixture.createElement('script');
      bootstrap.textContent = `
        window.handTest = { listeners: [], clicks: 0, cameras: 0, errors: [] };
        const originalAdd = EventTarget.prototype.addEventListener;
        EventTarget.prototype.addEventListener = function(type, listener, options) {
          if (this.id) handTest.listeners.push({ id: this.id, type, name: listener.name });
          return originalAdd.call(this, type, listener, options);
        };
        addEventListener('error', event => handTest.errors.push(event.message));
        const originalLog = console.log;
        console.log = function(...args) {
          if (args[0] === '[Hand] CLICK') handTest.clicks++;
          originalLog.apply(console, args);
        };
        Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value:
          ${mode === 'missing-camera-api' ? 'undefined' : `{
            getUserMedia() {
              handTest.cameras++;
              ${mode === 'denied-camera'
                ? "return Promise.reject(new DOMException('test denial', 'NotAllowedError'));"
                : 'return new Promise(() => {});'}
            }
          }`}
        });
      `;
      baseElement.after(bootstrap);
      const controllerScript = fixture.querySelector('script[src^="hand-control.js"]');
      if (mode === 'missing-controller') controllerScript.remove();
      if (mode === 'throwing-constructor') {
        controllerScript.src = 'data:text/javascript,' + encodeURIComponent(
          'class HandControl { constructor() { throw new Error("test constructor failure"); } }'
        );
      }
      frame = document.createElement('iframe');
      frame.style.cssText = 'position:fixed;left:-10000px;width:1000px;height:800px';
      const loaded = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`${mode}: iframe timeout`)), 15000);
        frame.addEventListener('load', () => { clearTimeout(timeout); resolve(); }, { once: true });
      });
      frame.srcdoc = '<!doctype html>' + fixture.documentElement.outerHTML;
      document.body.append(frame);
      await loaded;
      const child = frame.contentWindow;
      const button = child.document.querySelector('#hand-control');
      check(button instanceof child.HTMLButtonElement, `${mode}: actual #hand-control button exists`);
      const listeners = child.handTest.listeners.filter(item => item.id === 'hand-control' && item.type === 'click');
      check(listeners.length === 1 && listeners[0].name === 'handleHandControlClick', `${mode}: one named click listener registered on the button`);
      check(!child.document.querySelector('video') && child.handTest.cameras === 0, `${mode}: no controller/camera initialization on landing`);
      // Even a programmatic click on landing must acknowledge synchronously.
      button.click();
      check(button.textContent === 'HAND CONTROL STARTING...', `${mode}: landing .click() returns STARTING immediately`);
      await new Promise(resolve => setTimeout(resolve, 0));
      await child.tryDemo();
      child.finishTransition();
      for (const [id, type] of [['sound', 'click'], ['depth', 'input'], ['density', 'input'], ['stage', 'pointerdown']]) {
        check(child.handTest.listeners.some(item => item.id === id && item.type === type), `${mode}: ${id} listener survives optional dependency failure`);
      }
      check(child.document.body.classList.contains('is-viewer'), `${mode}: Viewer initializes`);
      button.click();
      check(button.textContent === 'HAND CONTROL STARTING...', `${mode}: Viewer .click() returns STARTING immediately`);
      check(child.handTest.clicks === 2, `${mode}: handler logs [Hand] CLICK on each click`);
      await new Promise(resolve => setTimeout(resolve, 0));
      if (mode === 'pending-camera') {
        check(button.textContent === 'HAND CONTROL STARTING...' && child.handTest.cameras === 1, `${mode}: camera starts only after click`);
        button.click();
        await new Promise(resolve => setTimeout(resolve, 0));
        check(child.handTest.cameras === 1, `${mode}: duplicate click does not request another camera`);
      } else {
        check(button.textContent === 'HAND CONTROL ERROR', `${mode}: asynchronous failure stays isolated`);
      }
      check(child.handTest.errors.length === 0, `${mode}: no uncaught application exception`);
      child.eval('hand.stop()');
      frame.remove();
      frame = null;
    }
    document.title = 'PASS — Hand listener checks';
    report.textContent = `COMPLETE — ${lines.length} checks passed. No real camera requested.\n\n` + lines.join('\n');
  } catch (error) {
    document.title = 'FAIL — Hand listener checks';
    report.textContent = `FAIL: ${error.stack || error}\n\n` + lines.join('\n');
  } finally {
    frame?.remove();
  }
})();
