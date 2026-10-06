import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const playwright = await import(process.env.PLAYWRIGHT_MODULE
  ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const browserName = process.env.SMOKE_BROWSER || 'chromium';
const source = await fs.readFile(new URL('../src/frame-scheduler.js', import.meta.url), 'utf8');
const browser = await playwright[browserName].launch({ headless: true,
  ...(browserName === 'chromium' && process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
});
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const result = await page.evaluate(async source => {
    const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    const { FrameScheduler } = await import(url);
    URL.revokeObjectURL(url);
    const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
    async function until(predicate) {
      const deadline = performance.now() + 3000;
      while (!predicate()) {
        if (performance.now() > deadline) throw new Error('Browser scheduler stopped dispatching frames');
        await delay(5);
      }
    }
    let frames = 0, pending = 0, maximumPending = 0;
    const scheduler = new FrameScheduler(() => {
      frames++;
      maximumPending = Math.max(maximumPending, ++pending);
      setTimeout(() => { pending--; scheduler.frameDone(50); }, 1);
      return true;
    });
    try {
      scheduler.start(50);
      await until(() => frames >= 4);
      scheduler.setPaused(true);
      const pausedFrames = frames;
      await delay(60);
      if (frames !== pausedFrames) throw new Error('Paused scheduler dispatched another frame');
      scheduler.setPaused(false);
      await until(() => frames >= pausedFrames + 2);
      scheduler.stop();
      const stoppedFrames = frames;
      await delay(60);
      if (frames !== stoppedFrames) throw new Error('Stopped scheduler dispatched another frame');

      // Explicitly exercise native clearTimeout with an outstanding browser timer.
      const cancellation = new FrameScheduler(() => true);
      cancellation.start(20);
      cancellation.frameDone(20);
      if (cancellation.timer === null) throw new Error('Expected a pending console-rate timer');
      cancellation.stop();
      return { frames, maximumPending, pausedFrames, stoppedFrames, timerCancelled: cancellation.timer === null };
    } finally { scheduler.stop(); }
  }, source);
  assert.deepEqual(errors, [], 'Browser timer methods must retain a valid receiver');
  assert.equal(result.maximumPending, 1);
  assert.equal(result.timerCancelled, true);
  console.log(JSON.stringify({ browser: browserName, scheduler: result }));
} finally { await browser.close(); }
