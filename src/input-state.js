export class InputState {
  constructor() {
    this.buttons = Object.create(null);
    this.axes = { lx: 0, ly: 0, rx: 0, ry: 0, l: 0, r: 0 };
    this.revision = 0;
  }
  setButton(name, pressed) {
    name = String(name);
    pressed = !!pressed;
    if (!!this.buttons[name] !== pressed) this.revision++;
    this.buttons[name] = pressed;
  }
  setAxis(name, value) {
    const n = Number(value) || 0;
    name = String(name);
    const normalized = Math.max(-1, Math.min(1, n));
    if ((this.axes[name] || 0) !== normalized) this.revision++;
    this.axes[name] = normalized;
  }
  snapshot() { return { buttons: { ...this.buttons }, axes: { ...this.axes } }; }
}
