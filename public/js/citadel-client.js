// Orbit Hill — LAB CIUDADELA v0.2: piezas PURAS del cliente de PC/mando.
//
// Este módulo no toca el DOM ni la red: recibe datos planos (teclado, ratón,
// mando, snapshot) y devuelve intenciones y textos. Así las reglas nuevas del
// prototipo (apuntado con LT, disparo contextual de RT, rebote, humo, modelos
// cosméticos y mapas) se pueden probar en Node sin navegador.
//
// Autoridad: el servidor. Aquí solo se decide QUÉ se pide, nunca qué ocurre.

import { SHIP_DEFAULT, SHIP_MODELS, sanitizeShipModel } from '../../shared/ships.js';
import { BATTLEFIELDS, sanitizeBattlefield } from '../../shared/battlefield.js';
import { angleDelta, wrapDelta } from '../../shared/physics.js';
import { AIM } from '../../shared/arsenal.js';
import { NET } from '../../shared/constants.js';
import { DEFAULT_WEAPON, INPUT_INTENT_KEYS, normalizeWeapon } from './tactical-client.js';

/** Mapa por defecto de las salas nuevas (el anfitrión puede cambiarlo). */
export const MAP_DEFAULT = 'citadel';
export const MODEL_DEFAULT = SHIP_DEFAULT;
export const MODEL_NOTE = 'Mismo rendimiento en todos: solo cambia el aspecto.';
export const AIM_TURN_SPEED = Number(AIM?.turnSpeed) || 6.5;

/** Elección de modelo saneada (nunca lanza; respaldo = modelo por defecto). */
export function sanitizeModelChoice(raw, fallback = MODEL_DEFAULT) {
  return sanitizeShipModel(raw) ?? sanitizeShipModel(fallback) ?? MODEL_DEFAULT;
}

/** Metadatos legibles de un modelo (id saneado, etiqueta y descripción). */
export function modelMeta(raw) {
  const id = sanitizeModelChoice(raw);
  const found = SHIP_MODELS.find((m) => m.id === id);
  return {
    id,
    label: found?.label ?? id,
    blurb: MODEL_BLURB[id] ?? '',
  };
}

const MODEL_BLURB = Object.freeze({
  viper: 'Perfil afilado, morro largo y deriva corta.',
  bastion: 'Casco ancho con placas de blindaje a la vista.',
  spectre: 'Alas retraídas y silueta de baja firma.',
  alastar: 'Cuatro alas en X, morro fino y lectura clara en giro.',
  interceptor: 'Fuselaje angular con dos motores y travesaños.',
  arwing: 'Ala en flecha, morro de lanza y estela de caza arcade.',
  lobo: 'Alas en garra, costillas marcadas y cola agresiva.',
  'prism-wing': 'Lanza central, alas blancas barridas y módulos azules.',
});

/**
 * Vista previa SVG del casco (nativo, sin imágenes ni fuentes externas).
 * Es solo estética: el `currentColor` lo tiñe la hoja de estilos.
 */
export function modelPreviewSvg(raw) {
  const id = sanitizeModelChoice(raw);
  const shapes = {
    viper: '<path d="M32 6 L41 34 L32 58 L23 34 Z"/><path d="M32 18 L36 40 L32 50 L28 40 Z"/>',
    bastion: '<path d="M32 10 L48 24 L44 52 L20 52 L16 24 Z"/><path d="M22 30 H42"/><path d="M24 40 H40"/>',
    spectre: '<path d="M32 8 L38 36 L50 50 L32 44 L14 50 L26 36 Z"/><path d="M32 20 L34 38 L30 38 Z"/>',
    alastar: '<path d="M32 7 L38 24 L54 18 L43 34 L57 46 L37 39 L32 56 L27 39 L7 46 L21 34 L10 18 L26 24 Z"/><path d="M32 20 L35 35 L32 44 L29 35 Z"/>',
    interceptor: '<path d="M32 6 L38 24 L44 46 L36 43 L32 52 L28 43 L20 46 L26 24 Z"/><path d="M20 45 L25 54 M44 45 L39 54"/><path d="M27 28 H37"/>',
    arwing: '<path d="M32 5 L38 27 L58 38 L39 36 L32 51 L25 36 L6 38 L26 27 Z"/><path d="M32 17 L34 33 L32 42 L30 33 Z"/>',
    lobo: '<path d="M32 4 L40 24 L58 18 L46 36 L55 53 L36 39 L32 57 L28 39 L9 53 L18 36 L6 18 L24 24 Z"/><path d="M32 18 L35 34 L32 45 L29 34 Z"/><path d="M27 42 L22 49 M37 42 L42 49"/>',
    'prism-wing': '<path d="M32 3 L40 24 L61 16 L48 33 L59 51 L36 41 L32 61 L28 41 L5 51 L16 33 L3 16 L24 24 Z" fill="#0a1626" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>'
      + '<path d="M28 24 L13 19 L8 27 L26 33 Z" fill="#f4f9ff" stroke="#ffffff" stroke-width="0.7"/>'
      + '<path d="M36 24 L51 19 L56 27 L38 33 Z" fill="#f4f9ff" stroke="#ffffff" stroke-width="0.7"/>'
      + '<path d="M9 27 L15 23 L17 29 L12 33 Z" fill="#2f9dff" stroke="#bfe9ff" stroke-width="0.7"/>'
      + '<path d="M55 27 L49 23 L47 29 L52 33 Z" fill="#2f9dff" stroke="#bfe9ff" stroke-width="0.7"/>'
      + '<path d="M32 17 L36 27 L32 36 L28 27 Z" fill="#07131f" stroke="#8fd8ff" stroke-width="1"/>',
  };
  const body = shapes[id] ?? shapes[MODEL_DEFAULT];
  return `<svg class="model-preview" viewBox="0 0 64 64" role="img" aria-hidden="true">${body}</svg>`;
}

/** Elección de mapa saneada (respaldo = Ciudadela, el mapa de las salas nuevas). */
export function sanitizeBattlefieldChoice(raw, fallback = MAP_DEFAULT) {
  return sanitizeBattlefield(raw) ?? sanitizeBattlefield(fallback) ?? MAP_DEFAULT;
}

/** Metadatos del mapa (id saneado + etiqueta compartida). */
export function battlefieldMeta(raw) {
  const id = sanitizeBattlefieldChoice(raw);
  return { id, label: BATTLEFIELDS.find((b) => b.id === id)?.label ?? id };
}

/** Un fondo de pantalla por mapa, solo como pista visual en el selector. */
export function battlefieldHint(raw) {
  return sanitizeBattlefieldChoice(raw) === 'citadel'
    ? 'Patio superior, pabellón central, laterales desde los spawns, jardín/reactor y balcones.'
    : 'Arena abierta clásica: rocas, colina móvil y coberturas repartidas.';
}

/**
 * Ángulo de apuntado hacia un punto del mundo, por el camino corto del toro.
 * Devuelve un valor en (-π, π] listo para el contrato `aimAngle`.
 */
export function aimAngleFromPoint(self, point, world) {
  if (!self || !point) return 0;
  const dx = wrapDelta(Number(point.x) - Number(self.x), Number(world?.w) || 1);
  const dy = wrapDelta(Number(point.y) - Number(self.y), Number(world?.h) || 1);
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || (dx === 0 && dy === 0)) return 0;
  return Math.atan2(dy, dx);
}

/** Diferencia angular mínima entre dos ángulos (para saber si ya apunta). */
export function aimError(from, to) {
  return angleDelta(Number(from) || 0, Number(to) || 0);
}

/**
 * Detector de FLANCOS. El contrato pide que humo y rebote se disparen al pulsar,
 * nunca por mantener: el cliente manda `true` solo en la transición y el
 * servidor (autoridad) hace su propio filtro de todos modos.
 */
export function edgeTracker() {
  const previous = new Map();
  return {
    /** ¿Es una subida? Actualiza el estado anterior con el valor recibido. */
    edge(name, value) {
      const now = value === true;
      const rising = now && previous.get(name) !== true;
      previous.set(name, now);
      return rising;
    },
    /** Estado recordado (para pruebas y para limpiar al perder el foco). */
    current(name) {
      return previous.get(name) === true;
    },
    /** Suelta todo: al perder el foco no queda ningún flanco armado. */
    clear() {
      previous.clear();
    },
  };
}

/**
 * Papel del gatillo derecho (RT/R2) según el contexto:
 *   · apuntando (LT) → dispara;
 *   · sin apuntar     → acelera como siempre.
 * R1/RB dispara siempre, así que `fire` no depende de esto.
 */
export function triggerRole({ aiming = false } = {}) {
  return aiming ? 'fire' : 'thrust';
}

const hold = (keys, ...codes) => codes.some((code) => keys?.has?.(code) === true);

/** Vector de desplazamiento lateral (apuntando) desde WASD o el stick izquierdo. */
export function strafeVector(keys, stick) {
  const kx = (hold(keys, 'KeyD', 'ArrowRight') ? 1 : 0) - (hold(keys, 'KeyA', 'ArrowLeft') ? 1 : 0);
  const ky = (hold(keys, 'KeyS', 'ArrowDown') ? 1 : 0) - (hold(keys, 'KeyW', 'ArrowUp') ? 1 : 0);
  const sx = Number(stick?.x);
  const sy = Number(stick?.y);
  const x = Number.isFinite(kx) && kx !== 0 ? kx : Number.isFinite(sx) ? sx : 0;
  const y = Number.isFinite(ky) && ky !== 0 ? ky : Number.isFinite(sy) ? sy : 0;
  const len = Math.hypot(x, y);
  if (len > 1) return { x: x / len, y: y / len };
  return { x, y };
}

/**
 * Resuelve la intención de vuelo a partir de fuentes planas (teclado, mando,
 * ratón y base táctil). Devuelve el intento SIN sanear y el estado de apuntado
 * resultante; main.js lo pasa por `sanitizeInputIntent` antes de enviarlo.
 *
 * Reglas del contrato v0.2 aplicadas aquí:
 *   · LT/L2 apunta; mientras se apunta, el stick derecho apunta (no esquiva) y
 *     el izquierdo/WASD desplaza en pantalla;
 *   · RT/R2 dispara mientras LT y acelera fuera de LT;
 *   · R1/RB dispara siempre;
 *   · sin apuntar, el stick derecho conserva la esquiva lateral clásica;
 *   · derribado: nada de arma, humo, rebote ni apuntado (sigue siendo lento y
 *     rescatable).
 */
export function resolveFlightIntent({
  keys = new Set(),
  pad = null,
  mouse = null,
  touch = null,
  tacticalProfile = false,
  aiming = false,
  lastAimAngle = 0,
  shipAngle = lastAimAngle,
  model = MODEL_DEFAULT,
  weapon = DEFAULT_WEAPON,
  smoke = false,
  bounce = false,
  dashKeys = 0,
  downed = false,
} = {}) {
  const v2 = pad?.v2 ?? null;
  const padInput = pad?.input ?? null;
  // COMPATIBILIDAD: fuera del perfil táctico (ffa/arcade o servidor sin `tac`)
  // solo existe el vuelo clásico. Ni apuntado, ni desplazamiento lateral, ni
  // humo, ni rebote, ni esquiva, ni rescate: el servidor los ignora y aquí ni
  // siquiera se piden (un mando no cambia las reglas de esos modos).
  const tactical = tacticalProfile === true;
  const pointerAim = tactical && mouse?.inside === true && mouse?.aiming === true;
  const nextAiming = tactical && !downed && (pointerAim || v2?.aim === true);

  const intent = {
    rot: 0, thrust: false, brake: false, fire: false, boost: false,
    weapon: tactical ? normalizeWeapon(weapon) : DEFAULT_WEAPON,
    dash: 0, interact: false,
    aim: nextAiming, aimAngle: tactical ? lastAimAngle : 0,
    moveX: 0, moveY: 0,
    smoke: false, bounce: false,
    model: sanitizeModelChoice(model),
  };

  // Assteroids: movement is independent of both the nose and the LT aim
  // button. This uses a shared authoritative flight intent, not forced ADS.
  if (pad?.assteroids && !downed) {
    const a = pad.assteroids;
    const pointer = mouse?.inside === true && mouse?.aiming === true;
    const aim = pointer || a.aim === true;
    const rotKeys = (hold(keys, 'KeyD', 'ArrowRight') ? 1 : 0) - (hold(keys, 'KeyA', 'ArrowLeft') ? 1 : 0);
    const direction = pointer ? mouse.angle : Number.isFinite(a.aimAngle) ? a.aimAngle : lastAimAngle;
    const movement = pointer ? strafeVector(keys, { x: a.moveX, y: a.moveY }) : { x: a.moveX, y: a.moveY };
    Object.assign(intent, {
      flight: pointer ? 'omni-aim' : rotKeys ? 'omni-turn' : a.flight,
      rot: rotKeys || a.rot || 0,
      aim, aimAngle: Number.isFinite(direction) ? direction : lastAimAngle,
      moveX: movement.x, moveY: movement.y,
      thrust: a.thrust || (!pointer && hold(keys, 'KeyW', 'ArrowUp')) || touch?.thrust === true,
      brake: !pointer && hold(keys, 'KeyS', 'ArrowDown'),
      fire: a.fire || (a.sniper && weapon === 'sniper' && tactical) || mouse?.fire === true || hold(keys, 'Space'),
      boost: !aim && (hold(keys, 'ShiftLeft', 'ShiftRight') || touch?.boost === true),
      dash: tactical && (a.dashReleased || dashKeys) ? (dashKeys || 1) : 0,
      smoke: tactical && smoke === true, bounce: tactical && bounce === true,
      interact: tactical && (hold(keys, 'KeyF') || pad.tactical?.interact === true),
    });
    return { intent, aiming: aim, aimAngle: intent.aimAngle, aimSource: pointer ? 'mouse' : 'pad' };
  }

  if (downed) {
    if (pad?.assteroids) {
      const a = pad.assteroids;
      const moving = Math.hypot(a.moveX, a.moveY) > 0.15;
      const delta = moving ? angleDelta(shipAngle, Math.atan2(a.moveY, a.moveX)) : 0;
      intent.rot = moving && Math.abs(delta) > 0.12 ? Math.sign(delta) : a.rot;
      intent.thrust = moving || a.thrust;
      return { intent, aiming: false, aimAngle: lastAimAngle, aimSource: 'none' };
    }
    // Derribado: sólo arrastre lento (teclado, mando o táctil). Ni combate ni
    // apuntado ni recogida de armas.
    intent.rot = (hold(keys, 'KeyD', 'ArrowRight') ? 1 : 0) - (hold(keys, 'KeyA', 'ArrowLeft') ? 1 : 0)
      || touch?.rot || padInput?.rot || 0;
    intent.thrust = hold(keys, 'KeyW', 'ArrowUp') || touch?.thrust === true || padInput?.thrust === true;
    intent.brake = hold(keys, 'KeyS', 'ArrowDown') || touch?.brake === true || padInput?.brake === true;
    return { intent, aiming: false, aimAngle: lastAimAngle, aimSource: 'none' };
  }

  // Arma: cambio absoluto por teclas SOLO en el perfil táctico.
  if (tactical) {
    if (hold(keys, 'Digit1') || hold(keys, 'Numpad1')) intent.weapon = 'auto';
    else if (hold(keys, 'Digit2') || hold(keys, 'Numpad2')) intent.weapon = 'plasma';
    else if (hold(keys, 'Digit3') || hold(keys, 'Numpad3')) intent.weapon = 'sniper';
    else if (hold(keys, 'Digit4') || hold(keys, 'Numpad4')) intent.weapon = 'boomer';
    intent.interact = hold(keys, 'KeyF') || pad?.tactical?.interact === true || touch?.interact === true;
    // Humo y rebote NO se bloquean al apuntar: son flancos de acción y se piden
    // exactamente igual con LT/RMB pulsados (solo el derribo los corta).
    intent.smoke = smoke === true;
    intent.bounce = bounce === true;
  }

  if (nextAiming) {
    const angle = pointerAim
      ? mouse?.angle
      : Number.isFinite(v2?.aimAngle) ? v2.aimAngle : lastAimAngle;
    intent.aimAngle = Number.isFinite(angle) ? angle : lastAimAngle;
    const stick = pad?.sticks
      ? { x: pad.sticks.leftX, y: pad.sticks.leftY }
      : { x: 0, y: 0 };
    const strafe = strafeVector(keys, stick);
    intent.moveX = strafe.x;
    intent.moveY = strafe.y;
    // Disparo apuntando: RT explota el gatillo como disparo, y Espacio / LMB /
    // R1 siguen disparando siempre.
    intent.fire = triggerRole({ aiming: true }) === 'fire'
      ? v2?.thrust === true || v2?.fire === true || mouse?.fire === true || hold(keys, 'Space')
      : v2?.fire === true || mouse?.fire === true || hold(keys, 'Space');
    intent.boost = hold(keys, 'ShiftLeft', 'ShiftRight') || padInput?.boost === true || touch?.boost === true;
    return { intent, aiming: true, aimAngle: intent.aimAngle, aimSource: pointerAim ? 'mouse' : 'pad' };
  }

  // Vuelo clásico (sin apuntado).
  const rotKeys = (hold(keys, 'KeyD', 'ArrowRight') ? 1 : 0) - (hold(keys, 'KeyA', 'ArrowLeft') ? 1 : 0);
  intent.rot = rotKeys || touch?.rot || padInput?.rot || 0;
  intent.thrust = hold(keys, 'KeyW', 'ArrowUp') || touch?.thrust === true || padInput?.thrust === true;
  intent.brake = hold(keys, 'KeyS', 'ArrowDown') || touch?.brake === true || padInput?.brake === true;
  // Disparo del mando:
  //   · en el perfil táctico A/✕ REBOTA (nunca dispara), así que la fuente es
  //     R1/RB del bloque v2 — no el `fire` legacy, que incluye A/✕;
  //   · en ffa/arcade se conserva el disparo clásico tal cual lo da `readPad`.
  const padFire = tactical ? v2?.fire === true : padInput?.fire === true;
  intent.fire = hold(keys, 'Space') || touch?.fire === true || padFire || mouse?.fire === true;
  intent.boost = hold(keys, 'ShiftLeft', 'ShiftRight') || touch?.boost === true || padInput?.boost === true;
  if (tactical) {
    intent.dash = dashKeys === 1 ? 1 : dashKeys === -1 ? -1
      : pad?.tactical?.dash === 1 ? 1 : pad?.tactical?.dash === -1 ? -1 : 0;
  }
  return { intent, aiming: false, aimAngle: lastAimAngle, aimSource: 'none' };
}

/** Atajos nuevos de teclado de la v0.2 (los clásicos ya los lee el vuelo). */
export function keyAction(code) {
  switch (code) {
    case 'Digit3': case 'Numpad3': return 'weapon:sniper';
    case 'Digit4': case 'Numpad4': return 'weapon:boomer';
    case 'KeyQ': return 'dash:-1';
    case 'KeyE': return 'dash:1';
    case 'KeyG': return 'smoke';
    case 'AltLeft': case 'AltRight': return 'bounce';
    default: return null;
  }
}

/** Teclas de FLANCO: se piden una vez por pulsación (auto-repeat no repite). */
export const FLANK_KEYS = Object.freeze({ KeyG: 'smoke', AltLeft: 'bounce', AltRight: 'bounce' });

/**
 * Acción de flanco de una tecla, o null. El auto-repeat del sistema se ignora:
 * mantener G o Alt NO vuelve a lanzar humo ni rebote.
 */
export function keyFlankAction(code, { repeat = false } = {}) {
  if (repeat === true) return null;
  return FLANK_KEYS[code] ?? null;
}

/** Nombres de acción que viajan como flanco en `input`. */
export const FLANK_ACTIONS = Object.freeze(['smoke', 'bounce']);

/**
 * Retención (latch) de flancos. Un flanco puede coincidir con un frame en el
 * que el planificador rechaza el envío (presupuesto/ritmo): sin retención se
 * perdería. El valor se mantiene `true` hasta que un mensaje lo transmite de
 * verdad y, acto seguido, vuelve a `false` (el servidor ve el flanco completo).
 */
/** Una activación de dash sobrevive al límite de envío y conserva su dirección.
 * El identificador solo cambia al pulsar de nuevo, nunca por mantener pulsado.
 */
export function createDashLatch() {
  let serial = 0, previous = 0, pending = null;
  return {
    sample(intent, pulse = false) {
      const dir = intent.dash || 0;
      if (dir && (pulse || dir !== previous)) {
        pending = { dash: dir, dashId: ++serial, moveX: intent.moveX, moveY: intent.moveY,
          ...(intent.flight ? { flight: intent.flight } : {}) };
      }
      previous = dir;
      return pending ? { ...intent, ...pending } : intent;
    },
    commitWire(wire) { if (pending?.dashId === wire.dashId) pending = null; },
    clear() { pending = null; previous = 0; },
  };
}

export function createActionLatch(names = FLANK_ACTIONS) {
  const pending = new Set();
  return {
    /** Apunta el flanco (idempotente mientras no se transmita). */
    request(name) {
      if (names.includes(name)) pending.add(name);
    },
    /** Valor a enviar: `true` mientras el flanco no haya viajado. */
    value(name) {
      return pending.has(name);
    },
    /** Tras un envío real: los flancos que iban en ese mensaje ya no se repiten. */
    commitWire(wire) {
      for (const name of names) {
        if (wire?.[name] === true) pending.delete(name);
      }
    },
    has(name) {
      return pending.has(name);
    },
    clear() {
      pending.clear();
    },
  };
}

/** Pista compacta de controles en partida (mando o teclado+ratón). */
export function flightHint({ padActive = false, tactical = false, downed = false, profile = 'citadel' } = {}) {
  if (downed) return 'DERRIBADO · un compañero debe mantener △/Y o F a tu lado';
  if (padActive && profile !== 'citadel') return 'LS mueve · RS ' + (profile === 'assteroids-aim' ? 'orienta' : 'gira') + ' · RT dispara · LT apunta · LB propulsa / soltar esquiva · A humo · B rebote';
  if (!tactical) return padActive ? 'Mando · stick izq. vuela · R2 acelera · R1 dispara' : 'Teclado · WASD/cursores · Espacio dispara';
  return padActive
    ? 'LT apunta · stick dcho. apunta · RT dispara · A/✕ rebote en cobertura · R3 humo · □ arma · △ rescate'
    : 'RMB apunta · LMB dispara · Q/E esquiva · G humo · Alt rebote · 1-4 armas · F rescate';
}

// ─────────────────────────────────────── ritmo de envío del input (rate-limit)
// El apuntado (LT + stick derecho) y el desplazamiento lateral cambian en CADA
// frame: a 120 Hz eso serían 120 mensajes/s y el servidor corta el grifo a 90
// (y el contrato pide 30 Hz de input). Por eso el envío se planifica:
//   · los cambios de ACCIÓN (disparo, esquiva, arma, humo, rebote, rescate,
//     apuntado on/off, modelo) salen de inmediato — son flancos, no ráfagas;
//   · los campos CONTINUOS (aimAngle, moveX, moveY) salen como mucho al ritmo
//     del contrato (inputSendHz), sin redondear el ángulo: la mira local sigue
//     siendo instantánea porque la vista dibuja la intención, no el servidor;
//   · y en ningún caso se supera el presupuesto duro de mensajes por segundo.

/** Ritmo de input del contrato (30 Hz), en milisegundos. */
export const INPUT_INTERVAL_MS = 1000 / (Number(NET?.inputSendHz) || 30);
/** Presupuesto duro: nunca más de 60 mensajes de input por segundo. */
export const INPUT_MAX_PER_SECOND = 60;
/** Campos que cambian en cada frame (no fuerzan envío inmediato). */
export const CONTINUOUS_FIELDS = Object.freeze(['aimAngle', 'moveX', 'moveY']);
/** Campos de acción: cualquier cambio de estos sale ya. */
export const ACTION_FIELDS = Object.freeze(
  INPUT_INTENT_KEYS.filter((key) => !CONTINUOUS_FIELDS.includes(key)),
);

/** Huella estable de una intención para detectar cambios (sin redondear nada). */
export function intentDigest(intent, fields = INPUT_INTENT_KEYS) {
  if (!intent) return '';
  return fields
    .map((key) => {
      const value = intent[key];
      if (typeof value === 'boolean') return `${key}:${value ? 1 : 0}`;
      if (typeof value === 'number') return `${key}:${Number.isFinite(value) ? value : 0}`;
      return `${key}:${value ?? ''}`;
    })
    .join('|');
}

/** Margen anti-error de coma flotante: un slot exacto no se pierde. */
const TIME_EPSILON = 1e-6;

/**
 * Planificador de envío del input. Todo el tiempo entra por parámetro (`now`),
 * así que se puede probar a 120 fps sin navegador.
 */
export function createInputSender({ intervalMs = INPUT_INTERVAL_MS, maxPerSecond = INPUT_MAX_PER_SECOND } = {}) {
  const window = [];
  let lastAt = -Infinity;
  const prune = (now) => {
    while (window.length && now - window[0] >= 1000) window.shift();
  };
  return {
    /** ¿Toca enviar ahora? `instant` = hay un flanco que no puede esperar. */
    due(now, { instant = false, changed = true } = {}) {
      const t = Number.isFinite(now) ? now : 0;
      prune(t);
      if (window.length >= maxPerSecond) return false;
      if (instant) {
        lastAt = t;
        window.push(t);
        return true;
      }
      // A 120 fps los tiempos acumulan error: `8 × 1000/120` puede quedar una
      // milmillonésima POR DEBAJO de `1000/30` y perder un turno (27 en vez de
      // 30 envíos/s). El epsilon hace que un turno exacto cuente como cumplido.
      if (t - lastAt + TIME_EPSILON < intervalMs) return false;
      if (!changed && t - lastAt + TIME_EPSILON < intervalMs * 2) return false;
      lastAt = t;
      window.push(t);
      return true;
    },
    /** Envíos dentro de la ventana de 1 s (para el HUD y las pruebas). */
    sentInWindow(now) {
      prune(Number.isFinite(now) ? now : 0);
      return window.length;
    },
    reset() {
      window.length = 0;
      lastAt = -Infinity;
    },
  };
}
