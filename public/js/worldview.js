// Orbit Hill — normaliza el contrato de mundo del servidor.
// `welcome`, `roster`, `snap` y `settings` traen {settings, world, hill} y aquí
// se convierten en un objeto estable para el render, la interpolación, la
// predicción, las partículas y el minimapa. Si el servidor todavía no los manda
// (backend en implementación) se usa el respaldo compartido recibido por
// parámetro: las constantes globales NUNCA se mutan ni se reescriben.
//
// Módulo puro (sin DOM): solo importa camera-options.js, así que es testeable
// en Node.

import { DEFAULT_ARENA, DEFAULT_HILL_SECONDS, arenaDims, normalizeArena, normalizeHillSeconds } from './camera-options.js';
import { STOCK_OPTIONS, STOCKS_DEFAULT } from '/shared/constants.js';

/** Ventana de aviso de la próxima colina (segundos). */
export const HILL_WARN_SECONDS = 5;

/** Respaldo último (coincide con shared/constants.js) si no llega nada. */
export const DEFAULT_WORLD = Object.freeze({ w: 1800, h: 1200 });
export const DEFAULT_HILL = Object.freeze({ x: 900, y: 600, radius: 215 });

const num = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const firstOf = (...values) => values.find((v) => v !== undefined && v !== null);

export function intoRange(value, size) {
  if (!(size > 0)) return 0;
  return ((value % size) + size) % size;
}

export function normalizeWorld(raw, fallback = DEFAULT_WORLD) {
  const w = num(firstOf(raw?.w, raw?.width), num(fallback?.w, DEFAULT_WORLD.w));
  const h = num(firstOf(raw?.h, raw?.height), num(fallback?.h, DEFAULT_WORLD.h));
  return { w: w > 0 ? w : DEFAULT_WORLD.w, h: h > 0 ? h : DEFAULT_WORLD.h };
}

/**
 * Radio de respaldo proporcional al área: con arena grande la colina no se
 * encoge. Con la arena clásica devuelve exactamente el radio compartido.
 */
export function fallbackHillRadius(world, baseRadius = DEFAULT_HILL.radius, baseWorld = DEFAULT_WORLD) {
  const w = world?.w > 0 ? world.w : DEFAULT_WORLD.w;
  const h = world?.h > 0 ? world.h : DEFAULT_WORLD.h;
  return baseRadius * Math.sqrt((w * h) / (baseWorld.w * baseWorld.h));
}

export function normalizeSettings(raw, fallback = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    arena: normalizeArena(firstOf(src.arena, src.a), fallback?.arena ?? DEFAULT_ARENA),
    hillSeconds: normalizeHillSeconds(firstOf(src.hillSeconds, src.hs), fallback?.hillSeconds ?? DEFAULT_HILL_SECONDS),
    stocks: STOCK_OPTIONS.includes(Number(firstOf(src.stocks))) ? Number(firstOf(src.stocks)) : (fallback?.stocks ?? STOCKS_DEFAULT),
  };
}

/**
 * hill.remaining = segundos hasta el próximo salto.
 *   · remaining > 0            → colina móvil.
 *   · remaining 0 + nextX/Y    → salto inminente (la rotación redondea a 1
 *     decimal y puede anunciar 0 unos frames antes de mover).
 *   · remaining 0 sin aviso    → colina fija (el backend usa 0 para "fija").
 * nextX/nextY solo se conservan cuando el aviso está vigente (≤ 5 s).
 */
export function normalizeHill(raw, world, fallback = null, warnSeconds = HILL_WARN_SECONDS) {
  const w = world?.w > 0 ? world.w : DEFAULT_WORLD.w;
  const h = world?.h > 0 ? world.h : DEFAULT_WORLD.h;
  const fb = fallback ?? DEFAULT_HILL;
  const radius = num(firstOf(raw?.r, raw?.radius), num(firstOf(fb.r, fb.radius), fallbackHillRadius(world)));

  const nextXRaw = num(firstOf(raw?.nextX, raw?.nx), NaN);
  const nextYRaw = num(firstOf(raw?.nextY, raw?.ny), NaN);
  const hasRawNext = Number.isFinite(nextXRaw) && Number.isFinite(nextYRaw);

  const remainingRaw = firstOf(raw?.remaining, raw?.rem);
  let remaining = null;
  if (remainingRaw !== undefined && remainingRaw !== null) {
    const value = Math.max(0, num(remainingRaw, 0));
    if (value > 0 || hasRawNext) remaining = value;
  }

  const hasNext = remaining !== null && remaining <= warnSeconds && hasRawNext;

  return {
    x: intoRange(num(firstOf(raw?.x), num(firstOf(fb.x), DEFAULT_HILL.x)), w),
    y: intoRange(num(firstOf(raw?.y), num(firstOf(fb.y), DEFAULT_HILL.y)), h),
    r: radius > 0 ? radius : fallbackHillRadius(world),
    remaining,
    nextX: hasNext ? intoRange(nextXRaw, w) : null,
    nextY: hasNext ? intoRange(nextYRaw, h) : null,
  };
}

/** Config completa (mundo + ajustes + colina) ya normalizada. */
export function viewConfig(msg, prev = {}, fallback = {}) {
  // El tamaño de la arena declarada solo se usa como pista si el mensaje no trae
  // mundo: prev (mundo vigente) y fallback (constantes compartidas) mandan.
  const declaredArena = firstOf(msg?.settings?.arena, msg?.arena);
  const arenaHint = declaredArena === undefined ? null : arenaDims(normalizeArena(declaredArena, DEFAULT_ARENA));
  const world = normalizeWorld(
    msg?.world,
    firstOf(prev.world, fallback.world, arenaHint, DEFAULT_WORLD),
  );
  const settings = normalizeSettings(
    firstOf(msg?.settings, msg?.arena !== undefined || msg?.hillSeconds !== undefined ? msg : null),
    prev.settings ?? fallback.settings ?? {},
  );
  const hill = normalizeHill(msg?.hill, world, prev.hill ?? fallback.hill ?? null);
  return { world, settings, hill };
}

export function sameWorld(a, b) {
  return !!a && !!b && a.w === b.w && a.h === b.h;
}

export function sameSettings(a, b) {
  return !!a && !!b && a.arena === b.arena && a.hillSeconds === b.hillSeconds;
}

export function sameConfig(a, b) {
  return sameWorld(a?.world, b?.world) && sameSettings(a?.settings, b?.settings);
}

/**
 * Objetivo del HUD/minimapa: la colina actual, o la próxima ubicación cuando el
 * aviso está vigente (últimos 5 s y nextX/nextY presentes).
 */
export function hillTarget(hill, warnSeconds = HILL_WARN_SECONDS) {
  const hasNext = hill?.remaining !== null && hill?.remaining !== undefined &&
    hill.remaining <= warnSeconds && hill?.nextX !== null && hill?.nextX !== undefined &&
    hill?.nextY !== null && hill?.nextY !== undefined;
  if (hasNext) return { x: hill.nextX, y: hill.nextY, next: true, seconds: hill.remaining };
  return {
    x: hill?.x ?? DEFAULT_HILL.x,
    y: hill?.y ?? DEFAULT_HILL.y,
    next: false,
    seconds: hill?.remaining ?? null,
  };
}

/** Texto corto del temporizador de colina para el HUD. */
export function hillTimerText(hill, warnSeconds = HILL_WARN_SECONDS) {
  const remaining = hill?.remaining;
  if (remaining === null || remaining === undefined) return 'COLINA FIJA';
  const seconds = Math.max(0, Math.ceil(remaining));
  if (seconds <= 0) return '¡SE MUEVE YA!';
  return remaining <= warnSeconds ? `¡SE MUEVE EN ${seconds}s!` : `SE MUEVE EN ${seconds}s`;
}
