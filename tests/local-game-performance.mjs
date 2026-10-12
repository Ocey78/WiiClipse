import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

// Served only by this local diagnostic harness, never included in the app.
export const compilerProbeSource = `
self.addEventListener('message', ({ data = {} }) => {
  if (data.type !== 'benchmark-compiler') return;
  enqueue(() => {
    try {
      const core = adapter?.module;
      if (typeof core?._dweb_set_browser_compiler !== 'function' ||
          typeof core?._dweb_browser_compiler_stats !== 'function')
        throw new Error('Compiler comparisons require a compiled-profile native core.');
      if (data.mode === 'on' || data.mode === 'off')
        core._dweb_set_browser_compiler(Number(data.mode === 'on'));
      const snapshot = JSON.parse(core.cwrap('dweb_browser_compiler_stats', 'string', [])());
      send('benchmark-compiler-result', { snapshot });
    } catch (error) {
      send('benchmark-compiler-result', { error: error.message });
    }
  });
});
`;

function summarizeDurations(values) {
  if (!values.length) return { count: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = ratio => sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)];
  const within60FpsBudget = values.filter(value => value <= 1000 / 60).length;
  return { count: values.length, minimumMs: sorted[0], meanMs: values.reduce((sum, value) => sum + value, 0) / values.length,
    medianMs: percentile(0.5), p90Ms: percentile(0.9), p95Ms: percentile(0.95), p99Ms: percentile(0.99),
    maximumMs: sorted.at(-1), within60FpsBudget, over60FpsBudget: values.length - within60FpsBudget };
}

function parseInputSteps(json = '[]') {
  const steps = JSON.parse(json);
  assert.ok(Array.isArray(steps), 'PERF_INPUT_STEPS must be a JSON array');
  const buttonNames = new Set(['A', 'B', 'X', 'Y', 'L', 'R', 'Z', 'START', 'SELECT', 'UP', 'DOWN', 'LEFT', 'RIGHT']);
  const axisNames = new Set(['lx', 'ly', 'rx', 'ry', 'l', 'r']);
  return steps.map(step => {
    assert.ok(Number.isInteger(step.atFrame) && step.atFrame >= 0, 'Input atFrame must be a nonnegative integer');
    const holdFrames = step.holdFrames ?? 1;
    assert.ok(Number.isInteger(holdFrames) && holdFrames > 0, 'Input holdFrames must be a positive integer');
    const buttons = { ...(step.buttons || {}), ...(step.button ? { [step.button]: true } : {}) };
    const axes = { ...(step.axes || {}) };
    for (const [name, pressed] of Object.entries(buttons)) assert.ok(buttonNames.has(name) && typeof pressed === 'boolean', `Invalid input button: ${name}`);
    for (const [name, value] of Object.entries(axes)) assert.ok(axisNames.has(name) && Number.isFinite(value) && Math.abs(value) <= 1, `Invalid input axis: ${name}`);
    return { atFrame: step.atFrame, holdFrames, buttons, axes };
  }).sort((a, b) => a.atFrame - b.atFrame);
}

function numericSetting(name, fallback, min, max, integer = true) {
  const value = Number(process.env[name] ?? fallback);
  assert.ok(Number.isFinite(value) && value >= min && value <= max && (!integer || Number.isInteger(value)), `${name} must be ${integer ? 'an integer' : 'a number'} between ${min} and ${max}`);
  return value;
}

export async function waitForGpuFence(gl, timeoutMs, {
  now = () => performance.now(),
  yieldToEventLoop = () => new Promise(resolve => setTimeout(resolve, 1))
} = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('GPU fence timeout must be positive');
  if (!gl || typeof gl.fenceSync !== 'function' || typeof gl.clientWaitSync !== 'function') {
    throw new Error('Presentation WebGL2 context cannot provide GPU fence completion timing');
  }
  const begin = now();
  if (gl.isContextLost()) throw new Error('Presentation GL context was lost before GPU completion');
  const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
  if (!sync) throw new Error('Could not create presentation GPU fence');
  try {
    gl.flush();
    while (true) {
      // WebGL fences cannot become observably signaled in the task that created
      // them. Yield between nonblocking polls instead of busy-waiting or finish().
      await yieldToEventLoop();
      if (gl.isContextLost()) throw new Error('Presentation GL context was lost before GPU completion');
      if (now() - begin >= timeoutMs) throw new Error(`Presentation GPU fence timed out after ${timeoutMs} ms`);
      const status = gl.clientWaitSync(sync, 0, 0);
      if (status === gl.ALREADY_SIGNALED || status === gl.CONDITION_SATISFIED) return now() - begin;
      if (status === gl.WAIT_FAILED) throw new Error('Presentation GPU fence wait failed');
      if (status !== gl.TIMEOUT_EXPIRED) throw new Error(`Unexpected presentation GPU fence status: ${status}`);
    }
  } finally { gl.deleteSync(sync); }
}

export function summarizeThroughput({ frames, submissionMs, gpuCompletionMs, gpuCompletedWallMs, gpuCompletionFinalized, videoMessages, emulatedSeconds }) {
  const submissionFps = submissionMs > 0 ? frames * 1000 / submissionMs : 0;
  const completed = gpuCompletionFinalized === true && gpuCompletedWallMs > 0;
  return { activeMeasuredMs: submissionMs + gpuCompletionMs, nativeFrameRequestFps: submissionFps, submissionFps,
    gpuCompletedWallFps: completed ? frames * 1000 / gpuCompletedWallMs : null,
    deliveredVideoMessagesPerSecond: completed ? videoMessages * 1000 / gpuCompletedWallMs : null,
    emulationSpeedPercent: completed ? emulatedSeconds * 100000 / gpuCompletedWallMs : null };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain && process.argv.includes('--self-test')) {
  assert.deepEqual(summarizeDurations([10, 20, 30, 40]), {
    count: 4, minimumMs: 10, meanMs: 25, medianMs: 20, p90Ms: 40, p95Ms: 40, p99Ms: 40, maximumMs: 40,
    within60FpsBudget: 1, over60FpsBudget: 3
  });
  assert.deepEqual(parseInputSteps('[{"atFrame":60,"button":"A","holdFrames":4}]'), [
    { atFrame: 60, holdFrames: 4, buttons: { A: true }, axes: {} }
  ]);
  assert.throws(() => parseInputSteps('[{"atFrame":-1,"button":"A"}]'), /atFrame/);
  assert.throws(() => parseInputSteps('[{"atFrame":0,"button":"missing"}]'), /button/);
  assert.throws(() => parseInputSteps('[{"atFrame":0,"axes":{"lx":2}}]'), /axis/);
  assert.deepEqual(summarizeThroughput({ frames: 120, submissionMs: 1000, gpuCompletionMs: 200,
    gpuCompletedWallMs: 1500, gpuCompletionFinalized: true, videoMessages: 60, emulatedSeconds: 2 }), {
    activeMeasuredMs: 1200, nativeFrameRequestFps: 120, submissionFps: 120,
    gpuCompletedWallFps: 80, deliveredVideoMessagesPerSecond: 40, emulationSpeedPercent: 200 / 1.5
  });
  console.log('Local benchmark configuration and percentile checks passed.');
} else if (isMain && process.argv.includes('--help')) {
  console.log(`Run: node tests/local-game-performance.mjs
Required: LOCAL_GAME_PATH (a local game file; never served or uploaded)
Optional environment settings:
  PERF_DIST=dist                 Built app assets
  PERF_CORE_DIR=<directory>       Override built core assets
  PERF_RENDERER=hardware|software Requested core backend (actual backend comes from logs)
  PERF_VIDEO=bitmap|pixels        Native video delivery mode, default bitmap
  PERF_COMPILER=on|off            Experimental compiled-core A/B switch and stats (opt-in)
  PERF_EXPECT_WASM_SHA256=<hash>  Refuse a core with an unexpected Wasm digest
  PERF_WARMUP=30                 Unmeasured frames before timing
  PERF_FRAMES=120                Maximum measured frame acknowledgments
  PERF_SECONDS=<seconds>         Active measured-time ceiling; no default frame limit when set alone
  PERF_TIMEOUT_MS=120000         Timeout per init, boot, frame, or GPU fence
  PERF_SCREENSHOT_FRAMES=0,1,30,150  Absolute completed frames since boot
  PERF_INPUT_STEPS='[{"atFrame":60,"button":"A","holdFrames":6}]'
    Also accepts buttons:{A:true,START:true}, axes:{lx:1}; steps merge, then release independently.
    Input names follow the current worker controller ABI; Wii title mappings need visual verification.
  PERF_PROGRESS_FRAMES=30        Partial report interval
  PERF_MAX_LOGS=2000             Retained core/status/error log entries
  PERF_OUT=<report.json>         Default native-performance/local-game/<timestamp>/report.json
  SMOKE_BROWSER=chromium        Or webkit/firefox when installed
  CHROME_PATH=<executable>       Optional Chromium executable
  PLAYWRIGHT_MODULE=<module>     Optional Playwright module path
  PERF_HEADED=1                  Show browser window
  SMOKE_HEADED=1                 Alias for PERF_HEADED
Screenshots and logs can contain game imagery; keep outputs local. Per-frame timings measure uncapped
worker execution, message delivery, and video presentation submission. GPU-completed wall FPS includes
asynchronous presenter WebGL2 fence waits before measured screenshots and at the end, while excluding
image encoding/disk/checkpoint pauses. A fence follows presentation and its worker ImageBitmap import.
Failed or timed-out fences fail the run and produce no completed-throughput figures.
They count completed native frame requests, not display refreshes. Inspect video counts, screenshot
hashes, and screenshots to assess actual game progress; acknowledgments alone do not prove gameplay.`);
} else if (isMain) {
  await runBenchmark();
}

async function runBenchmark() {
  assert.ok(process.env.LOCAL_GAME_PATH, 'Set LOCAL_GAME_PATH to a local game file. Use --help for benchmark options.');
  const gamePath = path.resolve(process.env.LOCAL_GAME_PATH);
  const gameStat = await fs.stat(gamePath);
  assert.ok(gameStat.isFile() && gameStat.size > 0, 'LOCAL_GAME_PATH must be a nonempty local file');
  const root = path.resolve(process.env.PERF_DIST || 'dist');
  const coreRoot = path.resolve(process.env.PERF_CORE_DIR || path.join(root, 'core'));
  await fs.access(path.join(root, 'src', 'dolphin-worker.js'));
  await fs.access(path.join(coreRoot, 'dolphin-core.js'));
  const coreAssets = Object.fromEntries(await Promise.all(
    ['dolphin-core.js', 'dolphin-core.wasm', 'dolphin-core.data'].map(async name =>
      [name, createHash('sha256').update(await fs.readFile(path.join(coreRoot, name))).digest('hex')])));
  if (process.env.PERF_EXPECT_WASM_SHA256)
    assert.equal(coreAssets['dolphin-core.wasm'], process.env.PERF_EXPECT_WASM_SHA256,
      'Core Wasm digest does not match the requested benchmark candidate');
  const warmup = numericSetting('PERF_WARMUP', 30, 0, 1000000);
  const maxFrames = process.env.PERF_SECONDS && !process.env.PERF_FRAMES ? null : numericSetting('PERF_FRAMES', 120, 1, 1000000);
  const maxSeconds = process.env.PERF_SECONDS ? numericSetting('PERF_SECONDS', 0, 0.001, 43200, false) : null;
  const timeoutMs = numericSetting('PERF_TIMEOUT_MS', 120000, 100, 3600000);
  const progressFrames = numericSetting('PERF_PROGRESS_FRAMES', 30, 1, 1000000);
  const maxLogs = numericSetting('PERF_MAX_LOGS', 2000, 1, 100000);
  const renderer = process.env.PERF_RENDERER;
  assert.ok(renderer === undefined || ['hardware', 'software'].includes(renderer), 'PERF_RENDERER must be hardware or software');
  const video = process.env.PERF_VIDEO || 'bitmap';
  assert.ok(['bitmap', 'pixels'].includes(video), 'PERF_VIDEO must be bitmap or pixels');
  const compiler = process.env.PERF_COMPILER || null;
  assert.ok(compiler === null || ['on', 'off'].includes(compiler), 'PERF_COMPILER must be on or off');
  const inputSteps = parseInputSteps(process.env.PERF_INPUT_STEPS);
  const screenshotFrames = process.env.PERF_SCREENSHOT_FRAMES ? process.env.PERF_SCREENSHOT_FRAMES.split(',').map(Number) : [0, 1, warmup, ...(maxFrames ? [warmup + maxFrames] : [])];
  assert.ok(screenshotFrames.every(value => Number.isInteger(value) && value >= 0), 'PERF_SCREENSHOT_FRAMES must be comma-separated nonnegative integers');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const output = path.resolve(process.env.PERF_OUT || path.join('native-performance', 'local-game', stamp, 'report.json'));
  const outputDir = path.dirname(output);
  await fs.mkdir(outputDir, { recursive: true });
  const report = {
    schemaVersion: 3, measuredAt: new Date().toISOString(), game: { name: path.basename(gamePath), sizeBytes: gameStat.size },
    gpuCompletionMethod: 'presenter-webgl2-fenceSync-flush-clientWaitSync-event-loop-poll',
    root, coreRoot, coreAssets, requestedRenderer: renderer || 'default', requestedVideo: video,
    configuration: { warmup, maxFrames, maxSeconds, timeoutMs, screenshotFrames, inputSteps, compiler },
    scope: 'Uncapped native worker frame requests and real video presentation. Per-frame/submission FPS can exclude queued GPU completion. GPU-completed wall FPS includes asynchronous milestone/final presenter WebGL2 fence waits and loop overhead; excludes image encoding/disk/checkpoint pauses, audio playback and display pacing. Presenter fences follow texture import and drawing, which depend on delivered worker ImageBitmap output; they do not prove completion of unrelated worker GPU commands or display scanout. Warmup presentation is fenced before the measured segment. Failed runs have no completed-throughput figures. Frame acknowledgments alone do not prove gameplay progress; inspect video counts and screenshots. No game file is served or uploaded.',
    status: 'starting', screenshots: [], browserErrors: [], browserConsole: [], progress: null
  };
  try { report.coreProvenance = JSON.parse(await fs.readFile(path.join(coreRoot, 'core-release.json'), 'utf8')); }
  catch { report.coreProvenance = null; }
  const saveReport = () => fs.writeFile(output, JSON.stringify(report, null, 2) + '\n');
  await saveReport();
  const server = http.createServer(async (request, response) => {
    try {
      const relative = decodeURIComponent(new URL(request.url, 'http://localhost').pathname).replace(/^\//, '');
      const base = relative.startsWith('core/') ? coreRoot : root;
      const file = path.resolve(base, relative.startsWith('core/') ? relative.slice(5) : relative);
      if (!file.startsWith(base + path.sep)) { response.writeHead(403).end(); return; }
      let body = relative === 'local-benchmark.html' ? '<!doctype html><title>WiiClipse local game benchmark</title><style>body{margin:0;background:#101820;color:white;font:16px sans-serif}canvas{display:block;width:640px;height:480px}input{margin:8px}</style><input id="localGame" type="file"><canvas id="screen" width="640" height="480"></canvas>' : await fs.readFile(file);
      if (compiler && relative === 'src/dolphin-worker.js') body = body.toString('utf8') + '\n' + compilerProbeSource;
      response.writeHead(200, { 'Content-Type': ({ '.js': 'text/javascript', '.wasm': 'application/wasm', '.html': 'text/html' })[path.extname(file)] || 'application/octet-stream',
        'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cache-Control': 'no-cache' }).end(body);
    } catch { response.writeHead(404).end(); }
  });
  let browser; let page;
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const playwright = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
    const browserName = process.env.SMOKE_BROWSER || 'chromium';
    assert.ok(playwright[browserName]?.launch, `Unsupported browser ${browserName}`);
    report.browser = browserName;
    browser = await playwright[browserName].launch({ headless: process.env.PERF_HEADED !== '1' && process.env.SMOKE_HEADED !== '1',
      ...(browserName === 'chromium' && process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
    report.browserVersion = browser.version();
    const context = await browser.newContext({ viewport: { width: 800, height: 600 } });
    page = await context.newPage();
    page.on('pageerror', error => report.browserErrors.push(error.message));
    page.on('console', message => { if (report.browserConsole.length < maxLogs) report.browserConsole.push({ type: message.type(), text: message.text() }); });
    page.on('crash', () => { report.browserErrors.push('Browser page crashed'); });
    await page.exposeFunction('benchmarkCheckpoint', async progress => {
      report.progress = progress;
      report.status = progress.status;
      await saveReport();
      console.log(JSON.stringify({ status: progress.status, completedFrames: progress.completedFrames, measuredFrames: progress.samples.length,
        activeMeasuredMs: progress.activeMeasuredMs, videoMessages: progress.totalCounters.videoMessages, report: output }));
    });
    await page.exposeFunction('benchmarkScreenshot', async milestone => {
      const name = `frame-${String(milestone.frame).padStart(6, '0')}-${milestone.label}.png`;
      const screenshotPath = path.join(outputDir, name);
      const bytes = await page.locator('#screen').screenshot({ path: screenshotPath, timeout: 30000 });
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const previous = report.screenshots.at(-1);
      report.screenshots.push({ ...milestone, path: screenshotPath, sha256, changedSincePreviousScreenshot: previous ? previous.sha256 !== sha256 : null });
      await saveReport();
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/local-benchmark.html`);
    await page.addScriptTag({ content: `window.benchmarkWaitForGpuFence = ${waitForGpuFence.toString()};` });
    await page.locator('#localGame').setInputFiles(gamePath);
    report.status = 'initializing'; await saveReport();
    const result = await page.evaluate(async config => {
      const { WebGLRenderer } = await import('./src/webgl-renderer.js');
      const { InputState } = await import('./src/input-state.js');
      const canvas = document.querySelector('#screen');
      const presenter = new WebGLRenderer(canvas); presenter.clear();
      // Query a tiny independent context before any frame timing. Retain both
      // masked and unmasked values so a SwiftShader run cannot look like AMD GPU timing.
      const graphicsProbe = document.createElement('canvas');
      graphicsProbe.width = 16; graphicsProbe.height = 16;
      const gl = graphicsProbe.getContext('webgl2', { powerPreference: 'high-performance' }) || presenter.gl;
      const debug = gl.getExtension('WEBGL_debug_renderer_info');
      const unmaskedRenderer = debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null;
      const browserGraphics = { glRenderer: gl.getParameter(gl.RENDERER), glVendor: gl.getParameter(gl.VENDOR),
        unmaskedRenderer, unmaskedVendor: debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : null,
        softwareGpuDetected: /swiftshader|llvmpipe|softpipe|software rasterizer/i.test(unmaskedRenderer || gl.getParameter(gl.RENDERER)),
        userAgent: navigator.userAgent,
        hardwareConcurrency: navigator.hardwareConcurrency, crossOriginIsolated };
      const worker = new Worker('./src/dolphin-worker.js', { type: 'module' });
      let pending = null; let fatalError = null; let state = 'initializing'; let completedFrames = 0;
      let initMs = null; let bootMs = null; let readyInfo = null; let bootInfo = null; let lastVideo = null;
      let activeMeasuredMs = 0; let submissionMeasuredMs = 0; let gpuCompletionMs = 0;
      let measuredStart = null; let measuredExcludedPauseMs = 0; let warmupGpuDrainMs = 0;
      let gpuCompletionFinalized = false; let finalizedGpuWallMs = null; let capturePauseMs = 0; let logEntriesDropped = 0;
      const compilerSnapshots = [];
      const logs = []; const errors = []; const samples = []; const warmupSamples = []; const inputEvents = [];
      const totalCounters = { videoMessages: 0, videoBytes: 0, videoBitmaps: 0, audioMessages: 0, audioFrames: 0 };
      const measuredCounters = { ...totalCounters };
      const record = message => {
        const entry = { elapsedMs: performance.now() - started, frame: completedFrames, ...message };
        if (message.type === 'error' || message.type === 'unavailable') errors.push(entry);
        if (logs.length < config.maxLogs) logs.push(entry); else logEntriesDropped++;
      };
      const fail = error => { fatalError = error; pending?.reject(error); };
      worker.addEventListener('message', ({ data }) => {
        if (data.type === 'video') {
          totalCounters.videoMessages++; totalCounters.videoBytes += data.buffer?.byteLength || 0;
          if (data.bitmap) totalCounters.videoBitmaps++;
          lastVideo = { width: data.width, height: data.height, pitch: data.pitch, pixelFormat: data.pixelFormat || 'XRGB8888', transport: data.bitmap ? 'bitmap' : 'pixels', atFrameRequest: completedFrames + 1 };
          try { presenter.presentXRGB8888(data); } catch (error) { data.bitmap?.close(); fail(error); }
        } else if (data.type === 'audio') {
          totalCounters.audioMessages++; totalCounters.audioFrames += data.frames || 0;
        } else if (['status', 'log', 'save-status', 'error', 'unavailable'].includes(data.type)) {
          record(data);
          if (data.type === 'error' || data.type === 'unavailable') fail(new Error(data.message));
        }
        if (data.type === pending?.type) pending.resolve(data);
      });
      worker.addEventListener('error', event => { record({ type: 'error', message: event.message }); fail(new Error(event.message)); });
      worker.addEventListener('messageerror', () => fail(new Error('Worker message could not be decoded')));
      const send = (message, type) => new Promise((resolve, reject) => {
        if (fatalError) { reject(fatalError); return; }
        const timer = setTimeout(() => waiter.reject(new Error(`Timed out waiting for ${type} at frame ${completedFrames}`)), config.timeoutMs);
        const waiter = { type,
          resolve(data) { clearTimeout(timer); if (pending === waiter) pending = null; resolve(data); },
          reject(error) { clearTimeout(timer); if (pending === waiter) pending = null; reject(error); } };
        pending = waiter;
        try { worker.postMessage(message); } catch (error) { waiter.reject(error); }
      });
      const progress = () => ({ status: state, completedFrames, warmupCompleted: warmupSamples.length, initMs, bootMs, browserGraphics,
        readyInfo, bootInfo, activeMeasuredMs, submissionMeasuredMs, gpuCompletionMs, warmupGpuDrainMs,
        gpuCompletionMethod: config.gpuCompletionMethod,
        gpuCompletedWallMs: finalizedGpuWallMs ?? (measuredStart === null ? 0 : performance.now() - measuredStart - measuredExcludedPauseMs),
        measuredExcludedPauseMs, gpuCompletionFinalized, capturePauseMs, lastVideo, totalCounters: { ...totalCounters },
        measuredCounters: { ...measuredCounters }, samples, warmupSamples, logs, errors, logEntriesDropped, inputEvents, compilerSnapshots });
      const readCompiler = async (phase, mode = 'read') => {
        if (!config.compiler) return;
        const result = await send({ type: 'benchmark-compiler', mode }, 'benchmark-compiler-result');
        if (result.error) throw new Error(result.error);
        compilerSnapshots.push({ ...result.snapshot, phase, frame: completedFrames });
      };
      const drainGpu = () => window.benchmarkWaitForGpuFence(presenter.gl, config.timeoutMs);
      const screenshot = async label => {
        // Fence only boundaries/milestones, after the synchronous presenter draw
        // and ImageBitmap texture import. Include the entire wait before starting
        // the separately excluded screenshot pause. Failure captures are diagnostic.
        const gpuDrainMs = label === 'failure' ? null : await drainGpu();
        if (measuredStart !== null && gpuDrainMs !== null) { gpuCompletionMs += gpuDrainMs; activeMeasuredMs += gpuDrainMs; }
        if (label === 'final') {
          gpuCompletionFinalized = true;
          finalizedGpuWallMs = performance.now() - measuredStart - measuredExcludedPauseMs;
        }
        const begin = performance.now();
        try { await window.benchmarkScreenshot({ frame: completedFrames, label, lastVideo, phase: state, gpuDrainMs }); }
        finally {
          const pause = performance.now() - begin;
          capturePauseMs += pause;
          if (measuredStart !== null) measuredExcludedPauseMs += pause;
        }
      };
      const checkpoint = async () => {
        const begin = performance.now();
        try { await window.benchmarkCheckpoint(progress()); }
        finally { if (measuredStart !== null) measuredExcludedPauseMs += performance.now() - begin; }
      };
      const milestones = new Set(config.screenshotFrames);
      const input = new InputState();
      const activeSteps = new Map();
      const applyInputs = frame => {
        let changed = false;
        for (const [index, step] of activeSteps) if (frame >= step.atFrame + step.holdFrames) {
          input.clearSource(index); activeSteps.delete(index); changed = true;
          inputEvents.push({ frame, action: 'release', step: index });
        }
        config.inputSteps.forEach((step, index) => {
          if (frame !== step.atFrame) return;
          activeSteps.set(index, step); changed = true;
          for (const [button, pressed] of Object.entries(step.buttons)) input.setButton(button, pressed, index);
          for (const [axis, value] of Object.entries(step.axes)) input.setAxis(axis, value, index);
          inputEvents.push({ frame, action: 'press', step: index, buttons: step.buttons, axes: step.axes });
        });
        if (changed) worker.postMessage({ type: 'input', snapshot: input.snapshot() });
      };
      const started = performance.now();
      try {
        const initStart = performance.now();
        readyInfo = await send({ type: 'init', renderer: config.renderer, video: config.video }, 'ready');
        initMs = performance.now() - initStart; state = 'booting';
        await checkpoint();
        const bootStart = performance.now();
        bootInfo = await send({ type: 'boot', file: document.querySelector('#localGame').files[0] }, 'booted');
        bootMs = performance.now() - bootStart; state = 'warmup';
        await readCompiler('boot', config.compiler);
        await checkpoint();
        if (milestones.has(0)) await screenshot('boot');
        while (true) {
          const measuring = completedFrames >= config.warmup;
          if (measuring && ((config.maxFrames !== null && samples.length >= config.maxFrames) ||
            (config.maxSeconds !== null && activeMeasuredMs >= config.maxSeconds * 1000))) break;
          state = measuring ? 'measuring' : 'warmup';
          if (measuring && measuredStart === null) {
            await readCompiler('measurement-start');
            warmupGpuDrainMs = await drainGpu();
            measuredStart = performance.now();
          }
          applyInputs(completedFrames);
          const before = { ...totalCounters };
          const frameStart = performance.now();
          const acknowledgment = await send({ type: 'frame' }, 'frame-done');
          const durationMs = performance.now() - frameStart;
          completedFrames++;
          const sample = { frame: completedFrames, durationMs, frameRate: acknowledgment.frameRate,
            videoMessages: totalCounters.videoMessages - before.videoMessages, audioFrames: totalCounters.audioFrames - before.audioFrames };
          if (measuring) {
            samples.push(sample); submissionMeasuredMs += durationMs; activeMeasuredMs += durationMs;
            for (const key of Object.keys(measuredCounters)) measuredCounters[key] += totalCounters[key] - before[key];
          } else warmupSamples.push(sample);
          if (milestones.has(completedFrames)) await screenshot('milestone');
          if (completedFrames % config.progressFrames === 0) await checkpoint();
        }
        state = 'finalizing';
        await screenshot('final');
        await readCompiler('measurement-end');
        if (fatalError) throw fatalError;
        state = 'complete';
        return { ...progress(), browserGraphics, wallElapsedMs: performance.now() - started,
          emulatedSeconds: samples.reduce((sum, sample) => sum + 1 / (sample.frameRate || bootInfo.frameRate || 60), 0),
          error: null };
      } catch (error) {
        state = 'failed'; gpuCompletionFinalized = false; finalizedGpuWallMs = null;
        record({ type: 'error', message: error.message });
        try { await screenshot('failure'); } catch (captureError) { record({ type: 'screenshot-error', message: captureError.message }); }
        return { ...progress(), browserGraphics, wallElapsedMs: performance.now() - started, error: { message: error.message, stack: error.stack } };
      } finally { worker.terminate(); }
    }, { warmup, maxFrames, maxSeconds, timeoutMs, progressFrames, maxLogs, renderer, video, inputSteps, screenshotFrames, compiler,
      gpuCompletionMethod: report.gpuCompletionMethod });
    Object.assign(result, summarizeThroughput({ frames: result.samples.length, submissionMs: result.submissionMeasuredMs,
      gpuCompletionMs: result.gpuCompletionMs, gpuCompletedWallMs: result.gpuCompletedWallMs,
      gpuCompletionFinalized: result.gpuCompletionFinalized && result.status === 'complete' && !result.error,
      videoMessages: result.measuredCounters.videoMessages, emulatedSeconds: result.emulatedSeconds || 0 }));
    report.result = { ...result, frameTiming: summarizeDurations(result.samples.map(sample => sample.durationMs)),
      warmupTiming: summarizeDurations(result.warmupSamples.map(sample => sample.durationMs)) };
    report.status = result.status;
    report.progress = null;
    report.visualEvidence = { screenshotCount: report.screenshots.length, distinctScreenshotHashes: new Set(report.screenshots.map(image => image.sha256)).size,
      interpretation: 'Different screenshot hashes show visible changes only; verify the images for game loading, menus, gameplay or failure. Repeated images may be expected at a static menu.' };
    await saveReport();
    console.log(JSON.stringify({ status: report.status, nativeFrameRequestFps: result.nativeFrameRequestFps, submissionFps: result.submissionFps,
      gpuCompletedWallFps: result.gpuCompletedWallFps, gpuCompletionMs: result.gpuCompletionMs,
      gpuCompletedWallMs: result.gpuCompletedWallMs, gpuCompletionFinalized: result.gpuCompletionFinalized,
      deliveredVideoMessagesPerSecond: result.deliveredVideoMessagesPerSecond, emulationSpeedPercent: result.emulationSpeedPercent,
      measuredFrames: result.samples.length, browserGraphics: result.browserGraphics, frameTiming: report.result.frameTiming,
      visualEvidence: report.visualEvidence, error: result.error, report: output }));
    if (result.error || !result.samples.length) process.exitCode = 1;
  } catch (error) {
    report.status = 'failed'; report.error = { message: error.message, stack: error.stack };
    await saveReport(); console.error(`Local benchmark failed: ${error.message}\nReport: ${output}`); process.exitCode = 1;
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
}
