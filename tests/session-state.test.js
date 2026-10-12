import test from 'node:test';
import assert from 'node:assert/strict';

test('manual pause survives hiding and showing a running session', async () => {
  const { PlaybackState } = await import('../src/session-state.js');
  const state = new PlaybackState();
  assert.equal(state.paused, true);
  state.start();
  assert.equal(state.paused, false);
  state.manualPaused = true;
  state.hidden = true;
  state.hidden = false;
  assert.equal(state.paused, true);
  state.manualPaused = false;
  assert.equal(state.paused, false);
  state.stop();
  assert.equal(state.paused, true);
});

test('starting in the background remains paused and new sessions clear manual pause', async () => {
  const { PlaybackState } = await import('../src/session-state.js');
  const state = new PlaybackState();
  state.hidden = true;
  state.manualPaused = true;
  state.start();
  assert.equal(state.paused, true);
  assert.equal(state.manualPaused, false);
  state.hidden = false;
  assert.equal(state.paused, false);
});

test('frame measurements report actual throughput and reset without a background catch-up', async () => {
  const { FrameStats } = await import('../src/session-state.js');
  const stats = new FrameStats();
  stats.reset(0);
  for (let i = 1; i <= 30; i++) stats.frame(i * (1000 / 30), 60);
  assert.equal(stats.fps, 30);
  assert.equal(stats.speed, 50);
  stats.reset(10000);
  assert.equal(stats.fps, null);
  for (let i = 1; i <= 50; i++) stats.frame(10000 + i * 20, 50);
  assert.equal(stats.fps, 50);
  assert.equal(stats.speed, 100);
});
