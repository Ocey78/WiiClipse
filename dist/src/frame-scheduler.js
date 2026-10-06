export class FrameScheduler {
  constructor(requestFrame, {
    now = () => performance.now(),
    setTimer = (callback, delay) => setTimeout(callback, delay),
    clearTimer = timer => clearTimeout(timer),
  } = {}) {
    this.requestFrame = requestFrame;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.interval = 1000 / 60;
    this.active = false;
    this.paused = false;
    this.inFlight = false;
    this.timer = null;
  }

  start(frameRate = 60) {
    this.stop();
    this.#setRate(frameRate);
    this.active = true;
    this.nextDue = this.now();
    this.#pump();
  }

  stop() {
    this.active = false;
    this.inFlight = false;
    this.#cancelTimer();
  }

  setPaused(paused) {
    if (this.paused === paused) return;
    this.paused = paused;
    this.#cancelTimer();
    if (!paused) { this.nextDue = this.now(); this.#pump(); }
  }

  frameDone(frameRate) {
    if (!this.active || !this.inFlight) return;
    this.inFlight = false;
    if (this.#setRate(frameRate)) this.nextDue = this.lastStart + this.interval;
    this.#pump();
  }

  #setRate(rate) {
    if (!Number.isFinite(rate) || rate < 20 || rate > 120) return false;
    const interval = 1000 / rate;
    const changed = this.interval !== interval;
    this.interval = interval;
    return changed;
  }

  #cancelTimer() {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }

  #pump() {
    if (!this.active || this.paused || this.inFlight) return;
    this.#cancelTimer();
    const now = this.now();
    const delay = this.nextDue - now;
    if (delay > 0.25) {
      this.timer = this.setTimer(() => { this.timer = null; this.#pump(); }, delay);
      return;
    }
    // Preserve the console clock while work fits its budget. Slow emulation
    // continues immediately, without waiting for another display refresh.
    if (now - this.nextDue > this.interval) this.nextDue = now;
    this.lastStart = now;
    this.nextDue += this.interval;
    this.inFlight = true;
    if (this.requestFrame() === false) this.stop();
  }
}
