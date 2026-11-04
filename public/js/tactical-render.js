// Orbit Hill Tactical — capa visual del prototipo táctico.
//
// Este módulo es PURAMENTE de dibujo: no conoce el DOM y no guarda estado
// propio (salvo cachés derivadas de los datos: grietas y gradientes de losa).
// Solo importa el contrato compartido y la geometría de los cascos. Recibe el
// contexto 2D ya transformado a unidades de mundo (el pipeline toroidal de
// tiles lo aplica render.js) y pinta:
//
//   · coberturas estáticas destruibles — placas hexagonales metálicas oscuras
//     con juntas cian/ámbar tenues, grietas por daño y barra discreta de vida;
//   · naves derribadas — casco averiado con rotación lenta, pulso SOS, cruz de
//     rescate, temporizador/sangrado y progreso de rescate;
//   · perdigones de plasma — brillo naranja tenue con rastro corto.
//
// Los valores (escopeta, esquiva, coberturas, derribo) NO se duplican: este
// módulo importa el contrato compartido y lo reexporta como TACTICAL_FALLBACK
// para quien lo necesite.
//
// Todo dibujo abre y cierra su propio save()/restore() (pila equilibrada): el
// renderer comparte contexto entre coberturas, naves y balas en cada tile.

// Los valores (escopeta, esquiva, coberturas, derribo) vienen del contrato
// compartido; la ruta relativa resuelve igual en el navegador (el servidor la
// normaliza a /shared/tactical.js) y en Node, así que este módulo se puede
// probar directamente con un contexto 2D falso.

import { TACTICAL } from '../../shared/tactical.js';
// La silueta del casco derribado es la del MODELO real de la nave (todo el
// catálogo de shared/ships.js), así que la geometría vive en un único sitio.
import { hullPath } from './ship-models.js';

const TAU = Math.PI * 2;

/** Alias histórico del contrato compartido (nunca una copia). */
export const TACTICAL_FALLBACK = TACTICAL;

/** Paleta propia del prototipo (ni asteroides ni naves comparten estos tonos). */
export const TACTICAL_STYLE = Object.freeze({
  plateTop: '#26364a',
  plateMid: '#151f2b',
  plateDeep: '#090f16',
  rim: 'rgba(168, 190, 214, 0.85)',
  seam: 'rgba(118, 148, 178, 0.55)',
  cyan: '#7fe9ff',
  amber: '#ffc473',
  coral: '#ff8a5c',
  sos: '#ffd166',
  revive: '#7ef7c8',
  plasma: '#ffa552',
  plasmaCore: '#fff4e0',
  minimapCover: 'rgba(150, 175, 205, 0.55)',
  downedHull: 'rgba(26, 34, 46, 0.94)',
});

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const num = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);

function hexA(hex, alpha) {
  if (typeof hex !== 'string') return `rgba(255, 255, 255, ${alpha})`;
  if (hex.startsWith('rgba') || hex.startsWith('rgb')) return hex;
  const v = hex.replace('#', '');
  const bigint = parseInt(v.length === 3 ? v.split('').map((c) => c + c).join('') : v, 16);
  if (!Number.isFinite(bigint)) return `rgba(255, 255, 255, ${alpha})`;
  return `rgba(${(bigint >> 16) & 255}, ${(bigint >> 8) & 255}, ${bigint & 255}, ${alpha})`;
}

/** Texto medido sin exigir measureText (stubs de test). */
function textWidth(ctx, text) {
  if (typeof ctx?.measureText === 'function') {
    try {
      const m = ctx.measureText(text);
      if (m && Number.isFinite(m.width)) return m.width;
    } catch {
      /* stub sin medida real: se usa la estimación */
    }
  }
  return String(text).length * 6;
}

function roundRectPath(ctx, x, y, w, h, r) {
  const radius = Math.max(0, Math.min(r, Math.min(w, h) / 2));
  if (typeof ctx.roundRect === 'function') {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, radius);
    return;
  }
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.lineTo(x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.lineTo(x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.lineTo(x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.closePath();
}

function hexPath(ctx, r, rotation = 0) {
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = rotation + (i / 6) * TAU - Math.PI / 2;
    const x = Math.cos(a) * r;
    const y = Math.sin(a) * r;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

/** Ruido determinista por id: las grietas no cambian de frame a frame. */
function rngFromId(id) {
  const s = String(id ?? '');
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let state = h >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/** Panel redondeado reutilizable (chips de arma, barras, avisos). */
export { roundRectPath as panelPath };

/**
 * Gradiente de la placa metálica, cacheado por contexto y radio.
 * El gradiente se define en coordenadas locales (la cobertura se traslada a su
 * centro antes de pintar), así que se puede reutilizar en todas las copias
 * toroidales sin crear uno por cobertura y por frame. `WeakMap` por contexto:
 * un canvas nuevo estrena su propia caché y no se comparten objetos entre
 * contextos distintos.
 */
const plateCache = new WeakMap();

function plateGradient(ctx, r) {
  let perCtx = plateCache.get(ctx);
  if (!perCtx) {
    perCtx = new Map();
    plateCache.set(ctx, perCtx);
  }
  const key = Math.round(r * 2) / 2;
  const cached = perCtx.get(key);
  if (cached) return cached;
  const grad = ctx.createRadialGradient(-r * 0.35, -r * 0.4, r * 0.12, 0, 0, r * 1.05);
  grad.addColorStop(0, TACTICAL_STYLE.plateTop);
  grad.addColorStop(0.55, TACTICAL_STYLE.plateMid);
  grad.addColorStop(1, TACTICAL_STYLE.plateDeep);
  perCtx.set(key, grad);
  return grad;
}

// ─────────────────────────────────────────────────────────── contrato de vista

/**
 * `tac.on` es la única fuente de verdad: el renderer NUNCA deduce el perfil
 * táctico del modo. Sin bandera explícita no se pinta nada táctico.
 */
export function tacticalOn(view) {
  const t = view?.tactical;
  return t === true || t?.on === true;
}

/** Arma absoluta del jugador; cualquier valor raro cae en 'auto'. */
export function weaponOf(p) {
  return p?.weapon === 'plasma' ? 'plasma' : 'auto';
}

/** Armas del contrato v2: SIEMPRE disponibles auto/plasma; con munición
 *  sniper/boomer (solo se pueden pedir si quedan balas). */
export const WEAPON_KINDS = Object.freeze(['auto', 'plasma', 'sniper', 'boomer']);

/** Tipo de arma normalizado de un jugador (nunca null). */
export function weaponKind(p) {
  const w = p?.weapon;
  return w === 'plasma' || w === 'sniper' || w === 'boomer' ? w : 'auto';
}

/** Estilo del chip de arma: etiqueta corta y color por tipo. */
export const WEAPON_STYLE = Object.freeze({
  auto: Object.freeze({ label: 'AUTO', accent: 'rgba(160, 190, 220, 0.9)' }),
  plasma: Object.freeze({ label: 'PLASMA', accent: TACTICAL_STYLE.plasma }),
  sniper: Object.freeze({ label: 'SNIPER', accent: '#b18cff' }),
  boomer: Object.freeze({ label: 'BOOM', accent: '#ffa552' }),
});

/** ¿La nave está derribada y por tanto es rescatable? */
export function isDowned(p) {
  return p?.downed === true;
}

/**
 * Estado táctico normalizado de un jugador. `downed` puede venir sin
 * `downedRemaining`; en ese caso se asume el total del contrato para que la
 * interfaz de rescate siga siendo legible.
 */
export function tacticalPlayer(p, fb = TACTICAL_FALLBACK) {
  const downed = isDowned(p);
  const hasRemaining = Number.isFinite(Number(p?.downedRemaining));
  const remaining = downed
    ? (hasRemaining ? Math.max(0, Number(p.downedRemaining)) : fb.downed.seconds)
    : 0;
  return {
    weapon: weaponOf(p),
    kind: weaponKind(p),
    dashCd: Math.max(0, num(p?.dashCd, 0)),
    downed,
    downedRemaining: remaining,
    // `downedRemaining > 0` distingue derribado de muerto definitivo.
    revivable: downed && remaining > 0,
    reviveProgress: clamp01(num(p?.reviveProgress, 0)),
    downedHp: Math.max(0, num(p?.downedHp, downed ? fb.downed.hp : 0)),
    // Campos nuevos del contrato v2 (aditivos, con respaldo neutro).
    model: typeof p?.model === 'string' ? p.model : null,
    aiming: p?.aiming === true,
    ammoSniper: Math.max(0, num(p?.ammoSniper, 0)),
    ammoBoomer: Math.max(0, num(p?.ammoBoomer, 0)),
    smokeAmmo: Math.max(0, num(p?.smokeAmmo, 0)),
    bounceCd: Math.max(0, num(p?.bounceCd, 0)),
    aimCharge: clamp01(num(p?.aimCharge, 0)),
  };
}

/**
 * Etiqueta de la nave derribada. Reutiliza la insignia de reaparición si está
 * activa y, si no, la plaza estable (1P, 2P…). La propia lleva "TÚ".
 */
export function downedBadgeLabel(p, isSelf, badge) {
  const label = badge?.label ?? p?.badge?.label;
  if (label) return label;
  if (Number.isInteger(p?.slot) && p.slot >= 1) return isSelf ? `${p.slot}P · TÚ` : `${p.slot}P`;
  if (isSelf) return 'TÚ';
  return p?.name ? String(p.name) : '';
}

/** Coberturas: normaliza una fila del servidor. Devuelve null si es inválida.
 *  Acepta objetos `{id,x,y,r,hp,maxHp,w,h,kind}` y las filas del snapshot
 *  `[id,x,y,r,hp,maxHp,w,h,kind]`. Con `w` y `h` > 0 la cobertura es un
 *  RECTÁNGULO axis-aligned; sin ellos se conserva la placa hexagonal clásica. */
export function normalizeCover(raw, index = 0, fb = TACTICAL_FALLBACK) {
  if (!raw || typeof raw !== 'object') return null;
  const src = Array.isArray(raw)
    ? { id: raw[0], x: raw[1], y: raw[2], r: raw[3], hp: raw[4], maxHp: raw[5], w: raw[6], h: raw[7], kind: raw[8] }
    : raw;
  const x = num(src.x, NaN);
  const y = num(src.y, NaN);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const maxHp = Math.max(1, num(src.maxHp, fb.cover.hp));
  const hp = Math.min(maxHp, Math.max(0, num(src.hp, maxHp)));
  // Destruida: el servidor ya no la manda, pero si llega hp 0 no se pinta un
  // bloque fantasma que confunda sobre qué frena balas.
  if (!(hp > 0)) return null;
  const w = num(src.w, 0);
  const h = num(src.h, 0);
  const rect = w > 0 && h > 0;
  const out = {
    id: src.id === undefined || src.id === null ? `c${index}` : src.id,
    x,
    y,
    r: Math.max(6, num(src.r, rect ? Math.hypot(w, h) / 2 : fb.cover.radius)),
    hp,
    maxHp,
  };
  // Campos nuevos SOLO cuando la cobertura los necesita: las placas legacy de
  // 6 campos se normalizan exactamente igual que antes.
  if (rect) {
    out.w = w;
    out.h = h;
    out.r = Math.max(1, out.r);
    out.kind = src.kind === 'wall' ? 'wall' : 'block';
    out.variant = Number.isInteger(src.variant) ? ((src.variant % 4) + 4) % 4 : 0;
  } else if (src.kind !== undefined && src.kind !== null) {
    out.kind = src.kind === 'hex' ? 'hex' : String(src.kind);
  }
  return out;
}

/** Lista normalizada de `view.covers` (siempre array, nunca lanza). */
export function collectCovers(view, fb = TACTICAL_FALLBACK) {
  return normalizeCovers(view, fb);
}

/**
 * Normaliza una vista ({covers:[…]}) o una lista ya normalizada. Las filas que
 * ya traen radio y máximo numéricos se reutilizan tal cual (una sola pasada por
 * frame); el resto se sanea. Las coberturas destruidas se descartan siempre.
 */
function normalizeCovers(source, fb = TACTICAL_FALLBACK) {
  const raw = Array.isArray(source) ? source : Array.isArray(source?.covers) ? source.covers : [];
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (!item || typeof item !== 'object') continue;
    const ready = Number.isFinite(item.r) && Number.isFinite(item.maxHp);
    const cover = ready ? item : normalizeCover(item, i, fb);
    if (cover && cover.hp > 0) out.push(cover);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────── coberturas

/**
 * Gradiente de losa de los muros/bloques de la Ciudadela, cacheado por contexto
 * y tamaño redondeado. Igual que las placas hexagonales: un solo objeto de
 * gradiente para todas las coberturas del mismo tamaño y todas las copias
 * toroidales del frame.
 */
const slabCache = new WeakMap();

function slabGradient(ctx, w, h, kind) {
  let perCtx = slabCache.get(ctx);
  if (!perCtx) {
    perCtx = new Map();
    slabCache.set(ctx, perCtx);
  }
  const key = `${kind}:${Math.round(w / 4)}x${Math.round(h / 4)}`;
  const cached = perCtx.get(key);
  if (cached) return cached;
  const grad = ctx.createLinearGradient(0, -h / 2, 0, h / 2);
  if (kind === 'wall') {
    grad.addColorStop(0, '#33465e');
    grad.addColorStop(0.45, '#1b2635');
    grad.addColorStop(1, '#0b111a');
  } else {
    grad.addColorStop(0, '#2f343d');
    grad.addColorStop(0.5, '#1b1f26');
    grad.addColorStop(1, '#0a0d12');
  }
  perCtx.set(key, grad);
  return grad;
}

/**
 * Muro/bloque rectangular (arquitectura urbana): losa con bisel, juntas de
 * sillería, placas metálicas y remaches, grietas por daño y barra de vida
 * discreta. La placa hexagonal clásica se conserva intacta para las coberturas
 * legacy (círculos de 6 campos).
 */
export function drawRectCover(ctx, cover, opts = {}) {
  const time = num(opts.time, 0);
  const frac = clamp01(cover.hp / cover.maxHp);
  const w = Math.max(6, num(cover.w, 6));
  const h = Math.max(6, num(cover.h, 6));
  const wall = cover.kind === 'wall';
  const accent = frac > 0.6 ? TACTICAL_STYLE.cyan : frac > 0.28 ? TACTICAL_STYLE.amber : TACTICAL_STYLE.coral;
  const rand = rngFromId(cover.id);
  const variant = Number.isInteger(cover.variant) ? ((cover.variant % 4) + 4) % 4 : 0;
  const x = -w / 2;
  const y = -h / 2;
  const bevel = Math.max(2, Math.min(w, h) * 0.16);

  ctx.save();
  ctx.translate(cover.x, cover.y);

  // Halo de blindaje plano (sin gradiente por copia).
  ctx.fillStyle = hexA(accent, 0.045);
  ctx.fillRect(x - bevel * 0.5, y - bevel * 0.5, w + bevel, h + bevel);

  // Losa con bisel (chaflán en las cuatro esquinas).
  ctx.beginPath();
  ctx.moveTo(x + bevel, y);
  ctx.lineTo(x + w - bevel, y);
  ctx.lineTo(x + w, y + bevel);
  ctx.lineTo(x + w, y + h - bevel);
  ctx.lineTo(x + w - bevel, y + h);
  ctx.lineTo(x + bevel, y + h);
  ctx.lineTo(x, y + h - bevel);
  ctx.lineTo(x, y + bevel);
  ctx.closePath();
  ctx.fillStyle = slabGradient(ctx, w, h, wall ? 'wall' : 'block');
  ctx.fill();
  ctx.strokeStyle = TACTICAL_STYLE.rim;
  ctx.lineWidth = Math.max(1.2, Math.min(w, h) * 0.035);
  ctx.shadowColor = hexA(accent, 0.5);
  ctx.shadowBlur = 8;
  ctx.stroke();
  ctx.shadowBlur = 0;

  // Cornisa superior (luz) y sombra inferior: lee como volumen, no como mancha.
  ctx.strokeStyle = hexA(TACTICAL_STYLE.cyan, 0.22);
  ctx.lineWidth = Math.max(1, Math.min(w, h) * 0.03);
  ctx.beginPath();
  ctx.moveTo(x + bevel, y + bevel * 0.55);
  ctx.lineTo(x + w - bevel, y + bevel * 0.55);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.5)';
  ctx.beginPath();
  ctx.moveTo(x + bevel, y + h - bevel * 0.5);
  ctx.lineTo(x + w - bevel, y + h - bevel * 0.5);
  ctx.stroke();

  // Sillería / placas metálicas según variante (siempre determinista).
  ctx.strokeStyle = hexA(wall ? TACTICAL_STYLE.cyan : TACTICAL_STYLE.amber, 0.16);
  ctx.lineWidth = Math.max(0.8, Math.min(w, h) * 0.022);
  ctx.beginPath();
  if (variant % 2 === 0) {
    const stepX = Math.max(18, Math.min(w, h) * 0.75);
    for (let gx = x + stepX; gx < x + w - 2; gx += stepX) {
      ctx.moveTo(gx, y + bevel);
      ctx.lineTo(gx, y + h - bevel);
    }
  } else {
    const stepY = Math.max(16, Math.min(w, h) * 0.5);
    for (let gy = y + stepY; gy < y + h - 2; gy += stepY) {
      ctx.moveTo(x + bevel, gy);
      ctx.lineTo(x + w - bevel, gy);
    }
  }
  if (variant >= 2) {
    ctx.strokeStyle = hexA(accent, 0.12);
    ctx.beginPath();
    ctx.moveTo(x + bevel, y + h / 2);
    ctx.lineTo(x + w - bevel, y + h / 2);
    ctx.stroke();
  }
  ctx.stroke();

  // Remaches: pocos y en las esquinas del bisel.
  ctx.fillStyle = wall ? '#3a4f68' : '#333941';
  const boltR = Math.max(1.2, Math.min(w, h) * 0.05);
  for (const [bx, by] of [
    [x + bevel * 0.9, y + bevel * 0.9],
    [x + w - bevel * 0.9, y + bevel * 0.9],
    [x + bevel * 0.9, y + h - bevel * 0.9],
    [x + w - bevel * 0.9, y + h - bevel * 0.9],
  ]) {
    ctx.beginPath();
    ctx.arc(bx, by, boltR, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = hexA(accent, 0.4);
    ctx.lineWidth = Math.max(0.6, boltR * 0.35);
    ctx.stroke();
  }

  // Grietas: cuanto más daño, más largas y más naranjas.
  if (frac < 0.85) {
    const cracks = 1 + Math.round((1 - frac) * 4);
    const len = Math.min(w, h) * 0.6;
    ctx.strokeStyle = hexA(TACTICAL_STYLE.coral, 0.28 + 0.42 * (1 - frac));
    ctx.lineWidth = Math.max(0.9, len * 0.05);
    ctx.lineCap = 'round';
    for (let c = 0; c < cracks; c++) {
      const along = rand() > 0.5;
      let px = (rand() - 0.5) * w * 0.7;
      let py = (rand() - 0.5) * h * 0.7;
      ctx.beginPath();
      ctx.moveTo(px, py);
      for (let seg = 0; seg < 3; seg++) {
        px += along ? len / 3 : (rand() - 0.5) * len * 0.4;
        py += along ? (rand() - 0.5) * len * 0.4 : len / 3;
        ctx.lineTo(px, py);
      }
      ctx.stroke();
    }
    // Muesca de derrumbe cuando está muy tocado.
    if (frac < 0.35) {
      ctx.fillStyle = 'rgba(8, 11, 16, 0.55)';
      ctx.beginPath();
      ctx.moveTo(x + w - bevel, y + h - bevel);
      ctx.lineTo(x + w - bevel * 3.2, y + h - bevel);
      ctx.lineTo(x + w - bevel, y + h - bevel * 3.2);
      ctx.closePath();
      ctx.fill();
    }
  }

  if (frac < 0.999) drawCoverHpBar(ctx, cover, frac, accent);
  ctx.restore();
  void time;
}

/** Barra discreta de vida: solo aparece cuando la placa está dañada. */
function drawCoverHpBar(ctx, cover, frac, accent) {
  const boxed = cover.w > 0 && cover.h > 0;
  const w = boxed ? Math.max(cover.w * 0.9, 52) : Math.max(cover.r * 1.5, 52);
  const h = Math.max(4.5, (boxed ? Math.min(cover.w, cover.h) : cover.r) * 0.085);
  const x = -w / 2;
  const y = boxed ? -cover.h / 2 - h * 3.2 : -cover.r - h * 3.2;
  ctx.save();
  ctx.globalAlpha = 0.92;
  roundRectPath(ctx, x, y, w, h, h / 2);
  ctx.fillStyle = 'rgba(6, 10, 16, 0.78)';
  ctx.fill();
  ctx.strokeStyle = hexA(accent, 0.5);
  ctx.lineWidth = Math.max(0.8, h * 0.16);
  ctx.stroke();
  // Relleno por tramos: se lee el daño sin dominar la escena.
  roundRectPath(ctx, x + h * 0.22, y + h * 0.22, Math.max(0, (w - h * 0.44) * frac), h * 0.56, h * 0.28);
  ctx.fillStyle = accent;
  ctx.fill();
  // Marcas de cuarto para que se aprecie el desgaste.
  ctx.strokeStyle = 'rgba(10, 16, 24, 0.7)';
  ctx.lineWidth = Math.max(0.7, h * 0.14);
  ctx.beginPath();
  for (let i = 1; i < 4; i++) {
    const tx = x + (w / 4) * i;
    ctx.moveTo(tx, y);
    ctx.lineTo(tx, y + h);
  }
  ctx.stroke();
  ctx.restore();
}

/**
 * Placa de blindaje hexagonal. Se distingue de un asteroide por la forma
 * regular, el interior metálico y las juntas rectas; del resto del escenario,
 * por el borde acero con juntas cian/ámbar tenues.
 */
export function drawCover(ctx, cover, opts = {}) {
  // Rectángulo axis-aligned (Ciudadela): losa urbana con bisel y sillería.
  if (num(cover.w, 0) > 0 && num(cover.h, 0) > 0) {
    drawRectCover(ctx, cover, opts);
    return;
  }
  const time = num(opts.time, 0);
  const frac = clamp01(cover.hp / cover.maxHp);
  const r = cover.r;
  const accent = frac > 0.6 ? TACTICAL_STYLE.cyan : frac > 0.28 ? TACTICAL_STYLE.amber : TACTICAL_STYLE.coral;
  const rand = rngFromId(cover.id);

  ctx.save();
  ctx.translate(cover.x, cover.y);

  // Halo de blindaje: disco plano de alfa bajo (sin gradiente por cobertura y
  // por copia toroidal, que a 60fps con varias copias se nota).
  ctx.fillStyle = hexA(accent, 0.05);
  ctx.beginPath();
  ctx.arc(0, 0, r * 1.18, 0, TAU);
  ctx.fill();

  // Placa base metálica: gradiente cacheado por contexto (una sola creación
  // para todas las coberturas del mismo radio y todas las copias toroidales).
  hexPath(ctx, r);
  ctx.fillStyle = plateGradient(ctx, r);
  ctx.fill();
  ctx.strokeStyle = TACTICAL_STYLE.rim;
  ctx.lineWidth = Math.max(1.5, r * 0.045);
  ctx.shadowColor = hexA(accent, 0.55);
  ctx.shadowBlur = 9;
  ctx.stroke();
  ctx.shadowBlur = 0;

  // Placa interior girada: lee como estructura, no como roca.
  hexPath(ctx, r * 0.72, Math.PI / 6);
  ctx.fillStyle = 'rgba(17, 26, 36, 0.92)';
  ctx.fill();
  ctx.strokeStyle = TACTICAL_STYLE.seam;
  ctx.lineWidth = Math.max(1, r * 0.028);
  ctx.stroke();

  // Juntas cian/ámbar tenues: estado de la coraza por tramos.
  ctx.lineWidth = Math.max(1.2, r * 0.035);
  for (let i = 0; i < 6; i++) {
    const a0 = -Math.PI / 2 + (i / 6) * TAU + 0.08;
    const a1 = a0 + TAU / 6 - 0.16;
    ctx.strokeStyle = hexA(i % 2 === 0 ? TACTICAL_STYLE.cyan : TACTICAL_STYLE.amber, 0.2 + 0.05 * Math.sin(time * 1.1 + i));
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.86, a0, a1);
    ctx.stroke();
  }

  // Remaches en los vértices.
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * TAU - Math.PI / 2;
    const vx = Math.cos(a) * r * 0.9;
    const vy = Math.sin(a) * r * 0.9;
    ctx.beginPath();
    ctx.arc(vx, vy, Math.max(1.4, r * 0.06), 0, TAU);
    ctx.fillStyle = '#2c3d51';
    ctx.fill();
    ctx.strokeStyle = hexA(accent, 0.45);
    ctx.lineWidth = Math.max(0.8, r * 0.02);
    ctx.stroke();
  }

  // Grietas: cuanto más daño, más largas y más naranjas.
  if (frac < 0.8) {
    const cracks = 1 + Math.round((1 - frac) * 4);
    ctx.strokeStyle = hexA(TACTICAL_STYLE.coral, 0.3 + 0.4 * (1 - frac));
    ctx.lineWidth = Math.max(1, r * 0.033);
    ctx.lineCap = 'round';
    for (let c = 0; c < cracks; c++) {
      const a = rand() * TAU;
      const len = r * (0.45 + rand() * 0.5);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      let px = 0;
      let py = 0;
      for (let seg = 0; seg < 3; seg++) {
        px += Math.cos(a + (rand() - 0.5) * 0.9) * (len / 3);
        py += Math.sin(a + (rand() - 0.5) * 0.9) * (len / 3);
        ctx.lineTo(px, py);
      }
      ctx.stroke();
    }
  }

  if (frac < 0.999) drawCoverHpBar(ctx, cover, frac, accent);
  ctx.restore();
}

/** Todas las coberturas de la vista (una pasada por copia toroidal). */
export function drawCovers(ctx, covers, opts = {}) {
  const list = normalizeCovers(covers, opts.fallback);
  for (const cover of list) drawCover(ctx, cover, opts);
  return list.length;
}

// ───────────────────────────────────────────────────────────── naves caídas

/** Cruz de rescate (minimapa, punteros de borde y marca sobre la nave). */
export function drawCross(ctx, x, y, size, color, lineWidth = 2) {
  const s = Math.max(1.5, size);
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x - s, y);
  ctx.lineTo(x + s, y);
  ctx.moveTo(x, y - s);
  ctx.lineTo(x, y + s);
  ctx.stroke();
  ctx.restore();
}

function drawSosRings(ctx, p, radius, time) {
  ctx.save();
  for (let i = 0; i < 2; i++) {
    const t = (time * 0.55 + i * 0.5) % 1;
    ctx.globalAlpha = (1 - t) * 0.34;
    ctx.strokeStyle = TACTICAL_STYLE.sos;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.arc(p.x, p.y, radius + 9 + t * radius * 1.5, 0, TAU);
    ctx.stroke();
  }
  ctx.restore();
}

function drawWreckHull(ctx, p, opts, info, radius, color, k) {
  const time = num(opts.time, 0);
  // Deriva lenta: la nave averiada gira despacio sobre sí misma.
  const spin = time * 0.5;
  const revivable = info.revivable;
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate((num(p.angle, 0)) + spin);

  // Humo/escape: tres bocanadas con fase propia (nada de parpadeo agresivo).
  if (revivable) {
    for (let i = 0; i < 3; i++) {
      const t = (time * 0.8 + i / 3) % 1;
      ctx.globalAlpha = (1 - t) * 0.32;
      ctx.fillStyle = i % 2 === 0 ? 'rgba(160, 180, 205, 1)' : 'rgba(255, 170, 110, 1)';
      ctx.beginPath();
      ctx.arc(-radius * 0.9 - t * radius * 1.6, (i - 1) * radius * 0.35, radius * (0.18 + t * 0.3), 0, TAU);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  // Casco apagado: silueta del modelo real, sin relleno brillante.
  hullPath(ctx, p.model, radius);
  ctx.fillStyle = TACTICAL_STYLE.downedHull;
  ctx.fill();
  ctx.strokeStyle = hexA(color, 0.45);
  ctx.lineWidth = 2;
  ctx.stroke();

  // Fractura: el contorno discontinuo dice "averiada" sin gritar.
  ctx.setLineDash([radius * 0.22, radius * 0.18]);
  ctx.strokeStyle = hexA(revivable ? TACTICAL_STYLE.sos : TACTICAL_STYLE.coral, 0.75);
  ctx.lineWidth = 1.4;
  hullPath(ctx, p.model, radius);
  ctx.stroke();
  ctx.setLineDash([]);

  // Chispas interiores.
  ctx.strokeStyle = hexA('#ffd7a1', 0.5 + 0.3 * Math.abs(Math.sin(time * 6)));
  ctx.lineWidth = 1.1;
  ctx.beginPath();
  ctx.moveTo(-radius * 0.2, -radius * 0.3);
  ctx.lineTo(radius * 0.25, radius * 0.15);
  ctx.moveTo(-radius * 0.25, radius * 0.35);
  ctx.lineTo(radius * 0.1, radius * 0.05);
  ctx.stroke();
  ctx.restore();
  void k;
}

/**
 * Nave derribada. Dibuja SIEMPRE su propio save/restore y funciona aunque
 * `player.alive === false`. `opts`:
 *   time, radius, color, scale, isSelf, info (de tacticalPlayer), label,
 *   seconds (total del contrato), helpInRange, ownerColor.
 */
export function drawDownedShip(ctx, p, opts = {}) {
  const time = num(opts.time, 0);
  const radius = Math.max(6, num(opts.radius, 13));
  const color = opts.color ?? '#9fc4ff';
  const scale = Math.max(0.05, num(opts.scale, 1));
  // UI con tamaño de pantalla constante: se compensa la escala de la cámara.
  const k = Math.max(0.6, Math.min(3.2, 1 / scale));
  const fb = opts.fallback ?? TACTICAL_FALLBACK;
  const info = opts.info ?? tacticalPlayer(p, fb);
  const total = Math.max(0.001, num(opts.seconds, fb.downed.seconds));
  const label = String(opts.label ?? '');
  const isSelf = opts.isSelf === true;
  const helpInRange = opts.helpInRange === true;
  const seconds = Math.max(0, Math.ceil(info.downedRemaining));

  const restore = { x: p.x ?? 0, y: p.y ?? 0 };

  ctx.save();

  // Distintivo de la nave propia cuando la escala es muy pequeña.
  if (isSelf && scale < 0.55) {
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.6)';
    ctx.lineWidth = 1.2 / scale;
    ctx.setLineDash([5 / scale, 4 / scale]);
    ctx.beginPath();
    ctx.arc(restore.x, restore.y, Math.max(radius + 12, 11 / scale), 0, TAU);
    ctx.stroke();
    ctx.restore();
  }

  if (info.revivable) drawSosRings(ctx, p, radius, time);
  drawWreckHull(ctx, p, opts, info, radius, color, k);

  // Cruz de rescate + chip con plaza (1P) y tiempo restante.
  const fontPx = Math.max(10, 11 * Math.min(k, 1.5));
  const chipH = Math.max(14, fontPx * 1.55);
  const lift = Math.max(radius + 10, 20 / scale);
  const chipY = restore.y - lift - (radius * 0.1);
  ctx.save();
  ctx.font = `700 ${fontPx}px ui-monospace, Menlo, monospace`;
  const chipText = `${label ? `${label}  ` : ''}+${seconds}s`;
  const chipW = Math.max(chipH * 2.2, textWidth(ctx, chipText) + chipH * 0.9);
  const chipX = restore.x - chipW / 2;
  const chipAccent = isSelf ? '#ffffff' : (info.revivable ? TACTICAL_STYLE.sos : TACTICAL_STYLE.coral);
  ctx.globalAlpha = info.revivable ? 0.95 : 0.6;
  roundRectPath(ctx, chipX, chipY - chipH / 2, chipW, chipH, chipH / 2);
  ctx.fillStyle = 'rgba(4, 8, 18, 0.78)';
  ctx.fill();
  ctx.strokeStyle = hexA(chipAccent, 0.85);
  ctx.lineWidth = Math.max(1, 1.2 * Math.min(k, 1.4));
  ctx.stroke();
  // Cruz dibujada en unidades de mundo (no usa drawCross para no anidar save).
  const crossSize = chipH * 0.28;
  const crossX = chipX + chipH * 0.55;
  ctx.strokeStyle = hexA(chipAccent, 0.95);
  ctx.lineWidth = Math.max(1, crossSize * 0.5);
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(crossX - crossSize, chipY);
  ctx.lineTo(crossX + crossSize, chipY);
  ctx.moveTo(crossX, chipY - crossSize);
  ctx.lineTo(crossX, chipY + crossSize);
  ctx.stroke();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = isSelf ? '#ffffff' : hexA(chipAccent, 0.95);
  ctx.fillText(chipText, crossX + crossSize * 1.5 + chipH * 0.14, chipY + 0.5);
  ctx.restore();

  // Barra doble: sangrado restante (ámbar→coral) y progreso de rescate (menta).
  const barW = Math.max(46 * k, radius * 2.6);
  const barH = Math.max(4, 4.5 * k * 0.9);
  const barY = chipY + chipH / 2 + barH * 0.9;
  const bleedFrac = clamp01(info.downedHp / Math.max(1, num(opts.downedMaxHp, fb.downed.hp)));
  const barX = restore.x - barW / 2;
  ctx.save();
  roundRectPath(ctx, barX, barY, barW, barH, barH / 2);
  ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
  ctx.fill();
  const bleedColor = bleedFrac > 0.55 ? '#ffd166' : bleedFrac > 0.28 ? '#ff9f43' : '#ff6b5e';
  roundRectPath(ctx, barX, barY, barW * bleedFrac, barH, barH / 2);
  ctx.fillStyle = hexA(bleedColor, 0.85);
  ctx.fill();
  if (info.reviveProgress > 0) {
    roundRectPath(ctx, barX, barY, barW * info.reviveProgress, barH, barH / 2);
    ctx.fillStyle = hexA(TACTICAL_STYLE.revive, 0.95);
    ctx.fill();
  }
  ctx.strokeStyle = 'rgba(200, 220, 240, 0.35)';
  ctx.lineWidth = Math.max(0.7, barH * 0.18);
  roundRectPath(ctx, barX, barY, barW, barH, barH / 2);
  ctx.stroke();
  // Cuenta atrás del rescate dibujada como fracción de la barra (sin texto extra).
  ctx.strokeStyle = hexA(TACTICAL_STYLE.sos, 0.5);
  ctx.beginPath();
  ctx.moveTo(barX + barW * clamp01(info.downedRemaining / total), barY - barH * 0.35);
  ctx.lineTo(barX + barW * clamp01(info.downedRemaining / total), barY + barH * 1.35);
  ctx.stroke();
  ctx.restore();

  // Indicador de "ayudable": aro de rescate y aviso de tecla cuando el aliado
  // vivo está dentro del radio de rescate.
  if (info.revivable && (helpInRange || info.reviveProgress > 0)) {
    const ringR = radius + 15 + Math.sin(time * 2.6) * 1.5;
    ctx.save();
    ctx.strokeStyle = hexA(TACTICAL_STYLE.revive, 0.85);
    ctx.shadowColor = TACTICAL_STYLE.revive;
    ctx.shadowBlur = 12;
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    ctx.arc(restore.x, restore.y, ringR, -Math.PI / 2, -Math.PI / 2 + TAU * (info.reviveProgress > 0 ? info.reviveProgress : 0.999));
    ctx.stroke();
    ctx.restore();
    if (helpInRange && !isSelf) {
      ctx.save();
      ctx.font = `700 ${Math.max(9, 10 * Math.min(k, 1.5))}px ui-monospace, Menlo, monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const hintW = textWidth(ctx, 'F · RESCATE') + 14 * Math.min(k, 1.5);
      ctx.globalAlpha = 0.55 + 0.35 * Math.abs(Math.sin(time * 4));
      roundRectPath(ctx, restore.x - hintW / 2, restore.y + radius + 18 / scale, hintW, Math.max(13, 14 * Math.min(k, 1.5)), 6);
      ctx.fillStyle = 'rgba(4, 8, 18, 0.7)';
      ctx.fill();
      ctx.strokeStyle = hexA(TACTICAL_STYLE.revive, 0.7);
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = TACTICAL_STYLE.revive;
      ctx.fillText('F · RESCATE', restore.x, restore.y + radius + 18 / scale + Math.max(13, 14 * Math.min(k, 1.5)) / 2 + 0.5);
      ctx.restore();
    }
  }

  ctx.restore();
  // Nota: el ownerColor queda disponible para futuros tintes sin tocar la pila.
  void opts.ownerColor;
}

// ──────────────────────────────────────────────────────────────── perdigones

/** Perdigón de plasma: brillo naranja tenue y rastro corto de tres gotas. */
export function drawPlasmaBullet(ctx, b, opts = {}) {
  const color = opts.color ?? TACTICAL_STYLE.plasma;
  const r = Math.max(2, num(opts.radius, 3.2));
  const len = Math.max(4, num(opts.trail, 11));
  const angle = num(b.angle, 0);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);

  ctx.save();
  ctx.lineCap = 'round';
  // Rastro corto: tres gotas que se apagan (sin gradientes por bala).
  for (let i = 1; i <= 3; i++) {
    const t = i / 3;
    ctx.globalAlpha = 0.42 * (1 - t) + 0.12;
    ctx.fillStyle = hexA(color, 0.9);
    ctx.beginPath();
    ctx.arc(b.x - cos * len * t * 1.25, b.y - sin * len * t * 1.25, r * (1 - t * 0.55), 0, TAU);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  // Perdigón con resplandor suave.
  ctx.shadowColor = color;
  ctx.shadowBlur = 10;
  ctx.fillStyle = hexA(color, 0.95);
  ctx.beginPath();
  ctx.arc(b.x, b.y, r, 0, TAU);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.fillStyle = hexA(TACTICAL_STYLE.plasmaCore, 0.92);
  ctx.beginPath();
  ctx.arc(b.x, b.y, r * 0.42, 0, TAU);
  ctx.fill();
  ctx.restore();
}
