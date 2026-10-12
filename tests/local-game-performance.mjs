import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

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

if (process.argv.includes('--self-test')) {
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
  console.log('Local benchmark configuration and percentile checks passed.');
} else if (process.argv.includes('--help')) {
  console.log(`Run: node tests/local-game-performance.mjs
Required: LOCAL_GAME_PATH (a local game file; never served or uploaded)
Optional environment settings:
  PERF_DIST=dist                 Built app assets
  PERF_CORE_DIR=<directory>       Override built core assets
  PERF_RENDERER=hardware|software Requested core backend (actual backend comes from logs)
  PERF_VIDEO=bitmap|pixels        Native video delivery mode, default bitmap
  PERF_WARMUP=30                 Unmeasured frames before timing
  PERF_FRAMES=120                Maximum measured frame acknowledgments
  PERF_SECONDS=<seconds>         Active measured-time ceiling; no default frame limit when set alone
  PERF_TIMEOUT_MS=120000         Timeout per init, boot, or frame
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
Screenshots and logs can contain game imagery; keep outputs local. Frame timings measure uncapped
worker execution, message delivery, and video presentation submission, excluding screenshot pauses.
They count completed native frame requests, not display refreshes. Inspect video counts, screenshot
hashes, and screenshots to assess actual game progress; acknowledgments alone do not prove gameplay.`);
} else {
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
  const inputSteps = parseInputSteps(process.env.PERF_INPUT_STEPS);
  const screenshotFrames = process.env.PERF_SCREENSHOT_FRAMES ? process.env.PERF_SCREENSHOT_FRAMES.split(',').map(Number) : [0, 1, warmup, ...(maxFrames ? [warmup + maxFrames] : [])];
  assert.ok(screenshotFrames.every(value => Number.isInteger(value) && value >= 0), 'PERF_SCREENSHOT_FRAMES must be comma-separated nonnegative integers');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const output = path.resolve(process.env.PERF_OUT || path.join('native-performance', 'local-game', stamp, 'report.json'));
  const outputDir = path.dirname(output);
  await fs.mkdir(outputDir, { recursive: true });
  const report = {
    schemaVersion: 1, measuredAt: new Date().toISOString(), game: { name: path.basename(gamePath), sizeBytes: gameStat.size },
    root, coreRoot, requestedRenderer: renderer || 'default', requestedVideo: video,
    configuration: { warmup, maxFrames, maxSeconds, timeoutMs, screenshotFrames, inputSteps },
    scope: 'Uncapped completed native worker frame requests, message delivery and real video presentation submission. Excludes screenshot/checkpoint pauses, audio playback and display pacing. Frame acknowledgments alone do not prove gameplay progress; inspect delivered video counts and screenshots. No game file is served or uploaded.',
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
      const body = relative === 'local-benchmark.html' ? '<!doctype html><title>WiiClipse local game benchmark</title><style>body{margin:0;background:#101820;color:white;font:16px sans-serif}canvas{display:block;width:640px;height:480px}input{margin:8px}</style><input id="localGame" type="file"><canvas id="screen" width="640" height="480"></canvas>' : await fs.readFile(file);
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
      let activeMeasuredMs = 0; let capturePauseMs = 0; let logEntriesDropped = 0;
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
        readyInfo, bootInfo, activeMeasuredMs, capturePauseMs, lastVideo, totalCounters: { ...totalCounters },
        measuredCounters: { ...measuredCounters }, samples, warmupSamples, logs, errors, logEntriesDropped, inputEvents });
      const screenshot = async label => {
        const begin = performance.now();
        await window.benchmarkScreenshot({ frame: completedFrames, label, lastVideo, phase: state });
        capturePauseMs += performance.now() - begin;
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
        await window.benchmarkCheckpoint(progress());
        const bootStart = performance.now();
        bootInfo = await send({ type: 'boot', file: document.querySelector('#localGame').files[0] }, 'booted');
        bootMs = performance.now() - bootStart; state = 'warmup';
        await window.benchmarkCheckpoint(progress());
        if (milestones.has(0)) await screenshot('boot');
        while (true) {
          const measuring = completedFrames >= config.warmup;
          if (measuring && ((config.maxFrames !== null && samples.length >= config.maxFrames) ||
            (config.maxSeconds !== null && activeMeasuredMs >= config.maxSeconds * 1000))) break;
          state = measuring ? 'measuring' : 'warmup';
          applyInputs(completedFrames);
          const before = { ...totalCounters };
          const frameStart = performance.now();
          const acknowledgment = await send({ type: 'frame' }, 'frame-done');
          const durationMs = performance.now() - frameStart;
          completedFrames++;
          const sample = { frame: completedFrames, durationMs, frameRate: acknowledgment.frameRate,
            videoMessages: totalCounters.videoMessages - before.videoMessages, audioFrames: totalCounters.audioFrames - before.audioFrames };
          if (measuring) {
            samples.push(sample); activeMeasuredMs += durationMs;
            for (const key of Object.keys(measuredCounters)) measuredCounters[key] += totalCounters[key] - before[key];
          } else warmupSamples.push(sample);
          if (milestones.has(completedFrames)) await screenshot('milestone');
          if (completedFrames % config.progressFrames === 0) await window.benchmarkCheckpoint(progress());
        }
        state = 'complete';
        await screenshot('final');
        return { ...progress(), browserGraphics, wallElapsedMs: performance.now() - started,
          nativeFrameRequestFps: activeMeasuredMs ? samples.length * 1000 / activeMeasuredMs : 0,
          deliveredVideoMessagesPerSecond: activeMeasuredMs ? measuredCounters.videoMessages * 1000 / activeMeasuredMs : 0,
          emulatedSeconds: samples.reduce((sum, sample) => sum + 1 / (sample.frameRate || bootInfo.frameRate || 60), 0),
          emulationSpeedPercent: activeMeasuredMs ? samples.reduce((sum, sample) => sum + 100000 / (sample.frameRate || bootInfo.frameRate || 60), 0) / activeMeasuredMs : 0,
          error: null };
      } catch (error) {
        state = 'failed'; record({ type: 'error', message: error.message });
        try { await screenshot('failure'); } catch (captureError) { record({ type: 'screenshot-error', message: captureError.message }); }
        return { ...progress(), browserGraphics, wallElapsedMs: performance.now() - started, error: { message: error.message, stack: error.stack } };
      } finally { worker.terminate(); }
    }, { warmup, maxFrames, maxSeconds, timeoutMs, progressFrames, maxLogs, renderer, video, inputSteps, screenshotFrames });
    report.result = { ...result, frameTiming: summarizeDurations(result.samples.map(sample => sample.durationMs)),
      warmupTiming: summarizeDurations(result.warmupSamples.map(sample => sample.durationMs)) };
    report.status = result.status;
    report.progress = null;
    report.visualEvidence = { screenshotCount: report.screenshots.length, distinctScreenshotHashes: new Set(report.screenshots.map(image => image.sha256)).size,
      interpretation: 'Different screenshot hashes show visible changes only; verify the images for game loading, menus, gameplay or failure. Repeated images may be expected at a static menu.' };
    await saveReport();
    console.log(JSON.stringify({ status: report.status, nativeFrameRequestFps: result.nativeFrameRequestFps,
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
