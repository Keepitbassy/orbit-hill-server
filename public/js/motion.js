// Orbit Hill — movimiento toroidal puro del cliente.
//
// Aquí vive TODO lo que envuelve posiciones: interpolación entre snapshots,
// predicción local de la propia nave, corrección suave hacia el servidor y la
// boca del cañón. Todas las funciones reciben el MUNDO autoritativo (el del
// servidor) y jamás envuelven con las constantes compartidas.
//
// Por qué existe: con una arena Grande (3000×2000) envolver a 1800 teletrans-
// portaba la nave al cruzar el borde (2998 → 4 interpolaba a 1501 en vez de 1,
// y pasar por x = 1800 saltaba a 0).
//
// Import relativo a propósito: el servidor sirve `shared/` como `/shared/`, así
// que `../../shared/physics.js` resuelve igual en el navegador que en Node
// (tests puros sin cargador ni emulación).

import { angleDelta, stepShip, wrap, wrapDelta } from '../../shared/physics.js';

/** Respaldo si un mensaje llegara sin mundo: nunca es una constante mutable. */
export const FALLBACK_WORLD = Object.freeze({ w: 1800, h: 1200 });

/** Normaliza el mundo con el que envolver posiciones (w/h positivos). */
export function worldOf(world, fallback = FALLBACK_WORLD) {
  const w = Number(world?.w);
  const h = Number(world?.h);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    return { w: fallback.w, h: fallback.h };
  }
  return { w, h };
}

/**
 * Factor de interpolación entre dos snapshots, con colchón y extrapolación
 * acotada (si falta un snapshot no se congela la nave).
 */
export function interpolationFactor(prevAt, nextAt, now, delayMs = 95, maxT = 1.35) {
  const span = Math.max(1, nextAt - prevAt);
  const t = (now - delayMs - prevAt) / span;
  return t < 0 ? 0 : t > maxT ? maxT : t;
}

/** Ángulo interpolado por el camino corto. */
export function lerpAngle(a, b, t) {
  return a + angleDelta(a, b) * t;
}

/**
 * Posición interpolada por el camino corto del toro del mundo dado.
 * Con w = 3000, 2998 → 4 interpola a ~1 (no a 1501).
 */
export function lerpPos(ax, ay, bx, by, t, world) {
  const { w, h } = worldOf(world);
  return [
    wrap(ax + wrapDelta(bx - ax, w) * t, w),
    wrap(ay + wrapDelta(by - ay, h) * t, h),
  ];
}

/** Distancia por el camino corto del toro (útil para depurar y para pruebas). */
export function torusDistance(ax, ay, bx, by, world) {
  const { w, h } = worldOf(world);
  return Math.hypot(wrapDelta(bx - ax, w), wrapDelta(by - ay, h));
}

/**
 * Avanza la predicción local con el mundo real: los límites del toro son los
 * del servidor, no los de la arena clásica. Devuelve si aplicó empuje
 * (el resto — fricción, freno, boost, tope de velocidad — lo hace stepShip).
 */
export function advancePrediction(pred, input, dt, world) {
  const { w, h } = worldOf(world);
  const thrusting = stepShip(pred, input, dt, { w, h });
  pred.x = wrap(pred.x, w);
  pred.y = wrap(pred.y, h);
  return thrusting;
}

/**
 * Corrección suave hacia la verdad del servidor, siempre por el camino corto.
 * Si el error es enorme (respawn o teletransporte legítimo) se acepta el salto;
 * nunca se corrige "hacia atrás" con tirones.
 */
export function correctPrediction(pred, truth, dt, world, options = {}) {
  const { w, h } = worldOf(world);
  const snapDistance = options.snapDistance ?? 140;
  const rate = options.rate ?? 6.5;
  const errX = wrapDelta(truth.x - pred.x, w);
  const errY = wrapDelta(truth.y - pred.y, h);
  const distance = Math.hypot(errX, errY);
  const snapped = distance > snapDistance;
  const k = snapped ? 1 : 1 - Math.exp(-rate * dt);
  pred.x = wrap(pred.x + errX * k, w);
  pred.y = wrap(pred.y + errY * k, h);
  return { errX, errY, distance, snapped, k };
}

/** Boca del cañón en coordenadas del mundo real (fogonazo local). */
export function muzzlePoint(ship, world, offset = 0) {
  const { w, h } = worldOf(world);
  const cos = Math.cos(ship?.angle ?? 0);
  const sin = Math.sin(ship?.angle ?? 0);
  return [
    wrap((ship?.x ?? 0) + cos * offset, w),
    wrap((ship?.y ?? 0) + sin * offset, h),
  ];
}
