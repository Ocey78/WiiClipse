export class InputState {
  constructor() {
    this.buttons = Object.create(null);
    this.axes = { lx: 0, ly: 0, rx: 0, ry: 0, l: 0, r: 0 };
  }
  setButton(name, pressed) { this.buttons[String(name)] = !!pressed; }
  setAxis(name, value) {
    const n = Number(value) || 0;
    this.axes[String(name)] = Math.max(-1, Math.min(1, n));
  }
  snapshot() { return { buttons: { ...this.buttons }, axes: { ...this.axes } }; }
}
