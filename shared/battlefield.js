// Orbit Hill Ciudadela — mapas del campo de batalla (agente MAPA).
//
// Este módulo es PURO y compartido: lo usan el servidor autoritativo (colisión,
// LOS de explosión/humo, reparto de weapon pads) y el cliente (predicción y
// dibujo). No importa nada del servidor ni guarda estado.
//
// Contrato fijo (NOMBRES QUE NO DEBEN CAMBIAR):
//   BATTLEFIELDS                 catálogo [{id,label}]
//   sanitizeBattlefield(raw)     -> id | null
//   buildBattlefield(id,world,seed) -> {id,covers,zones,pads,spawns}
//   coverContact(x,y,r,c,world)  -> null | {nx,ny,depth}
//   segmentBlocked(ax,ay,bx,by,covers,world) -> boolean
//
// Ciudadela está inspirada en la disposición de un patio urbano (Jacinto):
// spawns opuestos a los lados (jardín / reactor), patio superior, pabellón
// central, rutas laterales, balcones inferiores y mirador inferior. Toda la
// geometría se dibuja con vectores nativos: aquí solo viven los DATOS.
//
// Formato de cobertura:
//   {id,key,kind,x,y,w,h,r,hp,maxHp,variant}
//   · kind 'wall' (640 hp, pared ancha) | 'block' (320 hp, bloque)
//   · x,y = CENTRO en unidades de mundo; w,h > 0 → RECTÁNGULO axis-aligned
//   · r = radio envolvente (minimapa y separación de colina, NUNCA colisión
//     circular: la colisión de un rectángulo es la del rectángulo)
//   · variant = adorno cosmético determinista (no afecta a la colisión)
// Las coberturas legacy de 6 campos (id,x,y,r,hp,maxHp) siguen siendo CÍRCULOS:
// este módulo acepta ambas formas en todo momento.

import { HILL, SHIP, SPAWN_AREA, WORLD } from './constants.js';
import { clamp, torusDelta, torusDistance, wrapDelta } from './physics.js';
import { hillBounds, hillMinDistance } from './rules.js';

export const BATTLEFIELDS = Object.freeze([{id:'orbit',label:'Órbita abierta'},{id:'citadel',label:'Ciudadela orbital'}]);
export const sanitizeBattlefield = id => BATTLEFIELDS.some(m=>m.id===id) ? id : null;

/** Marco de diseño de la Ciudadela (arena clásica 1800×1200). Se escala a las
 *  cuatro arenas con un factor uniforme (misma relación de aspecto 1.5). */
const DESIGN = Object.freeze({ w: 1800, h: 1200 });
const COVER_HP = Object.freeze({ wall: 640, block: 320 });
const CITADEL_SPAWNS = Object.freeze({ cyan: Object.freeze({ x: 288, y: 600 }), coral: Object.freeze({ x: 1512, y: 600 }) });

/** Pisos/plazas/corredores. Solo decoran el suelo y dan nombre al mapa. */
const CITADEL_ZONES = Object.freeze([
  Object.freeze({ id: 'courtyard', label: 'Patio superior', x: 594, y: 88, w: 612, h: 206 }),
  Object.freeze({ id: 'northway', label: 'Corredor norte', x: 700, y: 294, w: 400, h: 180 }),
  Object.freeze({ id: 'pavilion', label: 'Pabellón central', x: 688, y: 474, w: 424, h: 252 }),
  Object.freeze({ id: 'garden', label: 'Jardín oeste', x: 80, y: 438, w: 360, h: 262 }),
  Object.freeze({ id: 'reactor', label: 'Reactor este', x: 1360, y: 438, w: 360, h: 262 }),
  Object.freeze({ id: 'laneW', label: 'Ruta oeste', x: 330, y: 196, w: 264, h: 182 }),
  Object.freeze({ id: 'laneE', label: 'Ruta este', x: 1206, y: 196, w: 264, h: 182 }),
  Object.freeze({ id: 'balconyW', label: 'Balcón del jardín', x: 390, y: 820, w: 340, h: 150 }),
  Object.freeze({ id: 'balconyE', label: 'Balcón del reactor', x: 1070, y: 820, w: 340, h: 150 }),
  Object.freeze({ id: 'overlook', label: 'Mirador inferior', x: 760, y: 940, w: 280, h: 180 }),
]);

/** Pads de armas especiales: sniper arriba (patio), boomer abajo (mirador) y
 *  humo en las rutas laterales. Recoger munición NO es gratis: hay que ir. */
const CITADEL_PADS = Object.freeze([
  Object.freeze({ id: 'padSniper', x: 900, y: 150, type: 'sniper' }),
  Object.freeze({ id: 'padBoomer', x: 900, y: 1050, type: 'boomer' }),
  Object.freeze({ id: 'padSmokeW', x: 430, y: 370, type: 'smoke' }),
  Object.freeze({ id: 'padSmokeE', x: 1370, y: 370, type: 'smoke' }),
]);

/**
 * Coberturas del ala oeste (x,y = esquina superior izquierda en unidades de
 * diseño). El ala este se genera por ESPEJO (x' = 1800 − x − w) para garantizar
 * simetría de combate exacta. Los pares que se tocan forman esquinas de un
 * mismo muro (unión, no pasillo): el validador exige huecos ≥ 74 unidades o
 * unión ≤ 14.
 *
 * Pasillos garantizados (unidades de diseño, ≥ 2·SHIP.r + colchón):
 *   · colina central libre (≥ 265 de radio desde el centro)
 *   · ruta oeste  (x 314–392 y 78 de ancho) y su espejo
 *   · corredor del pabellón (y 404–506, 102 de alto) y su espejo
 *   · hueco del balcón (626–700, 74 de ancho) y su espejo
 */
const CITADEL_WEST = Object.freeze([
  Object.freeze({ key: 'wall-court-w', kind: 'wall', x: 540, y: 240, w: 24, h: 160 }),
  Object.freeze({ key: 'blk-court-nw', kind: 'block', x: 590, y: 84, w: 70, h: 70 }),
  Object.freeze({ key: 'blk-court-c', kind: 'block', x: 730, y: 190, w: 56, h: 56 }),
  Object.freeze({ key: 'blk-lane-nw', kind: 'block', x: 392, y: 236, w: 70, h: 70 }),
  Object.freeze({ key: 'wall-garden-n', kind: 'wall', x: 104, y: 412, w: 210, h: 24 }),
  Object.freeze({ key: 'wall-garden-w', kind: 'wall', x: 80, y: 438, w: 26, h: 262 }),
  Object.freeze({ key: 'blk-garden-mid', kind: 'block', x: 424, y: 520, w: 70, h: 70 }),
  Object.freeze({ key: 'wall-garden-s', kind: 'wall', x: 150, y: 790, w: 206, h: 26 }),
  Object.freeze({ key: 'wall-pav-w', kind: 'wall', x: 596, y: 506, w: 26, h: 188 }),
  Object.freeze({ key: 'blk-pav-nw', kind: 'block', x: 648, y: 336, w: 68, h: 68 }),
  Object.freeze({ key: 'blk-overlook-w', kind: 'block', x: 700, y: 958, w: 70, h: 70 }),
  Object.freeze({ key: 'wall-balc-w', kind: 'wall', x: 436, y: 930, w: 190, h: 24 }),
]);

const num = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);

/** Hash estable (FNV-1a) para variantes cosméticas deterministas. */
function hashKey(text) {
  let h = 2166136261;
  const s = String(text);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Construye el campo de batalla de un mapa para un mundo concreto.
 * Determinista: la misma (id, world, seed) devuelve siempre la misma geometría
 * (la semilla solo cambia los adornos cosméticos `variant`).
 * `orbit` devuelve la forma completa pero VACÍA: el backend conserva ahí el
 * reparto legacy (`coverLayout`) y el render no dibuja nada nuevo.
 */
export function buildBattlefield(id, world, seed = 1) {
  const map = sanitizeBattlefield(id) ?? 'orbit';
  const w = world && Number(world.w) > 0 && Number(world.h) > 0
    ? { w: Number(world.w), h: Number(world.h) }
    : { w: WORLD.w, h: WORLD.h };
  if (map === 'orbit') {
    return {
      id: 'orbit',
      covers: [],
      zones: [],
      pads: [],
      spawns: scaleSpawns(SPAWN_AREA, w),
    };
  }
  const k = Math.min(w.w / DESIGN.w, w.h / DESIGN.h);
  const ox = (w.w - DESIGN.w * k) / 2;
  const oy = (w.h - DESIGN.h * k) / 2;
  const s = (n) => n * k;

  const covers = [];
  let nextId = 1;
  for (const rect of CITADEL_WEST) {
    covers.push(makeCover(rect, rect.key, rect.key, nextId++, s, ox, oy, seed, 'w'));
  }
  for (const rect of CITADEL_WEST) {
    const key = `${rect.key}-e`;
    const mirrored = { ...rect, x: DESIGN.w - rect.x - rect.w };
    covers.push(makeCover(mirrored, key, rect.key, nextId++, s, ox, oy, seed, 'e'));
  }

  return {
    id: 'citadel',
    covers,
    zones: CITADEL_ZONES.map((z) => ({
      id: z.id,
      label: z.label,
      x: ox + s(z.x),
      y: oy + s(z.y),
      w: s(z.w),
      h: s(z.h),
    })),
    pads: CITADEL_PADS.map((p) => ({ id: p.id, x: ox + s(p.x), y: oy + s(p.y), type: p.type })),
    spawns: {
      cyan: { x: ox + s(CITADEL_SPAWNS.cyan.x), y: oy + s(CITADEL_SPAWNS.cyan.y) },
      coral: { x: ox + s(CITADEL_SPAWNS.coral.x), y: oy + s(CITADEL_SPAWNS.coral.y) },
    },
  };
}

function makeCover(rect, key, baseKey, id, s, ox, oy, seed, side) {
  const w = s(rect.w);
  const h = s(rect.h);
  // La variante se deriva de la clave BASE (sin sufijo de lado): las dos
  // mitades del mapa comparten adorno y la simetría visual es exacta.
  const variant = ((hashKey(baseKey) ^ (seed >>> 0)) >>> 0) % 4;
  return {
    id,
    key,
    kind: rect.kind,
    x: ox + s(rect.x) + w / 2,
    y: oy + s(rect.y) + h / 2,
    w,
    h,
    r: Math.hypot(w, h) / 2,
    hp: COVER_HP[rect.kind] ?? COVER_HP.block,
    maxHp: COVER_HP[rect.kind] ?? COVER_HP.block,
    variant,
    side,
  };
}

function scaleSpawns(base, w) {
  const out = {};
  for (const team of Object.keys(base ?? {})) {
    const b = base[team];
    out[team] = { x: (b.x / WORLD.w) * w.w, y: (b.y / WORLD.h) * w.h };
  }
  if (!out.cyan && !out.coral) {
    return { cyan: { x: w.w * 0.16, y: w.h * 0.5 }, coral: { x: w.w * 0.84, y: w.h * 0.5 } };
  }
  return out;
}

// ────────────────────────────────────────────────────────────────── colisión

/**
 * Contacto de un cuerpo circular (x,y,r) contra UNA cobertura, en el toro.
 * Devuelve null si no se tocan o {nx,ny,depth} con la normal unitaria que
 * empuja al cuerpo FUERA de la cobertura y la profundidad de penetración.
 * · cobertura legacy (sin w/h) → círculo de radio r
 * · cobertura con w/h > 0 → RECTÁNGULO axis-aligned
 * `c` puede ser además cualquier círculo suelto {x,y,r} (nubes de humo).
 */
export function coverContact(x, y, r, c, world = WORLD) {
  const w = world ?? WORLD;
  if (!c || typeof c !== 'object') return null;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(r) || r <= 0) return null;
  const cx = num(c.x, NaN);
  const cy = num(c.y, NaN);
  if (!Number.isFinite(cx) || !Number.isFinite(cy)) return null;
  const { dx, dy } = torusDelta(cx, cy, x, y, w);
  const cw = num(c.w, 0);
  const ch = num(c.h, 0);
  if (cw > 0 && ch > 0) return rectContact(dx, dy, r, cw, ch);
  const cr = Math.max(0, num(c.r, 0));
  if (cr <= 0) return null;
  const dist = Math.hypot(dx, dy);
  const sum = r + cr;
  if (!(dist < sum)) return null;
  if (dist < 1e-9) return { nx: 1, ny: 0, depth: sum };
  return { nx: dx / dist, ny: dy / dist, depth: sum - dist };
}

function rectContact(dx, dy, r, cw, ch) {
  const hw = cw / 2;
  const hh = ch / 2;
  if (Math.abs(dx) <= hw && Math.abs(dy) <= hh) {
    // Centro dentro del rectángulo: se sale por la cara más cercana.
    let depth = dx + hw;
    let nx = -1;
    let ny = 0;
    const right = hw - dx;
    if (right < depth) { depth = right; nx = 1; ny = 0; }
    const top = dy + hh;
    if (top < depth) { depth = top; nx = 0; ny = -1; }
    const bottom = hh - dy;
    if (bottom < depth) { depth = bottom; nx = 0; ny = 1; }
    return { nx, ny, depth: r + depth };
  }
  const qx = clamp(dx, -hw, hw);
  const qy = clamp(dy, -hh, hh);
  const ox = dx - qx;
  const oy = dy - qy;
  const dist = Math.hypot(ox, oy);
  if (!(dist < r)) return null;
  if (dist < 1e-9) return { nx: dx >= 0 ? 1 : -1, ny: 0, depth: r };
  return { nx: ox / dist, ny: oy / dist, depth: r - dist };
}

/** Resuelve los contactos de un cuerpo contra una lista de coberturas,
 *  devolviendo la posición corregida y el contacto más profundo. Atajo útil
 *  para la predicción del cliente; el servidor puede iterar con coverContact. */
export function resolveCoverContacts(x, y, r, covers, world = WORLD) {
  let px = x;
  let py = y;
  let deepest = null;
  let hits = 0;
  if (!Array.isArray(covers)) return { x: px, y: py, nx: 0, ny: 0, depth: 0, hits: 0 };
  for (const c of covers) {
    const hit = coverContact(px, py, r, c, world);
    if (!hit) continue;
    hits += 1;
    px += hit.nx * hit.depth;
    py += hit.ny * hit.depth;
    if (!deepest || hit.depth > deepest.depth) deepest = hit;
  }
  return {
    x: px,
    y: py,
    nx: deepest?.nx ?? 0,
    ny: deepest?.ny ?? 0,
    depth: deepest?.depth ?? 0,
    hits,
  };
}

/** ¿El punto (x,y) está dentro de una cobertura? (toro, círculo o rectángulo) */
export function pointInCover(x, y, c, world = WORLD) {
  return coverSurfaceDistance(x, y, c, world) < 0;
}

/**
 * Distancia de un punto a la SUPERFICIE de una cobertura en el toro:
 *   · ≥ 0 fuera (distancia libre), < 0 dentro (magnitud = penetración).
 * Círculo y rectángulo se miden por su forma real (nada de inflar un muro
 * delgado a un círculo). Es la métrica que usan el reparto de spawns, la
 * reserva de posiciones de colina y los tests de huecos.
 */
export function coverSurfaceDistance(x, y, c, world = WORLD) {
  const w = world ?? WORLD;
  if (!c || typeof c !== 'object') return Infinity;
  const cx = num(c.x, NaN);
  const cy = num(c.y, NaN);
  if (!Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(x) || !Number.isFinite(y)) return Infinity;
  const cw = num(c.w, 0);
  const ch = num(c.h, 0);
  if (cw > 0 && ch > 0) {
    const { dx, dy } = torusDelta(cx, cy, x, y, w);
    const inside = Math.abs(dx) <= cw / 2 && Math.abs(dy) <= ch / 2;
    const ox = Math.max(Math.abs(dx) - cw / 2, 0);
    const oy = Math.max(Math.abs(dy) - ch / 2, 0);
    const outside = Math.hypot(ox, oy);
    if (!inside) return outside;
    // Dentro: penetración hasta la cara más cercana.
    return -Math.min(cw / 2 - Math.abs(dx), ch / 2 - Math.abs(dy));
  }
  const cr = Math.max(0, num(c.r, 0));
  if (cr <= 0) return Infinity;
  return torusDistance(x, y, cx, cy, w) - cr;
}

/**
 * ¿El segmento A→B queda bloqueado por alguna cobertura? Usa el CAMINO CORTO
 * del toro (por eso también vale como línea de visión para explosiones y humo).
 * `covers` puede ser una lista mixta de círculos {x,y,r} (nubes, coberturas
 * legacy) y rectángulos {x,y,w,h}. Sin tunneling: el test es analítico, no por
 * muestreo. Segmentos de longitud cero se tratan como test de punto.
 */
export function segmentBlocked(ax, ay, bx, by, covers, world = WORLD) {
  const w = world ?? WORLD;
  if (!Array.isArray(covers) || covers.length === 0) return false;
  if (![ax, ay, bx, by].every((v) => Number.isFinite(v))) return false;
  const dx = wrapDelta(bx - ax, w.w);
  const dy = wrapDelta(by - ay, w.h);
  const len2 = dx * dx + dy * dy;

  if (len2 < 1e-12) {
    for (const c of covers) if (pointInCover(ax, ay, c, w)) return true;
    return false;
  }

  const midX = ax + dx / 2;
  const midY = ay + dy / 2;
  for (const c of covers) {
    if (!c || typeof c !== 'object') continue;
    const cx = num(c.x, NaN);
    const cy = num(c.y, NaN);
    if (!Number.isFinite(cx) || !Number.isFinite(cy)) continue;
    const cw = num(c.w, 0);
    const ch = num(c.h, 0);
    // Copia del toro más cercana al segmento (cubre el salto por el borde).
    const oi = Math.round((midX - cx) / w.w);
    const oj = Math.round((midY - cy) / w.h);
    const px = cx + oi * w.w;
    const py = cy + oj * w.h;
    if (cw > 0 && ch > 0) {
      if (segmentHitsRect(ax, ay, dx, dy, px - cw / 2, py - ch / 2, px + cw / 2, py + ch / 2)) return true;
      continue;
    }
    const cr = Math.max(0, num(c.r, 0));
    if (cr <= 0) continue;
    if (segmentHitsCircle(ax, ay, dx, dy, len2, px, py, cr)) return true;
  }
  return false;
}

function segmentHitsCircle(ax, ay, dx, dy, len2, cx, cy, cr) {
  let t = ((cx - ax) * dx + (cy - ay) * dy) / len2;
  t = clamp(t, 0, 1);
  const px = ax + dx * t - cx;
  const py = ay + dy * t - cy;
  return px * px + py * py <= cr * cr;
}

function segmentHitsRect(ax, ay, dx, dy, x0, y0, x1, y1) {
  let tmin = 0;
  let tmax = 1;
  const slab = (a, d, min, max) => {
    if (Math.abs(d) < 1e-12) return a >= min && a <= max;
    let t1 = (min - a) / d;
    let t2 = (max - a) / d;
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    return tmin <= tmax;
  };
  if (!slab(ax, dx, x0, x1)) return false;
  if (!slab(ay, dy, y0, y1)) return false;
  return true;
}

/**
 * Posiciones SEGURAS para la colina móvil (aditivo; no forma parte del
 * contrato fijo). Política de la Ciudadela: la colina PUEDE englobar
 * coberturas (es tácticamente deseable), pero su CENTRO debe quedar
 * transitable y accesible. Devuelve los mejores sitios de la arena, ordenados
 * por holgura y separados entre sí lo máximo posible (la separación se relaja
 * por tramos si la arena es pequeña):
 *   · candidatos: centro del mundo, centro de cada zona/plaza y una rejilla
 *     determinista de respaldo;
 *   · criterio: `coverSurfaceDistance ≥ opts.clearance`, por defecto
 *     `SHIP.radius + 12` (centro de colina transitable). Subirlo a
 *     `HILL.radius` exige la colina ENTERA libre de coberturas y a
 *     `HILL.radius + HILL.margin` además colchón.
 * El backend puede usarla como reserva para que la rotación de colina aterrice
 * siempre en un centro transitable; si la lista viene vacía no hay ningún sitio
 * limpio y el reparto normal (pickHillPosition) sigue siendo válido.
 */
export function battlefieldHillSpots(world = WORLD, opts = {}) {
  const w = world ?? WORLD;
  const fb = buildBattlefield(opts.battlefield ?? 'citadel', w, opts.seed ?? 1);
  const covers = Array.isArray(opts.covers) ? opts.covers : fb.covers;
  const bounds = hillBounds(w, HILL.radius);
  const clearance = opts.clearance ?? SHIP.radius + 12;
  const max = Math.max(0, opts.max ?? 6);
  const cols = Math.max(2, opts.cols ?? 24);
  const rows = Math.max(2, opts.rows ?? 16);
  const inBounds = (p) => p.x >= bounds.minX && p.x <= bounds.maxX && p.y >= bounds.minY && p.y <= bounds.maxY;

  const seeds = [{ x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 }];
  for (const z of fb.zones) seeds.push({ x: z.x + z.w / 2, y: z.y + z.h / 2 });
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      seeds.push({
        x: bounds.minX + ((bounds.maxX - bounds.minX) * i) / (cols - 1),
        y: bounds.minY + ((bounds.maxY - bounds.minY) * j) / (rows - 1),
      });
    }
  }

  const free = [];
  for (const p of seeds) {
    if (!inBounds(p)) continue;
    let slack = Infinity;
    for (const c of covers) {
      if (!c) continue;
      const d = coverSurfaceDistance(p.x, p.y, c, w);
      if (d < slack) slack = d;
    }
    if (slack < clearance) continue;
    if (free.some((q) => Math.abs(q.x - p.x) < 1e-6 && Math.abs(q.y - p.y) < 1e-6)) continue;
    free.push({ x: p.x, y: p.y, slack });
  }
  const center = { x: w.w / 2, y: w.h / 2 };
  const byQuality = (a, b) => {
    if (Math.abs(b.slack - a.slack) > 1e-9) return b.slack - a.slack;
    const da = torusDistance(a.x, a.y, center.x, center.y, w);
    const db = torusDistance(b.x, b.y, center.x, center.y, w);
    if (Math.abs(da - db) > 1e-9) return da - db;
    if (Math.abs(a.x - b.x) > 1e-9) return a.x - b.x;
    return a.y - b.y;
  };
  free.sort(byQuality);

  const base = opts.minDistance ?? hillMinDistance(w);
  const relaxations = [base, base * 0.6, HILL.radius * 2 + 40, HILL.radius + 40];
  let spots = [];
  for (const minDist of relaxations) {
    spots = [];
    for (const cand of free) {
      if (spots.length >= max) break;
      let ok = true;
      for (const s of spots) {
        if (torusDistance(cand.x, cand.y, s.x, s.y, w) < minDist) { ok = false; break; }
      }
      if (ok) spots.push({ x: cand.x, y: cand.y, slack: cand.slack });
    }
    if (spots.length >= 2 || minDist === relaxations[relaxations.length - 1]) break;
  }
  return spots.map((s) => ({ x: s.x, y: s.y, slack: s.slack }));
}
