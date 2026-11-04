// Inputs remain intentions: movement and combat are validated by the server.
const ACTIONS = ['fire', 'boost', 'brake'];
const neutral = () => ({ rot: 0, thrust: false, brake: false, fire: false, boost: false });

export class TouchState {
  constructor(deadzone = 0.25) {
    this.deadzone = deadzone;
    this.clear();
  }

  beginStick(id, x = 0, y = 0) {
    if (this.stickId !== null) return false;
    this.stickId = id;
    this.moveStick(id, x, y);
    return true;
  }

  moveStick(id, x, y) {
    if (id !== this.stickId || this.stickId === null) return false;
    x = Number.isFinite(x) ? x : 0;
    y = Number.isFinite(y) ? y : 0;
    const length = Math.max(1, Math.hypot(x, y));
    this.axes = { x: x / length, y: y / length };
    return true;
  }

  press(action, id) {
    if (!ACTIONS.includes(action)) return false;
    this.buttons[action].add(id);
    return true;
  }

  release(id) {
    if (id === this.stickId) {
      this.stickId = null;
      this.axes = { x: 0, y: 0 };
    }
    for (const pointers of Object.values(this.buttons)) pointers.delete(id);
  }

  clear() {
    this.stickId = null;
    this.axes = { x: 0, y: 0 };
    this.buttons = Object.fromEntries(ACTIONS.map(action => [action, new Set()]));
  }

  read() {
    const { x, y } = this.axes;
    return {
      rot: x > this.deadzone ? 1 : x < -this.deadzone ? -1 : 0,
      thrust: y < -this.deadzone,
      brake: y > this.deadzone || this.buttons.brake.size > 0,
      fire: this.buttons.fire.size > 0,
      boost: this.buttons.boost.size > 0,
    };
  }
}

export class TouchController {
  constructor({ root, stick, knob, buttons = {}, onGesture = () => {} }) {
    this.root = root;
    this.stick = stick;
    this.knob = knob;
    this.buttons = buttons;
    this.onGesture = onGesture;
    this.state = new TouchState();
    this.enabled = false;
    this.captures = new Map();
    this.cleanups = [];
    this.document = root?.ownerDocument ?? globalThis.document;
    this.window = this.document?.defaultView ?? globalThis.window;

    const on = (element, type, listener) => {
      if (!element?.addEventListener) return;
      element.addEventListener(type, listener, { passive: false });
      this.cleanups.push(() => element.removeEventListener(type, listener));
    };
    const capture = (element, event) => {
      this.captures.set(event.pointerId, element);
      try { element.setPointerCapture(event.pointerId); } catch { /* Detached surfaces may lose capture. */ }
      this.onGesture();
    };
    on(stick, 'pointerdown', event => {
      if (!this.enabled || (event.pointerType === 'mouse' && event.button !== 0)) return;
      if (!this.state.beginStick(event.pointerId)) return;
      event.preventDefault();
      capture(stick, event);
      this.moveStick(event);
    });
    on(stick, 'pointermove', event => {
      if (!this.enabled || event.pointerId !== this.state.stickId) return;
      event.preventDefault();
      this.moveStick(event);
    });
    for (const action of ACTIONS) {
      const button = buttons[action];
      on(button, 'pointerdown', event => {
        if (!this.enabled || (event.pointerType === 'mouse' && event.button !== 0)) return;
        event.preventDefault();
        this.state.press(action, event.pointerId);
        capture(button, event);
        this.paint();
      });
    }
    for (const element of new Set([stick, ...Object.values(buttons)])) {
      for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
        on(element, type, event => {
          if (!this.captures.has(event.pointerId)) return;
          event.preventDefault();
          this.release(event.pointerId);
        });
      }
      on(element, 'contextmenu', event => event.preventDefault());
    }
    // If native capture fails, a release outside the control must still stop it.
    for (const type of ['pointerup', 'pointercancel']) {
      on(this.window, type, event => {
        if (this.captures.has(event.pointerId)) this.release(event.pointerId);
      });
    }
    on(this.window, 'blur', () => this.clear());
    on(this.document, 'visibilitychange', () => {
      if (this.document.hidden) this.clear();
    });
    this.paint();
  }

  moveStick(event) {
    const rect = this.stick.getBoundingClientRect();
    const radius = Math.max(1, Math.min(rect.width, rect.height) / 2);
    this.state.moveStick(event.pointerId,
      (event.clientX - rect.left - rect.width / 2) / radius,
      (event.clientY - rect.top - rect.height / 2) / radius);
    this.paint();
  }

  paint() {
    if (this.knob && this.stick) {
      const rect = this.stick.getBoundingClientRect();
      const knobRect = this.knob.getBoundingClientRect();
      const travel = Math.max(0, (Math.min(rect.width, rect.height) - Math.min(knobRect.width, knobRect.height)) / 2);
      this.knob.style.transform = `translate(${this.state.axes.x * travel}px, ${this.state.axes.y * travel}px)`;
    }
    this.stick?.classList.toggle('is-active', this.state.stickId !== null);
    for (const action of ACTIONS) {
      const active = this.state.buttons[action].size > 0;
      this.buttons[action]?.classList.toggle('is-active', active);
      this.buttons[action]?.setAttribute('aria-pressed', String(active));
    }
  }

  release(id) {
    const element = this.captures.get(id);
    this.captures.delete(id);
    this.state.release(id);
    try { if (element?.hasPointerCapture(id)) element.releasePointerCapture(id); } catch { /* Capture may already be gone. */ }
    this.paint();
  }

  setEnabled(enabled) {
    enabled = !!enabled;
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (!this.enabled) this.clear();
  }

  clear() {
    const captures = [...this.captures];
    this.captures.clear();
    this.state.clear();
    for (const [id, element] of captures) {
      try { if (element.hasPointerCapture(id)) element.releasePointerCapture(id); } catch { /* Capture may already be gone. */ }
    }
    this.paint();
  }

  read() { return this.enabled ? this.state.read() : neutral(); }

  destroy() {
    this.enabled = false;
    this.clear();
    for (const cleanup of this.cleanups) cleanup();
    this.cleanups = [];
  }
}
