// Orbit Hill Ciudadela — cascos vectoriales de los modelos cosméticos.
//
// Módulo de DIBUJO PURO: recibe un contexto 2D ya trasladado/rotado a la nave
// (espacio local, +x = morro) y pinta el casco del modelo pedido. No conoce el
// DOM, no guarda estado y no decide nada del juego: las estadísticas son
// idénticas en todos los modelos, solo cambia la silueta y los remates.
//
// Cada modelo tiene una firma visual clara incluso a escala reducida:
//   · viper       → dardo afilado con espina central y cola muescada
//   · bastion     → cuña ancha blindada con doble aro y hombreras
//   · spectre     → horquilla: dos púas delanteras y cola en delta
//   · alastar     → caza de cuatro alas con refuerzos en X
//   · interceptor → dardo angular con dos motores y travesaños
//   · arwing      → ala en flecha con espina larga y cola de lanza
//   · lobo        → alas en garra con costillas agresivas
//   · prism-wing  → lanza central, alas blancas barridas y módulos azules
//
// Todo dibujo abre y cierra su propio save()/restore() para que la pila del
// contexto compartido quede equilibrada.

import { SHIP } from '../../shared/constants.js';
import { SHIP_HULLS, sanitizeShipModel, shipHull } from '../../shared/ships.js';

const TAU = Math.PI * 2;

/** Remates cosméticos por modelo (nada de stats). */
export const MODEL_STYLE = Object.freeze({
  viper: Object.freeze({ spine: true, spineFront: 1.1, spineBack: -0.5, bolts: 3, ring: 1, mark: '#bff4ff', finSpan: 1 }),
  bastion: Object.freeze({ spine: false, bolts: 6, ring: 2, mark: '#ffd6a5', finSpan: 0.8 }),
  spectre: Object.freeze({ spine: true, spineFront: 0.2, spineBack: -0.3, bolts: 4, ring: 1, mark: '#c9b6ff', finSpan: 1.15 }),
  alastar: Object.freeze({
    spine: true, spineFront: 1.26, spineBack: -0.56, bolts: 5, ring: 1, mark: '#aee8ff', finSpan: 1.3,
    braces: Object.freeze([[-0.16, -0.5, 0.9, -0.92], [-0.16, 0.5, 0.9, 0.92]]),
  }),
  interceptor: Object.freeze({
    spine: true, spineFront: 0.96, spineBack: -0.64, bolts: 4, ring: 1, mark: '#ffb0a0', finSpan: 0.95,
    braces: Object.freeze([[-0.66, -0.42, 0.54, -0.28], [-0.66, 0.42, 0.54, 0.28]]),
  }),
  arwing: Object.freeze({
    spine: true, spineFront: 1.28, spineBack: -0.48, bolts: 5, ring: 1, mark: '#9ff7e8', finSpan: 1.2,
    braces: Object.freeze([[0.34, -0.38, -0.24, -1.06], [0.34, 0.38, -0.24, 1.06]]),
  }),
  lobo: Object.freeze({
    spine: true, spineFront: 1.22, spineBack: -0.7, bolts: 6, ring: 1, mark: '#ffc48f', finSpan: 1.2,
    braces: Object.freeze([[0.26, -0.4, 0.82, -0.9], [0.26, 0.4, 0.82, 0.9], [-0.7, -0.3, -0.18, -0.18], [-0.7, 0.3, -0.18, 0.18]]),
  }),
  // Homenaje original: alas blancas de gran envergadura, paneles azules
  // laterales y cabina oscura. No usa texturas, imágenes ni marcas externas.
  'prism-wing': Object.freeze({
    spine: true, spineFront: 1.88, spineBack: -1.14, bolts: 6, ring: 1, mark: '#e8f7ff', finSpan: 1.25,
    palette: Object.freeze({
      wing: '#f4f9ff',
      wingEdge: '#ffffff',
      module: '#2f9dff',
      moduleEdge: '#bfe9ff',
      cockpit: '#07131f',
      cockpitRim: '#8fd8ff',
    }),
    wings: Object.freeze([
      Object.freeze([[0.54, -0.42], [0.16, -1.14], [-0.38, -1.44], [-0.84, -1.16], [-0.62, -0.52], [0.12, -0.34]]),
      Object.freeze([[0.54, 0.42], [0.16, 1.14], [-0.38, 1.44], [-0.84, 1.16], [-0.62, 0.52], [0.12, 0.34]]),
    ]),
    modules: Object.freeze([
      Object.freeze([[-0.04, -0.9], [0.28, -0.94], [0.12, -1.3], [-0.22, -1.2]]),
      Object.freeze([[-0.04, 0.9], [0.28, 0.94], [0.12, 1.3], [-0.22, 1.2]]),
    ]),
  }),
});

function hexA(hex, alpha) {
  if (typeof hex !== 'string' || !hex.startsWith('#')) return `rgba(255, 255, 255, ${alpha})`;
  const v = hex.length === 4
    ? hex.slice(1).split('').map((c) => c + c).join('')
    : hex.slice(1);
  const n = Number.parseInt(v, 16);
  if (!Number.isFinite(n)) return `rgba(255, 255, 255, ${alpha})`;
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/** Traza un polígono cosmético local (paneles de ala, módulos) sin fill. */
function traceLocalPolygon(ctx, points, radius) {
  ctx.beginPath();
  for (let i = 0; i < points.length; i++) {
    const [x, y] = points[i];
    if (i === 0) ctx.moveTo(x * radius, y * radius);
    else ctx.lineTo(x * radius, y * radius);
  }
  ctx.closePath();
}

/** Puntos del casco en unidades de mundo (radius = SHIP.radius). */
export function hullPoints(model, radius = SHIP.radius) {
  const { hull } = shipHull(model);
  return hull.map(([x, y]) => [x * radius, y * radius]);
}

/** Traza la silueta del modelo en el contexto (path abierto, sin fill). */
export function hullPath(ctx, model, radius = SHIP.radius) {
  const pts = hullPoints(model, radius);
  ctx.beginPath();
  for (let i = 0; i < pts.length; i++) {
    if (i === 0) ctx.moveTo(pts[i][0], pts[i][1]);
    else ctx.lineTo(pts[i][0], pts[i][1]);
  }
  ctx.closePath();
  return pts;
}

/**
 * Casco completo: relleno translúcido, borde con resplandor, remates propios
 * del modelo (espina/aros/hombreras), remaches y cabina.
 * `opts`: { color, isSelf, radius, time }.
 */
export function drawShipHull(ctx, model, opts = {}) {
  const id = sanitizeShipModel(model) ?? 'viper';
  const spec = SHIP_HULLS[id];
  const style = MODEL_STYLE[id];
  const color = opts.color ?? '#9fc4ff';
  const isSelf = opts.isSelf === true;
  const radius = Math.max(4, Number.isFinite(opts.radius) ? Number(opts.radius) : SHIP.radius);
  const time = Number.isFinite(opts.time) ? Number(opts.time) : 0;

  ctx.save();
  hullPath(ctx, id, radius);
  ctx.fillStyle = hexA(color, 0.14);
  ctx.fill();
  ctx.strokeStyle = isSelf ? '#ffffff' : color;
  ctx.lineWidth = isSelf ? 2.4 : 2;
  ctx.shadowColor = color;
  ctx.shadowBlur = isSelf ? 20 : 13;
  ctx.stroke();
  ctx.shadowBlur = 0;

  // Paneles cosméticos propios (Prisma Alada): alas blancas y módulos azules.
  const palette = style.palette ?? null;
  if (Array.isArray(style.wings)) {
    for (const wing of style.wings) {
      traceLocalPolygon(ctx, wing, radius);
      ctx.fillStyle = hexA(palette?.wing ?? style.mark, 0.34);
      ctx.fill();
      ctx.strokeStyle = hexA(palette?.wingEdge ?? style.mark, 0.82);
      ctx.lineWidth = Math.max(0.8, radius * 0.06);
      ctx.stroke();
    }
  }
  if (Array.isArray(style.modules)) {
    ctx.save();
    ctx.shadowColor = palette?.module ?? color;
    ctx.shadowBlur = radius * 0.42;
    for (const module of style.modules) {
      traceLocalPolygon(ctx, module, radius);
      ctx.fillStyle = hexA(palette?.module ?? color, 0.92);
      ctx.fill();
      ctx.strokeStyle = hexA(palette?.moduleEdge ?? '#ffffff', 0.9);
      ctx.lineWidth = Math.max(0.7, radius * 0.055);
      ctx.stroke();
    }
    ctx.restore();
  }

  // Remates internos: cada modelo deja una firma distinta en el casco.
  ctx.lineJoin = 'round';
  if (style.spine) {
    // Espina central: del morro a la cola.
    ctx.strokeStyle = hexA(style.mark, 0.6);
    ctx.lineWidth = Math.max(0.9, radius * 0.09);
    ctx.beginPath();
    ctx.moveTo(radius * style.spineFront, 0);
    ctx.lineTo(radius * style.spineBack, 0);
    ctx.stroke();
  } else {
    // Bastión: travesaños de blindaje.
    ctx.strokeStyle = hexA(style.mark, 0.55);
    ctx.lineWidth = Math.max(0.9, radius * 0.08);
    ctx.beginPath();
    for (const fx of [0.55, 0.0, -0.45]) {
      ctx.moveTo(radius * fx, -radius * 0.62);
      ctx.lineTo(radius * fx, radius * 0.62);
    }
    ctx.stroke();
  }
  // Costillas propias de los cascos nuevos: refuerzos de ala o motores.
  if (Array.isArray(style.braces)) {
    ctx.strokeStyle = hexA(style.mark, 0.5);
    ctx.lineWidth = Math.max(0.7, radius * 0.055);
    for (const [x0, y0, x1, y1] of style.braces) {
      ctx.beginPath();
      ctx.moveTo(x0 * radius, y0 * radius);
      ctx.lineTo(x1 * radius, y1 * radius);
      ctx.stroke();
    }
  }
  for (let i = 0; i < spec.rings.length; i++) {
    const ring = spec.rings[i];
    ctx.strokeStyle = hexA(style.mark, 0.3 + 0.12 * Math.sin(time * 1.3 + i));
    ctx.lineWidth = Math.max(0.7, radius * 0.06);
    ctx.beginPath();
    ctx.arc(radius * ring.x, 0, Math.max(1, radius * ring.r * 0.6), 0, TAU);
    ctx.stroke();
  }

  // Aletas traseras (hombreras): pequeñas y siempre dentro del casco.
  ctx.strokeStyle = hexA(color, 0.7);
  ctx.lineWidth = Math.max(0.9, radius * 0.1);
  for (const [[x0, y0], [x1, y1]] of spec.fin) {
    ctx.beginPath();
    ctx.moveTo(x0 * radius, y0 * radius);
    ctx.lineTo(x1 * radius, y1 * radius);
    ctx.stroke();
  }

  // Remaches deterministas por modelo.
  const pts = hullPoints(id, radius);
  ctx.fillStyle = hexA(style.mark, 0.75);
  for (let i = 0; i < style.bolts; i++) {
    const t = style.bolts > 1 ? i / (style.bolts - 1) : 0.5;
    const [px, py] = pts[Math.floor(t * (pts.length - 1))];
    ctx.beginPath();
    ctx.arc(px * 0.82, py * 0.82, Math.max(0.7, radius * 0.055), 0, TAU);
    ctx.fill();
  }

  // Cabina: mismo lenguaje en todos los modelos, tamaño propio.
  ctx.beginPath();
  ctx.arc(radius * spec.cockpit[0], 0, Math.max(1.6, radius * spec.cockpit[2]), 0, TAU);
  ctx.fillStyle = palette?.cockpit ?? color;
  ctx.fill();
  if (palette?.cockpitRim) {
    ctx.strokeStyle = hexA(palette.cockpitRim, 0.85);
    ctx.lineWidth = Math.max(0.9, radius * 0.055);
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * Estela de propulsión continua (local, ya trasladado y rotado). Se dibuja
 * ANTES del casco. `opts`: { color, boosting }.
 */
export function drawHullThruster(ctx, model, opts = {}) {
  const id = sanitizeShipModel(model) ?? 'viper';
  const spec = SHIP_HULLS[id];
  const radius = Math.max(4, Number.isFinite(opts.radius) ? Number(opts.radius) : SHIP.radius);
  const color = opts.color ?? '#9fc4ff';
  const boosting = opts.boosting === true;
  const jitter = typeof opts.random === 'function' ? opts.random() : Math.random();
  const len = (boosting ? radius * 2 : radius * 1.15) * (0.75 + jitter * 0.5);
  const thrusters = Array.isArray(spec.thrusters) && spec.thrusters.length ? spec.thrusters : [spec.thruster];

  ctx.save();
  for (const thruster of thrusters) {
    const x0 = radius * thruster.x;
    const y0 = radius * (thruster.y ?? 0);
    const half = radius * thruster.half;
    const g = ctx.createLinearGradient(x0, y0, x0 - len, y0);
    g.addColorStop(0, boosting ? 'rgba(255, 255, 255, 0.85)' : hexA(color, 0.7));
    g.addColorStop(1, 'rgba(255, 255, 255, 0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(x0, y0 - half);
    ctx.lineTo(x0 - len, y0);
    ctx.lineTo(x0, y0 + half);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

/**
 * Casco averiado de una nave derribada (local, ya trasladado y rotado):
 * silueta del modelo con relleno apagado y fractura discontinua.
 * Devuelve el trazo para que quien llame añada encima chispas o detalles.
 */
export function drawWreckHull(ctx, model, opts = {}) {
  const id = sanitizeShipModel(model) ?? 'viper';
  const radius = Math.max(4, Number.isFinite(opts.radius) ? Number(opts.radius) : SHIP.radius);
  const color = opts.color ?? '#9fc4ff';
  const hullFill = opts.fill ?? 'rgba(26, 34, 46, 0.94)';
  const fracture = opts.fracture ?? '#ffd166';

  ctx.save();
  hullPath(ctx, id, radius);
  ctx.fillStyle = hullFill;
  ctx.fill();
  ctx.strokeStyle = hexA(color, 0.45);
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.setLineDash([radius * 0.22, radius * 0.18]);
  ctx.strokeStyle = hexA(fracture, 0.75);
  ctx.lineWidth = 1.4;
  hullPath(ctx, id, radius);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
  return id;
}

/** Etiqueta corta para chips de UI ('DARDO', 'BLINDADO', 'HORQUILLA'…). */
export function modelTag(model) {
  switch (sanitizeShipModel(model) ?? 'viper') {
    case 'bastion': return 'BLINDADO';
    case 'spectre': return 'HORQUILLA';
    case 'alastar': return 'ALA';
    case 'interceptor': return 'GEMELO';
    case 'arwing': return 'CAZADOR';
    case 'lobo': return 'LOBO';
    case 'prism-wing': return 'PRISMA';
    default: return 'DARDO';
  }
}
