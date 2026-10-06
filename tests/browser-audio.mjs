import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const playwright = await import(process.env.PLAYWRIGHT_MODULE
  ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const browserName = process.env.SMOKE_BROWSER || 'chromium';
assert.ok(['chromium', 'webkit'].includes(browserName), 'Unsupported audio-test browser');
const root = path.resolve('src');
const server = http.createServer(async (request, response) => {
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  if (request.url === '/') {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end('<!doctype html><button id="worklet">Worklet</button><button id="script">Fallback</button>');
    return;
  }
  const pathname = new URL(request.url, 'http://localhost').pathname;
  const file = path.resolve(root, decodeURIComponent(pathname.slice(1)));
  if (!file.startsWith(root + path.sep)) { response.writeHead(403).end(); return; }
  try {
    const contents = await fs.readFile(file);
    response.writeHead(200, { 'Content-Type': 'text/javascript' });
    response.end(contents);
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await playwright[browserName].launch({ headless: true,
    ...(browserName === 'chromium' ? { args: ['--mute-audio'],
      ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) } : {}) });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const signals = await page.evaluate(async requireOfflineSignals => {
    if (!crossOriginIsolated) throw new Error('Audio test origin must be isolated');
    function unavailable(reason) {
      if (requireOfflineSignals) throw new Error(reason);
      return { skipped: reason, results: [] };
    }
    if (typeof OfflineAudioContext !== 'function') return unavailable('OfflineAudioContext is unavailable');
    const { createPcmRingBuffer, PcmRing } = await import('/audio-ring.js');
    const results = [];
    for (const [sourceRate, outputRate] of [[32000, 48000], [32029, 44100], [48000, 44100], [48000, 48000]]) {
      const context = new OfflineAudioContext(2, 1024, outputRate);
      if (!context.audioWorklet) return unavailable('OfflineAudioContext.audioWorklet is unavailable; live Worklet output remains required');
      await context.audioWorklet.addModule('/audio-worklet.js');
      const buffer = createPcmRingBuffer({ shared: true });
      const writer = new PcmRing(buffer);
      const pcm = new Int16Array(1800 * 2);
      for (let i = 0; i < 1800; i++) { pcm[i * 2] = i * 8; pcm[i * 2 + 1] = -i * 8; }
      writer.push(pcm, 1800, sourceRate);
      const node = new AudioWorkletNode(context, 'wiiclipse-audio', {
        numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2], processorOptions: { buffer },
      });
      node.connect(context.destination);
      const rendered = await context.startRendering();
      let maxError = 0;
      for (let channel = 0; channel < 2; channel++) {
        const output = rendered.getChannelData(channel);
        for (let i = 0; i < output.length; i++) {
          const expected = i * sourceRate / outputRate * 8 / 32768 * (channel ? -1 : 1);
          maxError = Math.max(maxError, Math.abs(output[i] - expected));
        }
      }
      if (maxError > 1e-6) throw new Error(`Worklet signal mismatch ${sourceRate}->${outputRate}: ${maxError}`);
      writer.close(); node.disconnect(); node.port.close();
      results.push({ sourceRate, outputRate, frames: rendered.length, maxError });
    }
    return { results };
  }, browserName === 'chromium');

  await page.evaluate(async () => {
    const { AudioSink } = await import('/audio-sink.js');
    const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
    async function exercise(mode) {
      const originalWorklet = window.AudioWorkletNode;
      if (mode === 'script') window.AudioWorkletNode = undefined;
      const sink = new AudioSink();
      const ready = sink.resume(); // Called synchronously from a real click for autoplay activation.
      const signalNodes = [];
      try {
        await ready;
        if (sink.mode !== mode) throw new Error(`Expected ${mode}; got ${sink.mode}`);
        // Observe both actual output channels even when offline Worklets are unavailable.
        // Mute after the analysers so this test never needs audible playback.
        const splitter = sink.context.createChannelSplitter(2);
        const mute = sink.context.createGain();
        mute.gain.value = 0;
        mute.connect(sink.context.destination);
        const analysers = [0, 1].map(channel => {
          const analyser = sink.context.createAnalyser();
          analyser.fftSize = 256;
          analyser.channelCount = 1;
          analyser.channelCountMode = 'explicit';
          splitter.connect(analyser, channel);
          analyser.connect(mute);
          return analyser;
        });
        signalNodes.push(splitter, mute, ...analysers);
        sink.node.disconnect();
        sink.node.connect(splitter);
        let scriptPeak = 0;
        if (mode === 'script') {
          const process = sink.node.onaudioprocess;
          sink.node.onaudioprocess = event => {
            process(event);
            for (const sample of event.outputBuffer.getChannelData(0)) scriptPeak = Math.max(scriptPeak, Math.abs(sample));
          };
        }
        const pcm = new Int16Array(1536 * 2);
        for (let i = 0; i < 1536; i++) { pcm[i * 2] = 8192; pcm[i * 2 + 1] = -4096; }
        sink.push({ buffer: pcm.buffer, frames: 1536, sampleRate: 32029 });
        const captured = [new Float32Array(256), new Float32Array(256)];
        const expected = [0.25, -0.125];
        const deadline = performance.now() + 3000;
        let matched = false;
        while (performance.now() < deadline) {
          analysers.forEach((analyser, channel) => analyser.getFloatTimeDomainData(captured[channel]));
          matched = captured.every((samples, channel) => samples.every(sample => Math.abs(sample - expected[channel]) <= 1e-6));
          if (matched) break;
          if (sink.stats.queuedFrames < 1024) sink.push({ buffer: pcm.buffer, frames: 512, sampleRate: 32029 });
          await delay(10);
        }
        if (!matched) throw new Error(`${mode} live stereo signal mismatch: ${JSON.stringify(captured.map(samples => [...samples.slice(0, 8)]))}`);
        if (mode === 'script' && scriptPeak !== 0.25) throw new Error(`Fallback output signal mismatch: ${scriptPeak}`);
        await sink.setPaused(true);
        if (sink.context.state !== 'suspended') throw new Error(`${mode} did not pause`);
        const pausedFrames = sink.stats.queuedFrames;
        sink.push({ buffer: pcm.buffer, frames: 1536, sampleRate: 32029 });
        if (sink.stats.queuedFrames !== pausedFrames) throw new Error(`${mode} queued sound while paused`);
        await sink.setPaused(false);
        if (sink.context.state !== 'running') throw new Error(`${mode} did not resume`);
        const context = sink.context;
        const result = { mode, outputRate: context.sampleRate, liveStereo: captured.map(samples => samples[0]),
          scriptPeak: mode === 'script' ? scriptPeak : undefined };
        await sink.close();
        if (context.state !== 'closed') throw new Error(`${mode} did not close`);
        return result;
      } finally {
        window.AudioWorkletNode = originalWorklet;
        for (const node of signalNodes) node.disconnect();
        await sink.close();
      }
    }
    for (const mode of ['worklet', 'script']) {
      document.querySelector(`#${mode}`).onclick = () => { window.audioResult = exercise(mode); };
    }
  });
  const lifecycles = [];
  for (const mode of ['worklet', 'script']) {
    await page.click(`#${mode}`);
    lifecycles.push(await page.evaluate(() => window.audioResult));
  }
  assert.deepEqual(errors, [], 'Audio processing must not throw browser errors');
  console.log(JSON.stringify({ browser: browserName, audioWorkletSignals: signals, lifecycles }));
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
