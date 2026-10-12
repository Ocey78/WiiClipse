export const KEYBOARD_BUTTONS = Object.freeze({
  KeyJ: 'A', KeyK: 'B', KeyU: 'X', KeyI: 'Y', Enter: 'START',
  KeyQ: 'L', KeyE: 'R', Space: 'Z',
  ArrowUp: 'UP', ArrowDown: 'DOWN', ArrowLeft: 'LEFT', ArrowRight: 'RIGHT'
});
export const KEYBOARD_HELP = Object.freeze([
  { keys: 'W A S D', action: 'Main stick' },
  { keys: 'Arrow keys', action: 'D-pad' },
  { keys: 'J / K / U / I', action: 'A / B / X / Y' },
  { keys: 'T F G H', action: 'C-stick: up / left / down / right' },
  { keys: 'Q / E / Space', action: 'L / R / Z' },
  { keys: 'Enter', action: 'Start' }
]);

const STICK_KEYS = Object.freeze({
  lx: ['KeyA', 'KeyD'], ly: ['KeyW', 'KeyS'],
  rx: ['KeyF', 'KeyH'], ry: ['KeyT', 'KeyG']
});
const GAMEPAD_BUTTONS = { A: 0, B: 1, X: 2, Y: 3, L: 6, R: 7, Z: 5,
  SELECT: 8, START: 9, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 };
const KEY_CODES = new Set([...Object.keys(KEYBOARD_BUTTONS), ...Object.values(STICK_KEYS).flat()]);

function stableAxis(value, deadzone = 0.15) {
  const number = Number(value);
  if (!Number.isFinite(number) || Math.abs(number) <= deadzone) return 0;
  const scaled = Math.sign(number) * (Math.min(1, Math.abs(number)) - deadzone) / (1 - deadzone);
  return Math.round(scaled * 100) / 100;
}

export function createInputController({ input, document, window, navigator, onChange = () => {}, onGamepad = () => {} }) {
  let enabled = true;
  let focused = true;
  let destroyed = false;
  let frame = null;
  let padIdentity = null;
  let padLabel = null;
  const heldKeys = new Set();
  const pointers = new Map();
  const listeners = [];
  const active = () => enabled && focused && !destroyed;
  const notifyChange = revision => { if (input.revision !== revision) onChange(); };
  const listen = (target, type, callback) => {
    target.addEventListener(type, callback);
    listeners.push(() => target.removeEventListener(type, callback));
  };
  const labelGamepad = label => {
    if (padLabel === label) return;
    padLabel = label;
    onGamepad(label);
  };
  const setButton = (name, pressed, source) => {
    input.setButton(name, pressed, source);
    if (name === 'L' || name === 'R') input.setAxis(name.toLowerCase(), pressed ? 1 : 0, source);
  };
  const keyboardAxes = () => {
    for (const [axis, [negative, positive]] of Object.entries(STICK_KEYS)) {
      input.setAxis(axis, Number(heldKeys.has(positive)) - Number(heldKeys.has(negative)), 'keyboard');
    }
  };
  const keydown = event => {
    if (!active() || !KEY_CODES.has(event.code) || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.target?.closest?.('input, button, select, textarea, [contenteditable]:not([contenteditable="false"])') || event.target?.isContentEditable) return;
    event.preventDefault();
    if (heldKeys.has(event.code)) return;
    const revision = input.revision;
    heldKeys.add(event.code);
    const button = KEYBOARD_BUTTONS[event.code];
    if (button) setButton(button, true, 'keyboard');
    keyboardAxes();
    notifyChange(revision);
  };
  const keyup = event => {
    if (!heldKeys.has(event.code)) return;
    event.preventDefault();
    const revision = input.revision;
    heldKeys.delete(event.code);
    const button = KEYBOARD_BUTTONS[event.code];
    if (button) setButton(button, false, 'keyboard');
    keyboardAxes();
    notifyChange(revision);
  };
  const releasePointer = pointerId => {
    const pointer = pointers.get(pointerId);
    if (!pointer) return;
    pointers.delete(pointerId);
    input.clearSource(pointer.source);
    if (pointer.stick) {
      const knob = pointer.element.querySelector('.stick-knob');
      if (knob) knob.style.transform = 'translate(0px, 0px)';
    }
    pointer.element.classList?.toggle('pressed', [...pointers.values()].some(other => other.element === pointer.element));
    try {
      if (pointer.element.hasPointerCapture?.(pointerId)) pointer.element.releasePointerCapture(pointerId);
    } catch { /* The browser may already have cancelled the pointer. */ }
  };
  const moveStick = (pointer, event) => {
    const rect = pointer.element.getBoundingClientRect();
    const radius = Math.min(rect.width, rect.height) / 2;
    if (!(radius > 0)) return;
    let x = (event.clientX - rect.left - rect.width / 2) / radius;
    let y = (event.clientY - rect.top - rect.height / 2) / radius;
    const magnitude = Math.hypot(x, y);
    if (magnitude > 1) { x /= magnitude; y /= magnitude; }
    const [horizontal, vertical] = pointer.stick === 'left' ? ['lx', 'ly'] : ['rx', 'ry'];
    input.setAxis(horizontal, stableAxis(x), pointer.source);
    input.setAxis(vertical, stableAxis(y), pointer.source);
    const knob = pointer.element.querySelector('.stick-knob');
    if (knob) knob.style.transform = `translate(${x * radius * 0.5}px, ${y * radius * 0.5}px)`;
  };
  for (const element of [...document.querySelectorAll('[data-button]'), ...document.querySelectorAll('[data-stick]')]) {
    listen(element, 'pointerdown', event => {
      if (!active() || (event.button !== undefined && event.button !== 0) || pointers.has(event.pointerId)) return;
      const stick = element.dataset.stick;
      if (stick && [...pointers.values()].some(pointer => pointer.element === element)) return;
      event.preventDefault();
      const revision = input.revision;
      const pointer = { element, stick, source: `pointer:${event.pointerId}` };
      pointers.set(event.pointerId, pointer);
      try { element.setPointerCapture?.(event.pointerId); } catch { /* Global release listeners remain available. */ }
      if (stick) moveStick(pointer, event);
      else setButton(element.dataset.button, true, pointer.source);
      element.classList?.toggle('pressed', true);
      notifyChange(revision);
    });
    listen(element, 'pointermove', event => {
      const pointer = pointers.get(event.pointerId);
      if (!pointer?.stick || pointer.element !== element) return;
      event.preventDefault();
      const revision = input.revision;
      moveStick(pointer, event);
      notifyChange(revision);
    });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) listen(element, type, event => {
      const revision = input.revision;
      releasePointer(event.pointerId);
      notifyChange(revision);
    });
  }
  for (const type of ['pointerup', 'pointercancel']) listen(document, type, event => {
    const revision = input.revision;
    releasePointer(event.pointerId);
    notifyChange(revision);
  });
  const reset = () => {
    heldKeys.clear();
    for (const pointerId of [...pointers.keys()]) releasePointer(pointerId);
    input.reset();
    padIdentity = null;
    labelGamepad(null);
    onChange();
  };
  const cancelFrame = () => {
    if (frame !== null) window.cancelAnimationFrame?.(frame);
    frame = null;
  };
  const schedule = () => {
    if (active() && frame === null && window.requestAnimationFrame) frame = window.requestAnimationFrame(pollGamepad);
  };
  const pollGamepad = () => {
    frame = null;
    if (!active()) return;
    const revision = input.revision;
    let pads = [];
    try { pads = Array.from(navigator?.getGamepads?.() || []); } catch { /* Gamepad access is optional. */ }
    const pad = pads.find(candidate => candidate?.connected && candidate.mapping === 'standard');
    const identity = pad ? `${pad.index}:${pad.id}` : null;
    if (identity !== padIdentity) input.clearSource('gamepad');
    padIdentity = identity;
    labelGamepad(pad?.id || null);
    if (pad) {
      for (const [button, index] of Object.entries(GAMEPAD_BUTTONS)) input.setButton(button, !!pad.buttons[index]?.pressed, 'gamepad');
      ['lx', 'ly', 'rx', 'ry'].forEach((axis, index) => input.setAxis(axis, stableAxis(pad.axes[index]), 'gamepad'));
      input.setAxis('l', stableAxis(pad.buttons[6]?.value, 0.05), 'gamepad');
      input.setAxis('r', stableAxis(pad.buttons[7]?.value, 0.05), 'gamepad');
    } else input.clearSource('gamepad');
    notifyChange(revision);
    schedule();
  };
  listen(document, 'keydown', keydown);
  listen(document, 'keyup', keyup);
  listen(window, 'blur', () => { focused = false; cancelFrame(); reset(); });
  listen(window, 'focus', () => { focused = true; schedule(); });
  for (const type of ['gamepadconnected', 'gamepaddisconnected']) listen(window, type, () => {
    if (!active()) return;
    cancelFrame(); pollGamepad();
  });
  schedule();
  return {
    reset,
    setEnabled(value) {
      if (destroyed || enabled === !!value) return;
      enabled = !!value;
      if (enabled) schedule();
      else { cancelFrame(); reset(); }
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      cancelFrame();
      listeners.forEach(remove => remove());
      reset();
    }
  };
}
