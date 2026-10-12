export class PlaybackState {
  constructor() {
    this.running = false;
    this.manualPaused = false;
    this.hidden = false;
  }
  get paused() { return !this.running || this.manualPaused || this.hidden; }
  start() { this.running = true; this.manualPaused = false; }
  stop() { this.running = false; this.manualPaused = false; }
}

export class FrameStats {
  constructor() { this.reset(); }
  reset(now = performance.now()) {
    this.started = now;
    this.frames = 0;
    this.fps = null;
    this.speed = null;
  }
  frame(now = performance.now(), target = 60) {
    this.frames++;
    const elapsed = now - this.started;
    if (elapsed < 1000) return false;
    this.fps = Math.round(this.frames * 10000 / elapsed) / 10;
    this.speed = Number.isFinite(target) && target >= 20 && target <= 120
      ? Math.round(this.fps / target * 100) : null;
    this.started = now;
    this.frames = 0;
    return true;
  }
}
