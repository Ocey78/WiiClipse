export class InputState {
  constructor() {
    this.buttons = Object.create(null);
    this.axes = { lx: 0, ly: 0, rx: 0, ry: 0, l: 0, r: 0 };
    this.revision = 0;
    this.sources = new Map();
  }
  sourceState(source) {
    if (!this.sources.has(source)) this.sources.set(source, { buttons: new Map(), axes: new Map() });
    return this.sources.get(source);
  }
  mergeButton(name) {
    let pressed = false;
    for (const source of this.sources.values()) {
      if (source.buttons.get(name)) { pressed = true; break; }
    }
    if (!!this.buttons[name] !== pressed) this.revision++;
    this.buttons[name] = pressed;
  }
  mergeAxis(name) {
    let value = 0;
    for (const source of this.sources.values()) {
      const candidate = source.axes.get(name) || 0;
      if (Math.abs(candidate) > Math.abs(value)) value = candidate;
    }
    if ((this.axes[name] || 0) !== value) this.revision++;
    this.axes[name] = value;
  }
  setButton(name, pressed, source = 'legacy') {
    name = String(name);
    pressed = !!pressed;
    this.sourceState(source).buttons.set(name, pressed);
    this.mergeButton(name);
  }
  setAxis(name, value, source = 'legacy') {
    const n = Number(value) || 0;
    name = String(name);
    const normalized = Math.max(-1, Math.min(1, n));
    this.sourceState(source).axes.set(name, normalized);
    this.mergeAxis(name);
  }
  clearSource(source = 'legacy') {
    const state = this.sources.get(source);
    if (!state) return;
    this.sources.delete(source);
    for (const name of state.buttons.keys()) this.mergeButton(name);
    for (const name of state.axes.keys()) this.mergeAxis(name);
  }
  reset() {
    this.sources.clear();
    for (const name of Object.keys(this.buttons)) this.mergeButton(name);
    for (const name of Object.keys(this.axes)) this.mergeAxis(name);
  }
  snapshot() { return { buttons: { ...this.buttons }, axes: { ...this.axes } }; }
}
