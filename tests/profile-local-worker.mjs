// Local diagnostics only. The file picker supplies the selected game directly;
// the loopback server serves app/core assets and never serves or uploads games.
// Example: LOCAL_GAME_PATH=... PERF_CORE_DIR=... PERF_SYMBOLS=... node tests/profile-local-worker.mjs
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const wad = process.env.LOCAL_GAME_PATH || process.env.LOCAL_WAD_PATH || process.env.PERF_WAD;
if (!wad) throw new Error('Set LOCAL_GAME_PATH to the local game. No title is served or uploaded.');
const wadPath = path.resolve(wad);
const root = path.resolve(process.env.PERF_DIST || 'dist');
const core = path.resolve(process.env.PERF_CORE_DIR || path.join(root, 'core'));
const output = path.resolve(process.env.PERF_OUT || 'native-performance/local-worker-profile.json');
const symbolsPath = process.env.PERF_SYMBOLS ? path.resolve(process.env.PERF_SYMBOLS) : null;
const settings = {
  warmup: Number(process.env.PERF_WARMUP || 240),
  frames: Number(process.env.PERF_FRAMES || 120),
  renderer: process.env.PERF_RENDERER || 'hardware',
  video: process.env.PERF_VIDEO || 'bitmap',
  advance: process.env.PERF_ADVANCE === '1',
  inputSteps: JSON.parse(process.env.PERF_INPUT_STEPS || '[]'),
  samplingIntervalUs: Number(process.env.PERF_SAMPLE_US || 1000),
  guestProfile: process.env.PERF_GUEST_PROFILE === '1',
};
if (!Number.isInteger(settings.warmup) || settings.warmup < 120 || settings.warmup > 12000 ||
    !Number.isInteger(settings.frames) || settings.frames < 10 || settings.frames > 2000 ||
    !['hardware', 'software'].includes(settings.renderer) || !['bitmap', 'pixels'].includes(settings.video) ||
    !Number.isInteger(settings.samplingIntervalUs) || settings.samplingIntervalUs < 100)
  throw new Error('Invalid profile settings: warmup 120–12000, frames 10–2000, hardware/software renderer, sample interval >=100us.');
if (!Array.isArray(settings.inputSteps) || settings.inputSteps.some(step =>
  !Number.isInteger(step.atFrame) || step.atFrame < 0 ||
  !Number.isInteger(step.holdFrames ?? 1) || (step.holdFrames ?? 1) < 1))
  throw new Error('PERF_INPUT_STEPS requires nonnegative atFrame and positive holdFrames.');
await fs.access(wadPath);
const wasmSha256 = createHash('sha256').update(await fs.readFile(path.join(core, 'dolphin-core.wasm'))).digest('hex');
if (process.env.PERF_EXPECT_WASM_SHA256 && process.env.PERF_EXPECT_WASM_SHA256 !== wasmSha256)
  throw new Error('Candidate Wasm checksum mismatch; refusing ambiguous profile.');
const symbolText = symbolsPath ? await fs.readFile(symbolsPath, 'utf8') : '';
const symbols = new Map(symbolText.split(/\r?\n/).filter(line => /^\d+:/.test(line)).map(line => {
  const colon = line.indexOf(':');
  return [line.slice(0, colon), line.slice(colon + 1)];
}));
const playwright = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');

const instrumentation = `
self.__profileTotals = {};
self.__profileHostVideoDepth = 0;
self.__setGuestProfile = function(enabled) {
  const module = adapter?.module;
  if (typeof module?._dweb_set_cpu_profile !== 'function' ||
      typeof module?._dweb_reset_cpu_profile !== 'function' ||
      typeof module?._dweb_cpu_profile !== 'function')
    throw new Error('Guest profiling requires a native diagnostic build.');
  if (enabled) module._dweb_reset_cpu_profile();
  module._dweb_set_cpu_profile(Number(enabled));
};
self.__readGuestProfile = function() {
  return adapter.module.cwrap('dweb_cpu_profile', 'string', [])();
};
self.__profileAdd = function(name, elapsed) {
  const item = self.__profileTotals[name] ||= { calls: 0, ms: 0 };
  item.calls++; item.ms += elapsed;
};
if (typeof OffscreenCanvas !== 'undefined') {
  const transfer = OffscreenCanvas.prototype.transferToImageBitmap;
  if (transfer) OffscreenCanvas.prototype.transferToImageBitmap = function(...args) {
    const start = performance.now();
    try { return transfer.apply(this, args); }
    finally { self.__profileAdd('host.transferToImageBitmap', performance.now() - start); }
  };
  const getContext = OffscreenCanvas.prototype.getContext;
  const observed = new WeakSet();
  OffscreenCanvas.prototype.getContext = function(...args) {
    const gl = getContext.apply(this, args);
    if (gl && args[0] === 'webgl2' && !observed.has(gl)) {
      observed.add(gl);
      for (const name of ['getParameter', 'readPixels', 'getBufferSubData', 'bufferSubData', 'bufferData',
          'finish', 'flush', 'compileShader', 'linkProgram', 'getShaderParameter', 'getProgramParameter',
          'getShaderInfoLog', 'getProgramInfoLog', 'getUniformBlockIndex', 'clientWaitSync', 'drawArrays', 'drawElements']) {
        const method = gl[name];
        if (!method) continue;
        gl[name] = function(...params) {
          const start = performance.now();
          try { return method.apply(this, params); }
          finally {
            const suffix = ['bufferData', 'bufferSubData'].includes(name) ? '.' + params[0] : '';
            self.__profileAdd((self.__profileHostVideoDepth ? 'host.' : 'backend.') + name + suffix, performance.now() - start);
          }
        };
      }
    }
    return gl;
  };
}
const profileAddListener = self.addEventListener.bind(self);
self.addEventListener = function(type, listener, ...options) {
  if (type !== 'message') return profileAddListener(type, listener, ...options);
  return profileAddListener(type, function(event) {
    // The injected prelude shares the source module's lexical scope. Capture the
    // ABI after boot, so the timer measures the native call rather than queue wait.
    if (event.data?.type === 'frame' && adapter?.native && !adapter.native.runFrame.__profiled) {
      const native = adapter.native.runFrame;
      adapter.native.runFrame = function(...args) {
        const start = performance.now();
        try { return native.apply(this, args); }
        finally { self.__profileAdd('native.runFrame', performance.now() - start); }
      };
      adapter.native.runFrame.__profiled = true;
    }
    return listener.call(this, event);
  }, ...options);
};
const profilePostMessage = self.postMessage.bind(self);
self.postMessage = function(message, ...rest) {
  if (message.type === 'frame-done') {
    message.profileTotals = self.__profileTotals;
    self.__profileTotals = {};
  }
  return profilePostMessage(message, ...rest);
};
`;
const hostBoundary = 'function WebPostHardwareVideo(width,height){';
const profiledBoundary = `function WebPostHardwareVideo(width,height){
  const start=performance.now(); self.__profileHostVideoDepth++;
  try{return __profileHardwareVideoBody(width,height)}
  finally{self.__profileHostVideoDepth--; self.__profileAdd('host.WebPostHardwareVideo',performance.now()-start)}
}function __profileHardwareVideoBody(width,height){`;
let hostBoundaryInstrumented = false;
const server = http.createServer(async (request, response) => {
  const relative = decodeURIComponent(new URL(request.url, 'http://localhost').pathname).slice(1);
  const headers = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cache-Control': 'no-store' };
  if (relative === 'profile.html') {
    response.writeHead(200, { ...headers, 'Content-Type': 'text/html' }).end('<!doctype html><title>Local emulator profile</title><input id="localGame" type="file">');
    return;
  }
  const base = relative.startsWith('core/') ? core : root;
  const file = path.resolve(base, relative.startsWith('core/') ? relative.slice(5) : relative);
  if (!file.startsWith(base + path.sep)) { response.writeHead(403).end(); return; }
  try {
    await fs.access(file);
    response.writeHead(200, { ...headers,
      'Content-Type': ({ '.js': 'text/javascript', '.wasm': 'application/wasm' })[path.extname(file)] || 'application/octet-stream' });
    if (relative === 'src/dolphin-worker.js') response.end(instrumentation + await fs.readFile(file, 'utf8'));
    else if (relative === 'core/dolphin-core.js') {
      const original = await fs.readFile(file, 'utf8');
      hostBoundaryInstrumented = original.includes(hostBoundary);
      response.end(hostBoundaryInstrumented ? original.replace(hostBoundary, profiledBoundary) : original);
    } else createReadStream(file).pipe(response);
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
let cdp;
let workerSession;
let target;
let messageId = 0;
const pendingCommands = new Map();
const workerCommand = (method, params = {}, sessionId = workerSession) => new Promise((resolve, reject) => {
  const id = ++messageId;
  const timer = setTimeout(() => { pendingCommands.delete(id); reject(new Error(`Worker CDP timeout: ${method}`)); }, 30000);
  pendingCommands.set(id, { resolve: result => { clearTimeout(timer); resolve(result); },
    reject: error => { clearTimeout(timer); reject(error); } });
  cdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method, params }) }).catch(error => {
    pendingCommands.delete(id); clearTimeout(timer); reject(error);
  });
});

try {
  browser = await playwright.chromium.launch({ headless: true,
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  const context = await browser.newContext();
  const page = await context.newPage();
  cdp = await context.newCDPSession(page);
  cdp.on('Target.receivedMessageFromTarget', ({ message }) => {
    const data = JSON.parse(message);
    const waiter = pendingCommands.get(data.id);
    if (!waiter) return;
    pendingCommands.delete(data.id);
    data.error ? waiter.reject(new Error(JSON.stringify(data.error))) : waiter.resolve(data.result);
  });
  cdp.on('Target.attachedToTarget', event => {
    if (event.targetInfo.type === 'worker' && event.targetInfo.url.includes('/src/dolphin-worker.js')) {
      workerSession = event.sessionId;
      target = event.targetInfo;
    }
    // The core also creates pthread workers; each attached target must resume.
    workerCommand('Runtime.runIfWaitingForDebugger', {}, event.sessionId).catch(error => console.error(error.message));
  });
  await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: false });
  await page.goto(`http://127.0.0.1:${server.address().port}/profile.html`);
  await page.evaluate(async settings => {
    const worker = new Worker('./src/dolphin-worker.js', { type: 'module' });
    const state = window.profileState = { logs: [], videos: 0, bitmaps: 0, frames: 0, phase: 'init' };
    let pending;
    const send = (message, type) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending = null; reject(new Error(`Worker timeout: ${type}`)); }, 120000);
      pending = { type, resolve: data => { clearTimeout(timer); resolve(data); },
        reject: error => { clearTimeout(timer); reject(error); } };
      worker.postMessage(message);
    });
    worker.onmessage = ({ data }) => {
      // Optional ignored diagnostic shims can attach per-program completed GPU
      // draws and shader sources. Retain them locally in the profile report.
      if (data.drawProfile) (state.drawProfiles ||= []).push(data.drawProfile);
      if (data.type === 'video') { state.videos++; state.bitmaps += Number(!!data.bitmap); data.bitmap?.close(); }
      if (data.type === 'log' || data.type === 'status') { state.logs.push(data.message); if (state.logs.length > 40) state.logs.shift(); }
      if (data.type === pending?.type) { const waiter = pending; pending = null; waiter.resolve(data); }
      else if (data.type === 'error' || data.type === 'unavailable') pending?.reject(new Error(data.message));
    };
    worker.onerror = event => pending?.reject(new Error(event.message));
    window.runProfileFrames = async count => {
      const durations = [], totals = {};
      const start = performance.now();
      const videosBefore = state.videos;
      const bitmapsBefore = state.bitmaps;
      for (let frame = 0; frame < count; frame++) {
        if (settings.inputSteps.length) {
          const buttons = {}, axes = {};
          for (const step of settings.inputSteps) {
            if (state.frames < step.atFrame || state.frames >= step.atFrame + (step.holdFrames ?? 1)) continue;
            const pressed = { ...(step.buttons || {}), ...(step.button ? { [step.button]: true } : {}) };
            for (const [name, value] of Object.entries(pressed)) buttons[name] = buttons[name] || !!value;
            for (const [name, value] of Object.entries(step.axes || {})) {
              if (Math.abs(value) >= Math.abs(axes[name] || 0)) axes[name] = value;
            }
          }
          const snapshot = JSON.stringify({ buttons, axes });
          if (snapshot !== state.lastInput) { worker.postMessage({ type: 'input', snapshot: { buttons, axes } }); state.lastInput = snapshot; }
        } else if (settings.advance && state.frames >= 180 && (state.frames % 90 === 0 || state.frames % 90 === 8))
          worker.postMessage({ type: 'input', snapshot: { buttons: state.frames % 90 === 0 ? { A: true, Y: true, SELECT: true } : {} } });
        const frameStart = performance.now();
        const result = await send({ type: 'frame' }, 'frame-done');
        durations.push(performance.now() - frameStart);
        for (const [name, value] of Object.entries(result.profileTotals || {})) {
          const total = totals[name] ||= { calls: 0, ms: 0 };
          total.calls += value.calls; total.ms += value.ms;
        }
        state.frames++;
      }
      const elapsedMs = performance.now() - start;
      const sorted = [...durations].sort((a, b) => a - b);
      return { frames: count, elapsedMs, uncappedFps: count * 1000 / elapsedMs,
        medianFrameMs: sorted[Math.floor(count / 2)], p95FrameMs: sorted[Math.floor(count * 0.95)],
        videoMessages: state.videos - videosBefore, videoBitmaps: state.bitmaps - bitmapsBefore, durations, totals };
    };
    await send({ type: 'init', renderer: settings.renderer, video: settings.video }, 'ready');
    window.bootLocalGame = async () => {
      const file = document.querySelector('#localGame').files[0];
      if (!file) throw new Error('No local game was selected.');
      await send({ type: 'boot', file }, 'booted');
      state.phase = 'warmup';
    };
  }, settings);
  await page.locator('#localGame').setInputFiles(wadPath);
  await page.evaluate(() => window.bootLocalGame());
  if (!workerSession) throw new Error('The Dolphin worker was not attached for CPU profiling.');
  console.log(JSON.stringify({ phase: 'attached', browser: browser.version(), wasmSha256, settings, hostBoundaryInstrumented }));
  await workerCommand('Profiler.enable');
  await workerCommand('Profiler.setSamplingInterval', { interval: settings.samplingIntervalUs });
  for (let completed = 0; completed < settings.warmup; completed += 30) {
    const count = Math.min(30, settings.warmup - completed);
    await page.evaluate(count => window.runProfileFrames(count), count);
    console.log(JSON.stringify({ phase: 'warmup', frames: completed + count }));
  }
  await page.evaluate(() => { window.profileState.phase = 'measurement'; });
  const guestCommand = async expression => {
    const result = await workerCommand('Runtime.evaluate', { expression, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || 'Guest profile command failed');
    return result.result.value;
  };
  if (settings.guestProfile) await guestCommand('self.__setGuestProfile(true)');
  await workerCommand('Profiler.start');
  const measured = await page.evaluate(count => window.runProfileFrames(count), settings.frames);
  const { profile } = await workerCommand('Profiler.stop');
  let guestProfile = null;
  if (settings.guestProfile) {
    await guestCommand('self.__setGuestProfile(false)');
    guestProfile = JSON.parse(await guestCommand('self.__readGuestProfile()'));
  }
  const nodes = new Map(profile.nodes.map(node => [node.id, { ...node, selfUs: 0, inclusiveUs: 0 }]));
  const parents = new Map();
  for (const node of nodes.values()) for (const child of node.children || []) parents.set(child, node.id);
  for (let i = 0; i < (profile.samples || []).length; i++) {
    const id = profile.samples[i], time = profile.timeDeltas[i] || 0;
    nodes.get(id).selfUs += time;
    for (let cursor = id; cursor !== undefined; cursor = parents.get(cursor)) nodes.get(cursor).inclusiveUs += time;
  }
  const functions = new Map();
  for (const node of nodes.values()) {
    const originalName = node.callFrame.functionName || '(anonymous)';
    const index = originalName.match(/wasm-function\[(\d+)\]/)?.[1];
    const name = index && symbols.has(index) ? symbols.get(index) : originalName;
    const key = name + '|' + node.callFrame.url;
    const result = functions.get(key) || { name, originalName, url: node.callFrame.url, selfMs: 0, inclusiveMs: 0 };
    result.selfMs += node.selfUs / 1000; result.inclusiveMs += node.inclusiveUs / 1000;
    functions.set(key, result);
  }
  const all = [...functions.values()];
  const report = { measuredAt: new Date().toISOString(), settings, core, wasmSha256, browser: browser.version(),
    target: target.url, hostBoundaryInstrumented, measured, guestProfile, state: await page.evaluate(() => window.profileState),
    symbols: symbolsPath ? { file: symbolsPath, entries: symbols.size,
      sha256: createHash('sha256').update(symbolText).digest('hex'),
      provenance: 'Supply the symbol map from the same core build; Wasm and map hashes are recorded for verification.' } : null,
    sampledMs: (profile.timeDeltas || []).reduce((a, b) => a + b, 0) / 1000,
    topSelf: [...all].sort((a, b) => b.selfMs - a.selfMs).slice(0, 40),
    topInclusive: [...all].sort((a, b) => b.inclusiveMs - a.inclusiveMs).slice(0, 40),
    scope: 'Uncapped local title native worker profile. GL call wall times include driver waits. Nested native/host/backend totals overlap; do not sum them. Excludes main-thread presentation, audio playback and display pacing. CPU samples do not measure GPU execution; native frame cadence is distinct from rendered game FPS.' };
  await fs.mkdir(path.dirname(output), { recursive: true });
  const rawOutput = output.replace(/\.json$/i, '') + '.cpuprofile';
  await fs.writeFile(rawOutput, JSON.stringify(profile));
  await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ phase: 'done', frames: measured.frames, uncappedFps: measured.uncappedFps,
    nativeMs: measured.totals['native.runFrame']?.ms, totals: measured.totals,
    topSelf: report.topSelf.slice(0, 12), topInclusive: report.topInclusive.slice(0, 12), output, rawOutput }));
} finally {
  for (const waiter of pendingCommands.values()) waiter.reject(new Error('Profiler closed.'));
  pendingCommands.clear();
  await browser?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
