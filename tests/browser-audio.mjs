import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE
  ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
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
  browser = await chromium.launch({ headless: true, args: ['--mute-audio'],
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const signals = await page.evaluate(async () => {
    if (!crossOriginIsolated) throw new Error('Audio test origin must be isolated');
    const { createPcmRingBuffer, PcmRing } = await import('/audio-ring.js');
    const results = [];
    for (const [sourceRate, outputRate] of [[32000, 48000], [32029, 44100], [48000, 44100], [48000, 48000]]) {
      const context = new OfflineAudioContext(2, 1024, outputRate);
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
    return results;
  });

  await page.evaluate(async () => {
    const { AudioSink } = await import('/audio-sink.js');
    const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
    async function exercise(mode) {
      const originalWorklet = window.AudioWorkletNode;
      if (mode === 'script') window.AudioWorkletNode = undefined;
      const sink = new AudioSink();
      const ready = sink.resume(); // Called synchronously from a real click for autoplay activation.
      try {
        await ready;
        if (sink.mode !== mode) throw new Error(`Expected ${mode}; got ${sink.mode}`);
        let scriptPeak = 0;
        if (mode === 'script') {
          const process = sink.node.onaudioprocess;
          sink.node.onaudioprocess = event => {
            process(event);
            for (const sample of event.outputBuffer.getChannelData(0)) scriptPeak = Math.max(scriptPeak, Math.abs(sample));
          };
        }
        const pcm = new Int16Array(2000 * 2).fill(8192);
        sink.push({ buffer: pcm.buffer, frames: 2000, sampleRate: 32029 });
        const deadline = performance.now() + 3000;
        while (sink.stats.queuedFrames >= 2000 && performance.now() < deadline) await delay(10);
        if (sink.stats.queuedFrames >= 2000) throw new Error(`${mode} did not consume queued PCM`);
        if (mode === 'script' && scriptPeak !== 0.25) throw new Error(`Fallback output signal mismatch: ${scriptPeak}`);
        await sink.setPaused(true);
        if (sink.context.state !== 'suspended') throw new Error(`${mode} did not pause`);
        const pausedFrames = sink.stats.queuedFrames;
        sink.push({ buffer: pcm.buffer, frames: 2000, sampleRate: 32029 });
        if (sink.stats.queuedFrames !== pausedFrames) throw new Error(`${mode} queued sound while paused`);
        await sink.setPaused(false);
        if (sink.context.state !== 'running') throw new Error(`${mode} did not resume`);
        const context = sink.context;
        const result = { mode, outputRate: context.sampleRate, scriptPeak: mode === 'script' ? scriptPeak : undefined };
        await sink.close();
        if (context.state !== 'closed') throw new Error(`${mode} did not close`);
        return result;
      } finally {
        window.AudioWorkletNode = originalWorklet;
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
  console.log(JSON.stringify({ browser: 'chromium', audioWorkletSignals: signals, lifecycles }));
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
