// Orbit Hill - fisica compartida.
// Se usa TANTO en el servidor autoritativo como en la prediccion local del
// cliente, de modo que ambas simulaciones coinciden tick a tick.

import { SHIP, BULLET, WORLD } from './constants.js';
import { AIM } from './arsenal.js';
import { sanitizeFlight } from './flight-profiles.js';

// Constante de aproximación del modo apuntado. No forma parte de `AIM` (que es
// contrato fijo): es puramente interna y la comparten servidor y predicción
// porque ambos usan ESTA función.
const AIM_APPROACH = 11;

/** Envuelve una coordenada dentro de [0, size). Arena toroidal. */
export function wrap(value, size) {
  const m = value % size;
  return m < 0 ? m + size : m;
}

/** Diferencia signada mas corta en un toro (para distancias y apuntado). */
export function wrapDelta(delta, size) {
  let d = delta % size;
  if (d > size / 2) d -= size;
  if (d < -size / 2) d += size;
  return d;
}

/** Diferencia angular normalizada a (-PI, PI]. */
export function angleDelta(from, to) {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** Vector desplazamiento mas corto entre dos puntos del toro. */
export function torusDelta(ax, ay, bx, by, world = WORLD) {
  return {
    dx: wrapDelta(bx - ax, world.w),
    dy: wrapDelta(by - ay, world.h),
  };
}

/** Distancia euclidiana real (sin envolver) entre dos puntos. */
export function distance(ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Distancia en el toro (considerando el atajo por los bordes). */
export function torusDistance(ax, ay, bx, by, world = WORLD) {
  const { dx, dy } = torusDelta(ax, ay, bx, by, world);
  return Math.sqrt(dx * dx + dy * dy);
}

/** Colision circular en el toro. */
export function torusHit(ax, ay, ar, bx, by, br, world = WORLD) {
  return torusDistance(ax, ay, bx, by, world) <= ar + br;
}

/** Limita un numero a un rango. */
export function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

/**
 * Aplica un paso de integracion a una nave.
 * `ship` necesita { x, y, vx, vy, angle }. Devuelve true si aplico empuje.
 * No toca vida, timers de disparo ni dano: eso vive en la logica de partida.
 */
export function stepShip(ship, input, dt, world = WORLD) {
  const omni = sanitizeFlight(input?.flight);
  // ── modo apuntado (LT/L2) ────────────────────────────────────────────────
  // Rama ADITIVA: sin `aim` el paso es EXACTAMENTE el clásico de siempre. Con
  // `aim`, el morro persigue `aimAngle` con un límite de giro y el
  // desplazamiento lo manda `moveX/moveY` (relativo a pantalla) con tope de
  // velocidad. Al vivir aquí, la predicción del cliente coincide tick a tick.
  if (!omni && input?.aim === true && Number.isFinite(input.aimAngle)) {
    return stepShipAimed(ship, input, dt, world ?? WORLD);
  }
  const rot = clamp(input?.rot | 0, -1, 1);
  if (omni === 'omni-aim' && Number.isFinite(input.aimAngle)) {
    const limit = (input.aim ? AIM.turnSpeed : SHIP.turnSpeed) * dt;
    ship.angle += clamp(angleDelta(ship.angle, input.aimAngle), -limit, limit);
  } else {
    ship.angle += rot * SHIP.turnSpeed * dt;
  }
  if (ship.angle > Math.PI) ship.angle -= Math.PI * 2;
  if (ship.angle < -Math.PI) ship.angle += Math.PI * 2;

  const boosting = !!input?.boost && (ship.boostTimer ?? 0) > 0;
  if (boosting) ship.boostTimer = Math.max(0, (ship.boostTimer ?? 0) - dt);

  // Sobremarcha es un estado que decide el servidor. Al guardarse sobre la
  // nave, esta función compartida conserva la predicción local sin abrir una
  // vía para que el cliente se conceda velocidad.
  const speedFactor = Number.isFinite(ship.speedBoost) ? Math.max(1, ship.speedBoost) : 1;
  const accel = (boosting ? SHIP.boostThrust : SHIP.thrust) * speedFactor;
  const forward = !!input?.thrust || boosting;
  const mx = omni ? clamp(Number.isFinite(input.moveX) ? input.moveX : 0, -1, 1) : 0;
  const my = omni ? clamp(Number.isFinite(input.moveY) ? input.moveY : 0, -1, 1) : 0;
  const length = Math.hypot(mx, my);
  const pushing = forward || length > 0;

  if (forward) {
    ship.vx += Math.cos(ship.angle) * accel * dt;
    ship.vy += Math.sin(ship.angle) * accel * dt;
  } else if (input?.brake) {
    // Freno: retro-empuje suave + amortiguacion extra.
    ship.vx -= Math.cos(ship.angle) * SHIP.thrust * 0.55 * dt;
    ship.vy -= Math.sin(ship.angle) * SHIP.thrust * 0.55 * dt;
    const brakeDamp = Math.exp(-2.6 * dt);
    ship.vx *= brakeDamp;
    ship.vy *= brakeDamp;
  }

  if (omni && length > 0) {
    const scale = (input.aim ? 0.48 : 1) / Math.max(1, length);
    ship.vx += mx * scale * SHIP.thrust * dt;
    ship.vy += my * scale * SHIP.thrust * dt;
  }

  // Friccion exponencial -> independiente del framerate.
  const damp = Math.exp(-SHIP.damping * dt);
  ship.vx *= damp;
  ship.vy *= damp;

  const speed = Math.hypot(ship.vx, ship.vy);
  const cap = (omni && input.aim ? AIM.maxSpeed : boosting ? SHIP.boostMaxSpeed : SHIP.maxSpeed) * speedFactor;
  if (speed > cap) {
    ship.vx = (ship.vx / speed) * cap;
    ship.vy = (ship.vy / speed) * cap;
  }

  ship.x = wrap(ship.x + ship.vx * dt, world.w);
  ship.y = wrap(ship.y + ship.vy * dt, world.h);
  return pushing;
}

/**
 * Paso de nave en modo apuntado (`aim`).
 *  - el morro gira hacia `aimAngle` a lo sumo `AIM.turnSpeed` rad/s
 *  - `moveX/moveY` ([-1,1] por eje, normalizados en módulo) desplazan la nave
 *    con tope `AIM.maxSpeed`; la velocidad se aproxima de forma exponencial
 *    para que sea independiente del framerate y no dé tirones
 *  - NO aplica empuje/boost clásicos ni fricción: el modo apuntado sustituye
 *    al vuelo clásico mientras se mantiene
 * Devuelve true si el piloto pidió desplazamiento (equivalente a `pushing`).
 */
function stepShipAimed(ship, input, dt, world) {
  const maxTurn = AIM.turnSpeed * dt;
  const diff = angleDelta(ship.angle, input.aimAngle);
  ship.angle += clamp(diff, -maxTurn, maxTurn);
  if (ship.angle > Math.PI) ship.angle -= Math.PI * 2;
  if (ship.angle < -Math.PI) ship.angle += Math.PI * 2;

  const mx = clamp(Number.isFinite(input.moveX) ? input.moveX : 0, -1, 1);
  const my = clamp(Number.isFinite(input.moveY) ? input.moveY : 0, -1, 1);
  const mag = Math.hypot(mx, my);
  const scale = mag > 1 ? 1 / mag : 1;
  const speedFactor = Number.isFinite(ship.speedBoost) ? Math.max(1, ship.speedBoost) : 1;
  const desiredVx = mx * scale * AIM.maxSpeed * speedFactor;
  const desiredVy = my * scale * AIM.maxSpeed * speedFactor;
  const k = 1 - Math.exp(-AIM_APPROACH * dt);
  ship.vx += (desiredVx - ship.vx) * k;
  ship.vy += (desiredVy - ship.vy) * k;

  // El tope de velocidad se reafirma cada tick: ni un cambio brusco de dirección
  // (o un impacto) puede dejar la nave por encima del máximo mientras apunta.
  const speed = Math.hypot(ship.vx, ship.vy);
  if (speed > AIM.maxSpeed * speedFactor) {
    ship.vx = (ship.vx / speed) * AIM.maxSpeed * speedFactor;
    ship.vy = (ship.vy / speed) * AIM.maxSpeed * speedFactor;
  }

  ship.x = wrap(ship.x + ship.vx * dt, world.w);
  ship.y = wrap(ship.y + ship.vy * dt, world.h);
  return mag > 1e-6;
}

/**
 * Crea una bala a partir de la nave que dispara (con desvío angular opcional).
 * El `world` opcional permite que cada partida use su propia arena; sin él se
 * conserva la API antigua (arena clásica).
 *
 * `opts` es opcional y ADDITIVE: permite crear perdigones de plasma (velocidad,
 * vida, daño, radio y `kind` propios) sin cambiar el comportamiento clásico.
 * El daño viaja en la propia bala para que el impacto sea autoritativo.
 */
export function spawnBullet(ship, id, angleOffset = 0, world = WORLD, opts = {}) {
  const w = world ?? WORLD;
  const angle = ship.angle + angleOffset;
  const nx = Math.cos(angle);
  const ny = Math.sin(angle);
  const speed = opts.speed ?? BULLET.speed;
  return {
    id,
    owner: ship.id,
    team: ship.team,
    x: wrap(ship.x + nx * (SHIP.radius + 6), w.w),
    y: wrap(ship.y + ny * (SHIP.radius + 6), w.h),
    vx: nx * speed + ship.vx * BULLET.inherited,
    vy: ny * speed + ship.vy * BULLET.inherited,
    life: opts.life ?? BULLET.life,
    damage: opts.damage ?? BULLET.damage,
    radius: opts.radius ?? BULLET.radius,
    kind: opts.kind ?? 'auto',
  };
}

/** Avanza una bala y devuelve true si sigue viva. */
export function stepBullet(bullet, dt, world = WORLD) {
  bullet.x = wrap(bullet.x + bullet.vx * dt, world.w);
  bullet.y = wrap(bullet.y + bullet.vy * dt, world.h);
  bullet.life -= dt;
  return bullet.life > 0;
}

/** Genera un poligono irregular determinista para un asteroide. */
export function asteroidShape(seed, points = 10) {
  const rnd = mulberry32(seed >>> 0);
  const verts = [];
  for (let i = 0; i < points; i++) {
    verts.push(0.72 + rnd() * 0.46);
  }
  return verts;
}

/** PRNG determinista pequeno (para formas y repoblado reproducible). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rnd() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
