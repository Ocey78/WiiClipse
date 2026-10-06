import test from 'node:test';
import assert from 'node:assert/strict';
import { FrameScheduler } from '../src/frame-scheduler.js';

function clock() {
  let now = 0, id = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimer(fn, delay) { const key = ++id; timers.set(key, { fn, at: now + delay }); return key; },
    clearTimer(key) { timers.delete(key); },
    advance(until) {
      for (let iterations = 0; ; iterations++) {
        assert.ok(iterations < 10000, 'Scheduler must not spin without time advancing');
        const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > until) break;
        now = next[1].at; timers.delete(next[0]); next[1].fn();
      }
      now = until;
    },
  };
}
function simulation(frameMs, fps = 60) {
  const time = clock(), starts = [];
  let outstanding = 0, maximumOutstanding = 0, scheduler;
  scheduler = new FrameScheduler(() => {
    starts.push(time.now()); maximumOutstanding = Math.max(maximumOutstanding, ++outstanding);
    time.setTimer(() => { outstanding--; scheduler.frameDone(); }, frameMs);
    return true;
  }, time);
  scheduler.start(fps);
  return { time, starts, scheduler, max: () => maximumOutstanding };
}

test('slow frames continue immediately after completion without refresh quantization or a work queue', () => {
  const { time, starts, max } = simulation(24);
  time.advance(1000);
  assert.equal(starts.length, 42, '24ms frames should approach41.7fps; a60Hz RAF-only loop caps these at30');
  assert.equal(max(), 1);
  assert.deepEqual(starts.slice(0, 4), [0, 24, 48, 72]);
});

test('fast emulation runs at the console rate regardless of display refresh and honors PAL50Hz', () => {
  const { time, starts, max } = simulation(1, 50);
  time.advance(999);
  assert.equal(starts.length, 50);
  assert.equal(max(), 1);
  assert.equal(starts[1], 20);
});

test('hidden and stopped games do not keep dispatching and resume without a catch-up burst', () => {
  const { time, starts, scheduler } = simulation(1);
  scheduler.setPaused(true);
  time.advance(5000);
  assert.equal(starts.length, 1);
  scheduler.setPaused(false);
  time.advance(5002);
  assert.equal(starts.length, 2);
  scheduler.stop();
  time.advance(6000);
  assert.equal(starts.length, 2);
});

test('pausing while a slow frame is pending never creates concurrent work on resume', () => {
  const { time, starts, scheduler, max } = simulation(40);
  scheduler.setPaused(true);
  time.advance(10);
  scheduler.setPaused(false);
  time.advance(39);
  assert.equal(starts.length, 1);
  time.advance(100);
  assert.equal(max(), 1);
});

test('runtime refresh-rate changes and invalid metadata are bounded', () => {
  const time = clock(), starts = [];
  const scheduler = new FrameScheduler(() => { starts.push(time.now()); return true; }, time);
  scheduler.start(60);
  scheduler.frameDone(50);
  time.advance(19);
  assert.equal(starts.length, 1);
  time.advance(20);
  assert.equal(starts.length, 2);
  scheduler.frameDone(NaN);
  time.advance(39);
  assert.equal(starts.length, 2);
  time.advance(40);
  assert.equal(starts.length, 3);
  scheduler.stop();
});
