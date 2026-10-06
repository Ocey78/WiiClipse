import test from 'node:test';
import assert from 'node:assert/strict';

let instance = 0;
const flush = () => new Promise((resolve) => setImmediate(resolve));

async function loadApp(t, { workerFailure, audioFailure, noWebGL = false } = {}) {
  const elements = new Map();
  const element = (selector) => {
    if (!elements.has(selector)) {
      const classes = new Set();
      const listeners = new Map();
      elements.set(selector, {
        disabled: selector === '#play', textContent: '', files: [],
        classList: { add: (name) => classes.add(name), remove: (name) => classes.delete(name), contains: (name) => classes.has(name) },
        addEventListener: (type, listener) => listeners.set(type, listener),
        trigger: (type) => listeners.get(type)?.({ preventDefault() {} }),
        click() { this.clicked = true; return this.trigger('click'); },
      });
    }
    return elements.get(selector);
  };
  const gl = new Proxy({}, {
    get: (_, name) => name === 'getShaderParameter' || name === 'getProgramParameter'
      ? () => true : () => ({}),
  });
  Object.assign(element('#screen'), { clientWidth: 640, clientHeight: 480, getContext: () => noWebGL ? null : gl });
  let worker;
  class BrowserWorker {
    constructor() {
      if (workerFailure) throw new Error(workerFailure);
      this.messages = [];
      this.listeners = new Map();
      worker = this;
    }
    addEventListener(type, listener) { this.listeners.set(type, listener); }
    postMessage(message) { this.messages.push(message); }
    emit(data) { this.listeners.get('message')?.({ data }); }
    fail(message) { this.listeners.get('error')?.({ message }); }
  }
  let nextFrame;
  const globals = {
    document: { querySelector: element, querySelectorAll: () => [], createElement: () => element('#screen'), addEventListener() {} },
    navigator: {},
    window: { addEventListener() {} },
    Worker: BrowserWorker,
    requestAnimationFrame: (callback) => { nextFrame = callback; },
    AudioContext: class {
      constructor() { this.state = 'suspended'; this.currentTime = 0; }
      async resume() { if (audioFailure) throw new Error(audioFailure); }
    },
  };
  for (const [key, value] of Object.entries(globals)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    t.after(() => previous ? Object.defineProperty(globalThis, key, previous) : delete globalThis[key]);
  }
  await import(`../src/app.js?test=${++instance}`);
  const choose = () => {
    element('#gameFile').files = [{ name: 'game.dol', size: 1024 }];
    element('#gameFile').trigger('change');
  };
  return { element, worker, choose, frame: () => nextFrame() };
}

async function readyApp(t, options) {
  const app = await loadApp(t, options);
  app.worker.emit({ type: 'ready', version: 'test-fixture' });
  await flush();
  app.choose();
  return app;
}

test('worker construction failure leaves file picker working and explains startup failure', async (t) => {
  const app = await loadApp(t, { workerFailure: 'Workers are blocked' });
  app.element('#chooseGame').click();
  assert.equal(app.element('#gameFile').clicked, true);
  assert.equal(app.element('#play').disabled, true);
  assert.match(app.element('#status').textContent, /Workers are blocked/);
});

test('missing core never enables Play even after selecting a supported file', async (t) => {
  const app = await loadApp(t);
  app.worker.emit({ type: 'unavailable', message: 'Native build is missing' });
  await flush();
  app.choose();
  assert.equal(app.element('#play').disabled, true);
  assert.match(app.element('#status').textContent, /missing/);
  assert.equal(app.element('#coreState').classList.contains('ready'), false);
});

test('missing WebGL keeps Play disabled even when the native core is ready', async (t) => {
  const app = await readyApp(t, { noWebGL: true });
  assert.equal(app.element('#play').disabled, true);
  assert.match(app.element('#status').textContent, /WebGL2/);
});

test('Play waits for confirmed boot before advancing frames', async (t) => {
  const app = await readyApp(t);
  const click = app.element('#play').click();
  await flush();
  assert.equal(app.element('#play').disabled, true);
  app.frame();
  assert.equal(app.worker.messages.some(({ type }) => type === 'frame'), false);
  app.worker.emit({ type: 'booted' });
  await click;
  app.frame();
  assert.equal(app.worker.messages.at(-1).type, 'frame');
});

test('audio startup rejection is visible and permits another Play attempt', async (t) => {
  const app = await readyApp(t, { audioFailure: 'Audio is blocked' });
  await app.element('#play').click();
  assert.match(app.element('#status').textContent, /Audio is blocked/);
  assert.equal(app.element('#play').disabled, false);
  assert.equal(app.worker.messages.some(({ type }) => type === 'boot'), false);
});

test('game boot rejection restores Play and preserves native core readiness', async (t) => {
  const app = await readyApp(t);
  const click = app.element('#play').click();
  await flush();
  app.worker.emit({ type: 'error', operation: 'boot', recoverable: true, message: 'Game rejected' });
  await click;
  assert.equal(app.element('#play').disabled, false);
  assert.equal(app.element('#coreState').classList.contains('ready'), true);
  assert.match(app.element('#status').textContent, /rejected/);
});

test('worker crash revokes Play and the ready indicator', async (t) => {
  const app = await readyApp(t);
  app.worker.fail('Worker crashed');
  assert.equal(app.element('#play').disabled, true);
  assert.equal(app.element('#coreState').classList.contains('ready'), false);
  assert.match(app.element('#status').textContent, /crashed/);
});
