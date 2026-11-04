// Orbit Hill — cámara local. Nunca modifica posiciones ni reglas del servidor.
//
// Dos modos, independientes del input (teclado, mando o táctil):
//   · 'overview' → toda la arena entra en pantalla (escritorio por defecto).
//   · 'follow'   → seguimiento suave con zoom (.55/.72/1/1.25) y minimapa.
//
// El mundo y la colina llegan del servidor (fuente de verdad) y se pasan
// siempre como datos: este módulo no conoce WORLD/HILL ni muta constantes.
// Los insets (notch/isla dinámica de iPhone) entran como `inset` para que ni la
// nave ni el minimapa queden bajo el recorte.

import { DEFAULT_ZOOM, normalizeZoom } from './camera-options.js';

/**
 * Zoom por defecto del seguimiento (= .72): mantiene la nave legible como el
 * mínimo clásico de móvil. Es la escala CSS absoluta, no un multiplicador.
 */
export const MIN_FOLLOW_SCALE = DEFAULT_ZOOM;

export const ZERO_INSET = Object.freeze({ top: 0, right: 0, bottom: 0, left: 0 });

const insetOf = (inset) => {
  if (!inset) return ZERO_INSET;
  return {
    top: Number(inset.top) || 0,
    right: Number(inset.right) || 0,
    bottom: Number(inset.bottom) || 0,
    left: Number(inset.left) || 0,
  };
};

const safeWorld = (world) => ({
  w: Number(world?.w) > 0 ? Number(world.w) : 1,
  h: Number(world?.h) > 0 ? Number(world.h) : 1,
});

/** Distancia firmada más corta entre dos coordenadas en un eje toroidal. */
export function wrappedDelta(from, to, size) {
  return ((to - from + size / 2) % size + size) % size - size / 2;
}

/** Centro del área segura: la nave se ancla aquí, lejos del notch. */
function anchor(lo, hi) {
  return lo + (hi - lo) / 2;
}

/**
 * Escala mínima para no repetir el mundo: cubre el viewport en ambos ejes.
 * Con ella el mundo se dibuja una sola vez por eje y no aparecen naves duplicadas.
 */
export function coverScale(width, height, world) {
  const w = safeWorld(world);
  return Math.max(width / w.w, height / w.h);
}

/** Copias del mundo necesarias para cubrir el viewport (torus). */
export function tilesFor(bounds, world) {
  const w = safeWorld(world);
  const tiles = [];
  for (let tx = Math.floor(bounds.left / w.w); tx < Math.ceil(bounds.right / w.w); tx++) {
    for (let ty = Math.floor(bounds.top / w.h); ty < Math.ceil(bounds.bottom / w.h); ty++) {
      tiles.push({ x: tx * w.w, y: ty * w.h });
    }
  }
  return tiles.length ? tiles : [{ x: 0, y: 0 }];
}

function boundsOf(width, height, scale, x, y) {
  return {
    left: -x / scale,
    right: (width - x) / scale,
    top: -y / scale,
    bottom: (height - y) / scale,
  };
}

/** Cámara de arena completa: encaja el mundo entero dentro del área segura. */
export function overviewView(width, height, world, options = {}) {
  const w = safeWorld(world);
  const inset = insetOf(options.inset);
  const availW = Math.max(1, width - inset.left - inset.right);
  const availH = Math.max(1, height - inset.top - inset.bottom);
  const scale = Math.min(availW / w.w, availH / w.h);
  const x = inset.left + (availW - w.w * scale) / 2;
  const y = inset.top + (availH - w.h * scale) / 2;
  return {
    mode: 'overview',
    width,
    height,
    scale,
    x,
    y,
    anchorX: width / 2,
    anchorY: height / 2,
    inset,
    bounds: { left: 0, right: w.w, top: 0, bottom: w.h },
    tiles: [{ x: 0, y: 0 }],
  };
}

/**
 * Seguimiento toroidal. El zoom es la escala CSS deseada y absoluta
 * (.55/.72/1/1.25); solo se sube al mínimo que cubre la pantalla para no
 * dibujar varias copias de la misma nave. La nave queda anclada en el centro
 * del área segura y el mundo se repite alrededor.
 */
export function followView(width, height, center, world, options = {}) {
  const w = safeWorld(world);
  const inset = insetOf(options.inset);
  const scale = Math.max(normalizeZoom(options.zoom ?? DEFAULT_ZOOM), coverScale(width, height, world));
  const target = { x: Number(center?.x) || 0, y: Number(center?.y) || 0 };
  const anchorX = anchor(inset.left, width - inset.right);
  const anchorY = anchor(inset.top, height - inset.bottom);
  const x = anchorX - target.x * scale;
  const y = anchorY - target.y * scale;
  const bounds = boundsOf(width, height, scale, x, y);
  return {
    mode: 'follow',
    width,
    height,
    scale,
    x,
    y,
    anchorX,
    anchorY,
    inset,
    bounds,
    tiles: tilesFor(bounds, w),
  };
}

/** Compatibilidad: la cámara móvil clásica es el seguimiento con el zoom por defecto. */
export function mobileCamera(width, height, center, world) {
  return followView(width, height, center, world, { zoom: DEFAULT_ZOOM });
}

export function cameraView(config = {}) {
  const { width = 1, height = 1, world, mode = 'overview', zoom = DEFAULT_ZOOM, center, inset } = config;
  if (mode === 'follow') {
    const w = safeWorld(world);
    return followView(width, height, center ?? { x: w.w / 2, y: w.h / 2 }, world, { zoom, inset });
  }
  return overviewView(width, height, world, { inset });
}

/**
 * Seguimiento suave del centro de cámara por el camino corto del torus.
 * `snap` recentra de inmediato (respawn o cambio de mundo) sin interpolar.
 */
export function followCamera(previous, target, world, dt, snap = false) {
  const w = safeWorld(world);
  if (!previous || snap) return { x: target.x, y: target.y };
  const blend = 1 - Math.exp(-12 * Math.max(0, Math.min(dt, 0.1)));
  return {
    x: ((previous.x + wrappedDelta(previous.x, target.x, w.w) * blend) % w.w + w.w) % w.w,
    y: ((previous.y + wrappedDelta(previous.y, target.y, w.h) * blend) % w.h + w.h) % w.h,
  };
}

/** Copia del mundo que contiene (o está más cerca de) el centro de la vista. */
export function nearestTile(camera, world) {
  const w = safeWorld(world);
  const tiles = camera?.tiles?.length ? camera.tiles : [{ x: 0, y: 0 }];
  if (tiles.length === 1) return tiles[0];
  const cx = camera.x + ((camera.bounds.left + camera.bounds.right) / 2) * camera.scale;
  const cy = camera.y + ((camera.bounds.top + camera.bounds.bottom) / 2) * camera.scale;
  let best = tiles[0];
  let bestD = Infinity;
  for (const tile of tiles) {
    const px = camera.x + (tile.x + w.w / 2) * camera.scale;
    const py = camera.y + (tile.y + w.h / 2) * camera.scale;
    const d = Math.hypot(px - cx, py - cy);
    if (d < bestD) {
      bestD = d;
      best = tile;
    }
  }
  return best;
}

/** Centro real de la vista en coordenadas del mundo (bounds.mid). */
export function viewCenter(camera) {
  return {
    x: (camera.bounds.left + camera.bounds.right) / 2,
    y: (camera.bounds.top + camera.bounds.bottom) / 2,
  };
}

/**
 * Proyecta un punto del mundo a pantalla eligiendo, POR EJE, la copia más
 * cercana al centro real de la vista (camino corto del torus). Así el puntero y
 * el minimapa son correctos aunque la cámara esté junto al borde (x≈1798).
 */
export function screenPoint(camera, world, x, y) {
  const w = safeWorld(world);
  const center = viewCenter(camera);
  return {
    x: camera.x + (center.x + wrappedDelta(center.x, x, w.w)) * camera.scale,
    y: camera.y + (center.y + wrappedDelta(center.y, y, w.h)) * camera.scale,
  };
}

/** Punto del mundo inmediatamente debajo de una coordenada de pantalla. */
export function worldPoint(camera, world, sx, sy) {
  const w = safeWorld(world);
  const x = ((sx - camera.x) / camera.scale) % w.w;
  const y = ((sy - camera.y) / camera.scale) % w.h;
  return { x: ((x % w.w) + w.w) % w.w, y: ((y % w.h) + w.h) % w.h };
}

/**
 * Puntero de borde: si el objetivo está fuera de pantalla devuelve el punto
 * recortado al área segura y su ángulo; si está dentro, su posición exacta.
 * Sirve igual para la colina y para el aviso de próxima colina (torus corto).
 */
export function edgePointer(camera, world, x, y, margin = 42, inset = ZERO_INSET) {
  const pad = insetOf(inset);
  const point = screenPoint(camera, world, x, y);
  const left = pad.left + margin;
  const right = camera.width - pad.right - margin;
  const top = pad.top + margin;
  const bottom = camera.height - pad.bottom - margin;
  if (point.x >= left && point.x <= right && point.y >= top && point.y <= bottom) {
    return { beyond: false, x: point.x, y: point.y, angle: 0, distance: 0 };
  }
  const cx = (left + right) / 2;
  const cy = (top + bottom) / 2;
  const angle = Math.atan2(point.y - cy, point.x - cx);
  return {
    beyond: true,
    x: Math.min(right, Math.max(left, point.x)),
    y: Math.min(bottom, Math.max(top, point.y)),
    angle,
    distance: Math.hypot(point.x - cx, point.y - cy),
  };
}
