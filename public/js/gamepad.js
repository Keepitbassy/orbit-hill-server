// Mandos estándar: el servidor sigue recibiendo únicamente intenciones.
//
// Mapa clásico (v0.1, intacto): `input` conserva EXACTAMENTE las cinco claves
// clásicas y el bloque `tactical` conserva sus tres campos:
//   · button2 (□/X) → weaponToggle (flanco, ver Controller.pressed)
//   · button3 (△/Y) → interact (mantener para rescatar)
//   · stick derecho horizontal (axis 2) → dash -1|0|1
// El silencio (mute) ya NO vive en △/Y: solo tecla M y botón de la interfaz.
//
// LAB CIUDADELA v0.2 (aditivo): el mando físico completo se expone aparte, sin
// tocar las claves clásicas, en `sticks` y `v2`:
//   · LT/L2 (axis 6 o button 6) → v2.aim y v2.brake (el cliente decide: en
//     modo táctico LT apunta, fuera de partida es el freno de siempre)
//   · RT/R2 (axis 7 o button 7) → v2.thrust (el cliente decide: mientras LT
//     dispara; fuera de LT acelera)
//   · R1/RB (button 5) → v2.fire (dispara siempre)
//   · A/✕ (button 0)  → v2.bounce (rebote en pared; ya NO duplica el disparo
//     en modo táctico, lo quita el override de main.js)
//   · R3 (button 11)  → v2.smoke (granada de humo, por flanco)
//   · stick izquierdo → v2.moveX/moveY (desplazamiento lateral apuntando)
//   · stick derecho   → v2.aimAngle (apuntado) cuando se apunta, y `dash`
//     clásico cuando no se apunta.
//
// `input` y `tactical` no crecen: los tests de la API v0.1 siguen valiendo.

import { normalizeGamepadProfile } from './gamepad-profiles.js';

export const DASH_DEADZONE = 0.35;
export const AIM_TRIGGER = 0.4;        // gatillo analógico considerado pulsado
export const AIM_STICK_DEADZONE = 0.3; // zona muerta del stick derecho apuntando
const neutralTactical = () => ({ weaponToggle: false, interact: false, dash: 0 });
const neutralV2 = () => ({
  aim: false, aimAngle: null, moveX: 0, moveY: 0,
  smoke: false, bounce: false, fire: false, thrust: false, brake: false,
});

function readStandardPad(pad) {
  const down = i => !!pad?.buttons?.[i]?.pressed || (pad?.buttons?.[i]?.value ?? 0) > 0.25;
  const axis = i => Number.isFinite(pad?.axes?.[i]) ? pad.axes[i] : 0;
  const supported = !!pad && pad.connected !== false && pad.mapping === 'standard';
  const neutral = { rot: 0, thrust: false, brake: false, fire: false, boost: false };
  if (!supported) {
    return {
      input: neutral, tactical: neutralTactical(), buttons: {},
      sticks: { leftX: 0, leftY: 0, rightX: 0, rightY: 0 },
      v2: neutralV2(),
      direction: 0, supported: false,
    };
  }
  const x = axis(0), y = axis(1), rx = axis(2), ry = axis(3);
  const aimTrigger = down(6) || axis(6) > AIM_TRIGGER;
  const rightStick = Math.hypot(rx, ry);
  return {
    supported: true,
    input: {
      rot: down(15) || x > 0.25 ? 1 : down(14) || x < -0.25 ? -1 : 0,
      thrust: down(7) || down(12) || y < -0.25,
      brake: down(6) || down(13) || y > 0.25,
      fire: down(5) || down(0),
      boost: down(4) || down(1),
    },
    tactical: {
      weaponToggle: down(2),
      interact: down(3),
      dash: rx > DASH_DEADZONE ? 1 : rx < -DASH_DEADZONE ? -1 : 0,
    },
    buttons: {
      confirm: down(0), back: down(1), scoreboard: down(8), menu: down(9),
      weapon: down(2), interact: down(3),
      // v0.2: flancos que el cliente traduce a `smoke` y `bounce` del contrato.
      bounce: down(0), smoke: down(11), aim: aimTrigger,
    },
    sticks: { leftX: x, leftY: y, rightX: rx, rightY: ry },
    v2: {
      aim: aimTrigger,
      aimAngle: rightStick > AIM_STICK_DEADZONE ? Math.atan2(ry, rx) : null,
      moveX: x, moveY: y,
      smoke: down(11),
      bounce: down(0),
      fire: down(5),
      thrust: down(7) || axis(7) > AIM_TRIGGER,
      brake: aimTrigger,
    },
    direction: down(13) || down(15) || y > 0.6 || x > 0.6 ? 1 :
      down(12) || down(14) || y < -0.6 || x < -0.6 ? -1 : 0,
  };
}

export function readPad(pad, profile = 'citadel') {
  const state = readStandardPad(pad);
  state.profile = normalizeGamepadProfile(profile);
  if (!state.supported || state.profile === 'citadel') return state;
  const down = i => !!pad.buttons?.[i]?.pressed || (pad.buttons?.[i]?.value ?? 0) > 0.25;
  const deadzone = 0.15;
  const radial = (x, y) => {
    const mag = Math.hypot(x, y);
    if (mag <= deadzone) return { x: 0, y: 0 };
    const scale = Math.min(1, (mag - deadzone) / (1 - deadzone)) / mag;
    return { x: x * scale, y: y * scale };
  };
  const left = radial(state.sticks.leftX, state.sticks.leftY);
  const right = radial(state.sticks.rightX, state.sticks.rightY);
  const aiming = state.v2.aim || down(11);
  state.assteroids = {
    flight: state.profile === 'assteroids-aim' ? 'omni-aim' : 'omni-turn',
    moveX: left.x, moveY: left.y,
    rot: Math.sign(right.x),
    aimAngle: Math.hypot(right.x, right.y) > 0 ? Math.atan2(right.y, right.x) : null,
    aim: aiming, thrust: down(4),
    fire: state.v2.thrust, sniper: down(5), dashReleased: false,
  };
  state.input = { rot: 0, thrust: down(4), brake: false, fire: state.v2.thrust, boost: false };
  state.tactical = { weaponToggle: down(2) || down(15), interact: down(3), dash: 0 };
  state.buttons = {
    confirm: down(0), back: down(1), scoreboard: down(8), menu: down(9),
    weapon: down(2) || down(15), interact: down(3),
    smoke: down(0), bounce: down(1), aim: aiming,
    selectAuto: down(14), selectSniper: down(13), selectBoomer: down(12), sniper: down(5),
  };
  state.v2.smoke = down(0);
  state.v2.bounce = down(1);
  return state;
}

export function padFamily(id = '') {
  if (/xbox|xinput|microsoft|045e/i.test(id)) return 'Xbox';
  if (/dualsense|dualshock|sony|playstation|wireless controller|054c/i.test(id)) return 'PlayStation';
  return 'Mando estándar';
}

function neutralizeGameplay(state) {
  if (!state) return;
  state.input = { rot: 0, thrust: false, brake: false, fire: false, boost: false };
  state.tactical = neutralTactical();
  state.v2 = neutralV2();
  state.sticks = { leftX: 0, leftY: 0, rightX: 0, rightY: 0 };
  if (state.assteroids) state.assteroids = {
    ...state.assteroids, moveX: 0, moveY: 0, rot: 0, aimAngle: null,
    aim: false, thrust: false, fire: false, sniper: false, dashReleased: false,
  };
  if (state.pressed) for (const action of ['weapon', 'interact', 'smoke', 'bounce', 'selectAuto', 'selectSniper', 'selectBoomer', 'sniper']) state.pressed[action] = false;
}

export class Controller {
  constructor(getPads = () => navigator.getGamepads?.() ?? []) {
    this.getPads = getPads;
    this.index = null;
    this.previous = {};
    this.nextMove = 0;
    this.lastDirection = 0;
    this.profile = 'citadel';
    this.previousThrust = false;
    this.gameplayBlocked = false;
    this.lastState = null;
  }

  setProfile(value) {
    const next = normalizeGamepadProfile(value);
    if (next === this.profile) return;
    this.profile = next;
    this.previous = {};
    this.previousThrust = false;
    this.nextMove = 0;
    this.lastDirection = 0;
  }

  // Menus retain navigation, but gameplay must see release before rearming.
  suppressGameplay() {
    this.gameplayBlocked = true;
    this.previousThrust = false;
    neutralizeGameplay(this.lastState);
  }

  poll(now) {
    let pads;
    try { pads = Array.from(this.getPads()).filter(p => p && p.connected !== false); }
    catch { pads = []; }
    const current = pads.find(p => p.index === this.index && p.mapping === 'standard');
    const pad = current ?? pads.find(p => p.mapping === 'standard') ?? pads[0];
    const index = pad?.index ?? null;
    const changed = this.index !== index;
    if (changed) { this.previous = {}; this.previousThrust = false; this.nextMove = 0; this.lastDirection = 0; }
    this.index = index;
    const state = readPad(pad, this.profile);
    if (state.assteroids) {
      state.assteroids.dashReleased = this.previousThrust && !state.assteroids.thrust &&
        Math.hypot(state.assteroids.moveX, state.assteroids.moveY) > 0.3;
      this.previousThrust = state.assteroids.thrust;
    } else this.previousThrust = false;
    const pressed = {};
    for (const [key, value] of Object.entries(state.buttons)) pressed[key] = value && !this.previous[key];
    this.previous = state.buttons;
    let move = 0;
    if (state.direction && (state.direction !== this.lastDirection || now >= this.nextMove)) {
      move = state.direction;
      this.nextMove = now + (state.direction !== this.lastDirection ? 350 : 160);
    }
    this.lastDirection = state.direction;
    const result = { ...state, pressed, move, connected: !!pad, family: padFamily(pad?.id), changed };
    if (this.gameplayBlocked) {
      const held = Object.entries(state.buttons).some(([key, value]) => value && key !== 'menu' && key !== 'scoreboard') ||
        state.input.fire || state.input.thrust || state.input.boost || state.input.brake || state.assteroids?.thrust ||
        Math.hypot(state.sticks.leftX, state.sticks.leftY, state.sticks.rightX, state.sticks.rightY) > 0.25;
      if (held) { neutralizeGameplay(result); this.previousThrust = false; }
      else this.gameplayBlocked = false;
    }
    this.lastState = result;
    return result;
  }
}
