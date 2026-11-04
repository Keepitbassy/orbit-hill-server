// Orbit Hill Ciudadela — capa visual del CAMPO DE BATALLA.
//
// Módulo de DIBUJO PURO (sin DOM y sin estado propio más allá de cachés
// derivadas de los datos). Recibe el contexto 2D ya transformado a unidades de
// mundo por el pipeline toroidal de tiles de render.js y pinta:
//
//   · pisos/plazas/corredores (`view.zones` + `view.battlefield`) con nombre
//     discreto y arquitectura vectorial: nada de bitmaps;
//   · weapon pads (`view.weaponPads`) con icono, cooldown y munición;
//   · nubes de humo (`view.smokes`) como discos de niebla POR ENCIMA de las
//     entidades, con caché de gradientes y tope de 8 nubes a la vez;
//   · retícula de apuntado (LT/RMB) y carga de disparo estable;
//   · muros del minimapa (rectángulos) y marcadores de pad.
//
// También expone los ayudantes de OCULTACIÓN por humo, que usan la MISMA
// geometría que el servidor (segmentBlocked sobre las nubes): si hay una nube
// entre la nave propia y un enemigo, el enemigo no pinta nombre, barra ni
// punto de minimapa. Los aliados derribados sí siguen visibles (aviso de
// rescate). El snapshot NO se filtra por nave: esto es solo niebla VISUAL.
//
// Cada función equilibra su propio save()/restore().

import { SHIP } from '../../shared/constants.js';
import { buildBattlefield, sanitizeBattlefield, segmentBlocked } from '../../shared/battlefield.js';

const TAU = Math.PI * 2;
const MAX_CLOUDS = 8;

const num = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);

/** Colores por plaza. La clave sale del prefijo del id de la zona. */
export const ZONE_STYLE = Object.freeze({
  courtyard: Object.freeze({ hue: '#ffd166', kind: 'plaza', label: 'PATIO' }),
  pavilion: Object.freeze({ hue: '#7fe9ff', kind: 'plaza', label: 'PABELLÓN' }),
  northway: Object.freeze({ hue: '#9fd8ff', kind: 'corridor', label: 'CORREDOR' }),
  garden: Object.freeze({ hue: '#6ef7a8', kind: 'garden', label: 'JARDÍN' }),
  reactor: Object.freeze({ hue: '#ffa552', kind: 'reactor', label: 'REACTOR' }),
  balcony: Object.freeze({ hue: '#c9b6ff', kind: 'balcony', label: 'BALCÓN' }),
  overlook: Object.freeze({ hue: '#3ff2ff', kind: 'overlook', label: 'MIRADOR' }),
  lane: Object.freeze({ hue: '#b8c6d4', kind: 'lane', label: 'RUTA' }),
});

export const PAD_STYLE = Object.freeze({
  sniper: Object.freeze({ label: 'SNIPER', short: 'FUSIL', color: '#e6dcff', core: '#b18cff' }),
  boomer: Object.freeze({ label: 'BOOM', short: 'BOMBA', color: '#ffa552', core: '#ff7a3c' }),
  smoke: Object.freeze({ label: 'HUMO', short: 'HUMO', color: '#c6d3e0', core: '#8f9dad' }),
});

export const SMOKE_STYLE = Object.freeze({
  fog: '#8d9aa8',
  deep: '#3d4753',
  rim: 'rgba(196, 210, 224, 0.55)',
  minimap: 'rgba(150, 175, 205, 0.55)',
});

function hexA(hex, alpha) {
  if (typeof hex !== 'string' || !hex.startsWith('#')) return `rgba(255, 255, 255, ${alpha})`;
  const v = hex.length === 4 ? hex.slice(1).split('').map((c) => c + c).join('') : hex.slice(1);
  const n = Number.parseInt(v, 16);
  if (!Number.isFinite(n)) return `rgba(255, 255, 255, ${alpha})`;
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

function textWidth(ctx, text) {
  if (typeof ctx?.measureText === 'function') {
    try {
      const m = ctx.measureText(text);
      if (m && Number.isFinite(m.width)) return m.width;
    } catch {
      /* stub sin medida real */
    }
  }
  return String(text).length * 6;
}

function roundRectPath(ctx, x, y, w, h, r) {
  const radius = Math.max(0, Math.min(r, Math.min(Math.abs(w), Math.abs(h)) / 2));
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

/** ¿El perfil de campo de batalla está activo? (`view.battlefield` presente) */
export function battlefieldOn(view) {
  return battlefieldId(view) !== null;
}

/** Clase visual de una zona a partir de su id (determinista, sin estado). */
export function zoneKind(id) {
  const key = String(id ?? '');
  if (key.startsWith('courtyard')) return ZONE_STYLE.courtyard;
  if (key.startsWith('pavilion')) return ZONE_STYLE.pavilion;
  if (key.startsWith('northway')) return ZONE_STYLE.northway;
  if (key.startsWith('garden')) return ZONE_STYLE.garden;
  if (key.startsWith('reactor')) return ZONE_STYLE.reactor;
  if (key.startsWith('balcony')) return ZONE_STYLE.balcony;
  if (key.startsWith('overlook')) return ZONE_STYLE.overlook;
  return ZONE_STYLE.lane;
}

/** Normaliza una zona del servidor (o una fila [id,label,x,y,w,h]). */
export function normalizeZone(raw, index = 0) {
  if (!raw || typeof raw !== 'object') return null;
  const src = Array.isArray(raw)
    ? { id: raw[0], label: raw[1], x: raw[2], y: raw[3], w: raw[4], h: raw[5] }
    : raw;
  const x = num(src.x, NaN);
  const y = num(src.y, NaN);
  const w = num(src.w, NaN);
  const h = num(src.h, NaN);
  if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return null;
  return {
    id: src.id === undefined || src.id === null ? `z${index}` : String(src.id),
    label: typeof src.label === 'string' ? src.label : '',
    x,
    y,
    w,
    h,
  };
}

/** Lista normalizada de `view.zones` (siempre array, nunca lanza). */
export function collectZones(view) {
  const src = Array.isArray(view) ? view : Array.isArray(view?.zones) ? view.zones : [];
  const out = [];
  for (let i = 0; i < src.length; i++) {
    const z = normalizeZone(src[i], i);
    if (z) out.push(z);
  }
  return out;
}
/** Normaliza un weapon pad (o una fila [id,x,y,type,remaining]). */
export function normalizePad(raw, index = 0) {
  if (!raw || typeof raw !== 'object') return null;
  const src = Array.isArray(raw)
    ? { id: raw[0], x: raw[1], y: raw[2], type: raw[3], remaining: raw[4] }
    : raw;
  const x = num(src.x, NaN);
  const y = num(src.y, NaN);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const type = src.type === 'boomer' || src.type === 'smoke' ? src.type : 'sniper';
  return {
    id: src.id === undefined || src.id === null ? `p${index}` : src.id,
    x,
    y,
    type,
    remaining: Math.max(0, num(src.remaining, 0)),
    taken: src.taken === true,
  };
}

export function collectPads(view) {
  const src = Array.isArray(view) ? view : Array.isArray(view?.weaponPads) ? view.weaponPads : [];
  const out = [];
  for (let i = 0; i < src.length; i++) {
    const p = normalizePad(src[i], i);
    if (p) out.push(p);
  }
  return out;
}

/** Normaliza una nube de humo (o una fila [id,x,y,r,remaining,team]). */
export function normalizeSmoke(raw, index = 0) {
  if (!raw || typeof raw !== 'object') return null;
  const src = Array.isArray(raw)
    ? { id: raw[0], x: raw[1], y: raw[2], r: raw[3], remaining: raw[4], team: raw[5] }
    : raw;
  const x = num(src.x, NaN);
  const y = num(src.y, NaN);
  const r = num(src.r, NaN);
  if (![x, y, r].every(Number.isFinite) || r <= 0) return null;
  return {
    id: src.id === undefined || src.id === null ? `s${index}` : src.id,
    x,
    y,
    r,
    remaining: Math.max(0, num(src.remaining, 0)),
    team: typeof src.team === 'string' ? src.team : null,
  };
}

/** Nubes de humo normalizadas (tope duro de 8 para no castigar el frame). */
export function collectSmokes(view) {
  const src = Array.isArray(view) ? view : Array.isArray(view?.smokes) ? view.smokes : [];
  const out = [];
  for (let i = 0; i < src.length; i++) {
    const s = normalizeSmoke(src[i], i);
    if (s) out.push(s);
    if (out.length >= MAX_CLOUDS) break;
  }
  return out;
}

// ──────────────────────────────────────── layout derivado del mapa (caché)
//
// El snapshot de red NO trae la geometría del mapa (ni zonas ni posiciones de
// pad): solo el id (`battlefield: 'citadel'`), el mundo y la semilla. Como el
// mapa es DETERMINISTA, la capa visual lo reconstruye con el MISMO
// `buildBattlefield` del servidor y lo cachea por (id, tamaño, semilla): se
// paga una vez y después solo se leen los datos. Si la red SÍ manda `zones` o
// `weaponPads` (por ejemplo un servidor que prefiera enviarlos), se respeta lo
// que llegue y solo se completa lo que falte.

const layoutCache = new Map();
const MAX_LAYOUTS = 16;

/** Id de campo de batalla de una vista ('citadel', true u objeto {id|on}). */
export function battlefieldId(view) {
  const raw = view?.battlefield;
  if (raw === true) return 'citadel';
  if (typeof raw === 'string') return sanitizeBattlefield(raw);
  if (raw && typeof raw === 'object') {
    if (typeof raw.id === 'string') return sanitizeBattlefield(raw.id);
    if (typeof raw.battlefield === 'string') return sanitizeBattlefield(raw.battlefield);
    if (raw.on === true) return sanitizeBattlefield(raw.name ?? 'citadel');
  }
  return null;
}

/**
 * Layout estático del mapa de la vista, derivado y cacheado. Devuelve `null`
 * si la vista no trae un campo de batalla reconocible.
 */
export function battlefieldLayout(view) {
  const id = battlefieldId(view);
  if (!id) return null;
  const size = view?.world;
  const world = size && Number.isFinite(Number(size.w)) && Number.isFinite(Number(size.h)) && size.w > 0 && size.h > 0
    ? { w: Number(size.w), h: Number(size.h) }
    : null;
  const seed = Number.isFinite(Number(view?.seed)) ? Number(view.seed) : 1;
  const key = `${id}|${world ? `${world.w}x${world.h}` : 'default'}|${seed}`;
  const cached = layoutCache.get(key);
  if (cached) return cached;
  const layout = buildBattlefield(id, world ?? undefined, seed);
  layoutCache.set(key, layout);
  if (layoutCache.size > MAX_LAYOUTS) layoutCache.delete(layoutCache.keys().next().value);
  return layout;
}

/** Zonas de piso: las de la red si vienen; si no, las del mapa determinista. */
export function layoutZones(view) {
  if (Array.isArray(view?.zones)) return collectZones(view.zones);
  return collectZones(battlefieldLayout(view)?.zones ?? []);
}

/** Estado dinámico de un pad tal como llega de la red (sin exigir x/y). */
function padState(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const src = Array.isArray(raw)
    ? { id: raw[0], x: raw[1], y: raw[2], type: raw[3], remaining: raw[4], taken: raw[5] }
    : raw;
  return {
    id: src.id === undefined || src.id === null ? null : src.id,
    x: num(src.x, NaN),
    y: num(src.y, NaN),
    type: typeof src.type === 'string' ? src.type : null,
    remaining: Math.max(0, num(src.remaining, 0)),
    taken: src.taken === true,
  };
}

/**
 * Weapon pads de la vista. El MAPA manda en posiciones y en el conjunto de
 * pads (los cuatro siempre están, aunque la red no los mande); la red solo
 * aporta el estado vivo (cooldown/recogido), emparejado por id y, si el id no
 * viene, por orden. Un pad que el mapa no conozca (servidor con otro layout) se
 * añade si trae posición propia.
 */
export function layoutPads(view) {
  const derived = battlefieldLayout(view)?.pads ?? [];
  const dynamic = Array.isArray(view?.weaponPads) ? view.weaponPads : Array.isArray(view?.pads) ? view.pads : null;
  const out = derived.map((pad) => ({ id: pad.id, x: pad.x, y: pad.y, type: pad.type, remaining: 0, taken: false }));
  if (!dynamic) return out;
  dynamic.forEach((raw, index) => {
    const row = padState(raw);
    if (!row) return;
    const onMap = row.id === null ? out[index] : out.find((p) => String(p.id) === String(row.id));
    if (onMap) {
      onMap.remaining = row.remaining;
      onMap.taken = row.taken;
      return;
    }
    // Pad que el mapa no conoce: se pinta donde diga la red (si trae posición).
    if (!Number.isFinite(row.x) || !Number.isFinite(row.y)) return;
    out.push({
      id: row.id ?? `p${index}`,
      x: row.x,
      y: row.y,
      type: row.type ?? 'sniper',
      remaining: row.remaining,
      taken: row.taken,
    });
  });
  return out;
}

/** Coberturas: las de la red si la clave existe; si no, las del mapa. */
export function layoutCovers(view) {
  if (Array.isArray(view?.covers)) return view.covers;
  const layout = battlefieldLayout(view);
  return Array.isArray(layout?.covers) ? layout.covers : [];
}

// ─────────────────────────────────────────────────────── pisos y corredores

/**
 * Pisos, plazas y corredores. Decoración plana con arquitectura vectorial:
 * losa con junta, esquinas marcadas, trama de baldosas y rótulo discreto.
 * `opts`: { time, scale, labels=true }.
 */
export function drawFloorZones(ctx, zones, opts = {}) {
  const list = collectZones(zones);
  const time = num(opts.time, 0);
  const scale = Math.max(0.05, num(opts.scale, 1));
  const labels = opts.labels !== false;
  let drawn = 0;

  for (const zone of list) {
    const style = zoneKind(zone.id);
    const x = zone.x;
    const y = zone.y;
    const w = zone.w;
    const h = zone.h;
    ctx.save();
    // Losa de suelo: relleno muy tenue + junta perimetral.
    const g = ctx.createLinearGradient(x, y, x, y + h);
    g.addColorStop(0, hexA(style.hue, 0.07));
    g.addColorStop(0.55, hexA(style.hue, 0.035));
    g.addColorStop(1, hexA(style.hue, 0.015));
    ctx.fillStyle = g;
    ctx.fillRect(x, y, w, h);

    ctx.strokeStyle = hexA(style.hue, 0.28);
    ctx.lineWidth = 2 / scale;
    ctx.strokeRect(x, y, w, h);

    // Cornisa interior: marca la plaza sin tapar el combate.
    const inset = Math.min(w, h) * 0.06;
    ctx.strokeStyle = hexA(style.hue, 0.14);
    ctx.lineWidth = 1.2 / scale;
    ctx.strokeRect(x + inset, y + inset, w - inset * 2, h - inset * 2);

    // Trama de baldosas: solo en plazas grandes y con paso amplio.
    const step = Math.max(48, Math.min(w, h) / 3);
    if (opts.tiles !== false && w > 120 && h > 90) {
      ctx.strokeStyle = hexA(style.hue, 0.07);
      ctx.lineWidth = 1 / scale;
      ctx.beginPath();
      for (let gx = x + step; gx < x + w - 1; gx += step) {
        ctx.moveTo(gx, y + inset);
        ctx.lineTo(gx, y + h - inset);
      }
      for (let gy = y + step; gy < y + h - 1; gy += step) {
        ctx.moveTo(x + inset, gy);
        ctx.lineTo(x + w - inset, gy);
      }
      ctx.stroke();
    }

    // Esquinas: arquitectura urbana, cuatro muescas.
    const tick = Math.min(w, h) * 0.14;
    ctx.strokeStyle = hexA(style.hue, 0.5);
    ctx.lineWidth = 2.4 / scale;
    ctx.beginPath();
    for (const [cx, sx] of [[x, 1], [x + w, -1]]) {
      for (const [cy, sy] of [[y, 1], [y + h, -1]]) {
        ctx.moveTo(cx + sx * tick, cy);
        ctx.lineTo(cx, cy);
        ctx.lineTo(cx, cy + sy * tick);
      }
    }
    ctx.stroke();

    if (labels && zone.label) {
      const fontPx = Math.max(9, 11 / scale);
      ctx.font = `700 ${fontPx}px ui-monospace, Menlo, monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const text = String(zone.label).toUpperCase();
      const chipW = Math.max(fontPx * 4, textWidth(ctx, text) + fontPx * 1.6);
      const chipH = fontPx * 1.7;
      const cx = x + w / 2;
      const cy = y + chipH * 0.9 + inset * 0.4;
      ctx.globalAlpha = 0.5 + 0.06 * Math.sin(time * 0.7 + drawn);
      roundRectPath(ctx, cx - chipW / 2, cy - chipH / 2, chipW, chipH, chipH / 2);
      ctx.fillStyle = 'rgba(4, 8, 18, 0.5)';
      ctx.fill();
      ctx.strokeStyle = hexA(style.hue, 0.35);
      ctx.lineWidth = 1 / scale;
      ctx.stroke();
      ctx.globalAlpha = 0.78;
      ctx.fillStyle = hexA(style.hue, 0.9);
      ctx.fillText(text, cx, cy + 0.5);
    }
    ctx.restore();
    drawn += 1;
  }
  return drawn;
}

// ──────────────────────────────────────────────────────── weapon pads

/** Radio visual del pad (unidades de mundo). */
export const PAD_RADIUS = 30;

/**
 * Weapon pad: base hexagonal desde arriba, icono SVG-vectorial propio por tipo,
 * anillo de estado (listo = aro lleno) y munición/tiempo restante.
 * `opts`: { time, scale }.
 */
export function drawWeaponPad(ctx, pad, opts = {}) {
  const style = PAD_STYLE[pad.type] ?? PAD_STYLE.sniper;
  const time = num(opts.time, 0);
  const scale = Math.max(0.05, num(opts.scale, 1));
  const r = num(opts.radius, PAD_RADIUS);
  const ready = pad.remaining <= 0;
  const pulse = 1 + Math.sin(time * (ready ? 2.6 : 1.4)) * 0.05;

  ctx.save();
  ctx.translate(pad.x, pad.y);

  // Base: losa circular con anillo de estado.
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.82 * pulse, 0, TAU);
  ctx.fillStyle = hexA(style.core, ready ? 0.16 : 0.07);
  ctx.fill();
  ctx.strokeStyle = hexA(style.color, ready ? 0.85 : 0.4);
  ctx.lineWidth = Math.max(1.2, 2.2 / Math.max(scale, 0.3));
  ctx.stroke();

  // Hexágono interior: lenguaje urbano-militar.
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * TAU - Math.PI / 2;
    const px = Math.cos(a) * r * 0.55;
    const py = Math.sin(a) * r * 0.55;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.strokeStyle = hexA(style.color, 0.55);
  ctx.lineWidth = 1.2 / Math.max(scale, 0.3);
  ctx.stroke();

  drawPadGlyph(ctx, pad.type, r * 0.6 * pulse, style);

  // Anillo de recarga: se cierra conforme vuelve a estar disponible.
  if (!ready) {
    const frac = Math.max(0, Math.min(1, 1 - pad.remaining / 24));
    ctx.beginPath();
    ctx.arc(0, 0, r * 1.0, -Math.PI / 2, -Math.PI / 2 + TAU * frac);
    ctx.strokeStyle = hexA(style.color, 0.6);
    ctx.lineWidth = 2 / Math.max(scale, 0.3);
    ctx.stroke();
  }

  // Chip con nombre y estado.
  const fontPx = Math.max(9, 10 / scale);
  ctx.font = `700 ${fontPx}px ui-monospace, Menlo, monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const text = ready ? style.label : `${style.label} ${Math.ceil(pad.remaining)}s`;
  const chipW = Math.max(fontPx * 3.4, textWidth(ctx, text) + fontPx * 1.2);
  const chipH = fontPx * 1.6;
  roundRectPath(ctx, -chipW / 2, r * 1.15, chipW, chipH, chipH / 2);
  ctx.fillStyle = 'rgba(4, 8, 18, 0.66)';
  ctx.fill();
  ctx.strokeStyle = hexA(style.color, ready ? 0.7 : 0.35);
  ctx.lineWidth = 1 / Math.max(scale, 0.3);
  ctx.stroke();
  ctx.fillStyle = hexA(style.color, ready ? 0.95 : 0.6);
  ctx.fillText(text, 0, r * 1.15 + chipH / 2 + 0.5);
  ctx.restore();
  return true;
}

/** Icono vectorial por tipo de pad (sin fuentes ni bitmaps). */
function drawPadGlyph(ctx, type, r, style) {
  ctx.save();
  ctx.strokeStyle = hexA(style.core, 0.95);
  ctx.fillStyle = hexA(style.core, 0.25);
  ctx.lineWidth = Math.max(1, r * 0.16);
  ctx.lineCap = 'round';
  if (type === 'sniper') {
    // Retícula: cruz larga + punto central.
    ctx.beginPath();
    ctx.moveTo(-r, 0);
    ctx.lineTo(r, 0);
    ctx.moveTo(0, -r);
    ctx.lineTo(0, r);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.26, 0, TAU);
    ctx.fill();
    ctx.stroke();
  } else if (type === 'boomer') {
    // Bala pesada: proyectil con aletas.
    ctx.beginPath();
    ctx.moveTo(r, 0);
    ctx.lineTo(-r * 0.6, -r * 0.62);
    ctx.lineTo(-r * 0.25, 0);
    ctx.lineTo(-r * 0.6, r * 0.62);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  } else {
    // Humo: tres bocanadas.
    for (let i = 0; i < 3; i++) {
      ctx.beginPath();
      ctx.arc((i - 1) * r * 0.5, (i % 2 ? -1 : 1) * r * 0.22, r * (0.42 - i * 0.06), 0, TAU);
      ctx.fill();
      ctx.stroke();
    }
  }
  ctx.restore();
}

export function drawWeaponPads(ctx, pads, opts = {}) {
  const list = collectPads(pads);
  for (const pad of list) drawWeaponPad(ctx, pad, opts);
  return list.length;
}

// ─────────────────────────────────────────────────────────────── humo

/**
 * Caché de gradientes de humo por contexto y radio redondeado: a 60 fps con 8
 * nubes y varias copias toroidales no se crea un gradiente por nube y frame.
 */
const fogCache = new WeakMap();

function fogGradient(ctx, r) {
  let perCtx = fogCache.get(ctx);
  if (!perCtx) {
    perCtx = new Map();
    fogCache.set(ctx, perCtx);
  }
  const key = Math.round(r / 4) * 4;
  const cached = perCtx.get(key);
  if (cached) return cached;
  const grad = ctx.createRadialGradient(0, 0, key * 0.15, 0, 0, key);
  grad.addColorStop(0, hexA(SMOKE_STYLE.fog, 0.66));
  grad.addColorStop(0.55, hexA(SMOKE_STYLE.fog, 0.5));
  grad.addColorStop(1, hexA(SMOKE_STYLE.deep, 0));
  perCtx.set(key, grad);
  return grad;
}

/**
 * Nube de humo: disco de niebla con tres bocanadas internas (aspecto orgánico)
 * y aro de disipación. Se dibuja ENCIMA de las entidades (oculta de verdad).
 * `opts`: { time, scale }.
 */
export function drawSmokeCloud(ctx, smoke, opts = {}) {
  const time = num(opts.time, 0);
  const scale = Math.max(0.05, num(opts.scale, 1));
  const r = num(smoke.r, 145);
  const fading = num(smoke.remaining, 0) > 0 ? Math.max(0, Math.min(1, smoke.remaining / 1.2)) : 1;
  ctx.save();
  ctx.translate(smoke.x, smoke.y);
  ctx.globalAlpha = 0.82 * (0.55 + 0.45 * fading);
  ctx.fillStyle = fogGradient(ctx, r);
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, TAU);
  ctx.fill();
  // Bocanadas: tres discos con deriva lenta (nada de ruido por frame).
  ctx.globalAlpha = 0.3 * (0.6 + 0.4 * fading);
  for (let i = 0; i < 3; i++) {
    const a = time * 0.12 + (i * TAU) / 3;
    const dist = r * 0.34;
    ctx.beginPath();
    ctx.arc(Math.cos(a) * dist, Math.sin(a) * dist * 0.7, r * 0.5, 0, TAU);
    ctx.fillStyle = hexA(SMOKE_STYLE.fog, 0.5);
    ctx.fill();
  }
  ctx.globalAlpha = 0.5 * fading;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, TAU);
  ctx.strokeStyle = SMOKE_STYLE.rim;
  ctx.lineWidth = 1.6 / scale;
  ctx.setLineDash([r * 0.12, r * 0.08]);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
  return true;
}

export function drawSmokes(ctx, smokes, opts = {}) {
  const list = collectSmokes(smokes);
  for (const s of list) drawSmokeCloud(ctx, s, opts);
  return list.length;
}

/** Nubes como círculos sueltos para la LOS (mismo formato que el servidor). */
export function smokeCircles(smokes) {
  const list = collectSmokes(smokes);
  return list.map((s) => ({ x: s.x, y: s.y, r: s.r }));
}

/**
 * ¿El humo oculta la línea de visión entre dos puntos? Usa el MISMO
 * `segmentBlocked` (camino corto del toro) que el servidor, con las nubes como
 * círculos. Sin nubes devuelve false (no oculta nada).
 */
export function smokeBlocks(ax, ay, bx, by, smokes, world) {
  const list = collectSmokes(smokes);
  if (list.length === 0) return false;
  if (![ax, ay, bx, by].every(Number.isFinite)) return false;
  return segmentBlocked(ax, ay, bx, by, smokeCircles(list), world);
}

/**
 * ¿Hay que OCULTAR a `target` desde el punto (ax,ay)? Reglas:
 *   · sin nubes nunca se oculta;
 *   · el propio jugador nunca se oculta;
 *   · los aliados derribados NO se ocultan (el aviso de rescate manda);
 *   · el resto queda oculto si una nube corta el segmento.
 */
export function hiddenBySmoke(ax, ay, target, smokes, world, opts = {}) {
  if (!target || !Number.isFinite(ax) || !Number.isFinite(ay)) return false;
  if (opts.self === true) return false;
  if (target.downed === true && opts.ally !== false) return false;
  return smokeBlocks(ax, ay, target.x, target.y, smokes, world);
}

// ─────────────────────────────────────────────────── retícula y carga

/**
 * Retícula de apuntado (LT/L2 o botón derecho). Discreta: anillo pequeño en la
 * dirección de `aimAngle`, dos marcas y arco de carga estable. Se dibuja en
 * unidades de mundo, así que respeta el zoom por defecto sin tocarlo.
 * `opts`: { time, scale, charge01, aimAngle, radius }.
 */
export function drawAimReticle(ctx, p, opts = {}) {
  if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return false;
  const scale = Math.max(0.05, num(opts.scale, 1));
  const time = num(opts.time, 0);
  const charge = Math.max(0, Math.min(1, num(opts.charge01, 0)));
  const angle = num(opts.aimAngle, num(p.aimAngle, num(p.angle, 0)));
  const dist = num(opts.distance, Math.max(SHIP.radius * 6, 90 / scale));

  const cx = p.x + Math.cos(angle) * dist;
  const cy = p.y + Math.sin(angle) * dist;
  const r = num(opts.size, Math.max(9, 12 / scale));

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(angle);
  ctx.strokeStyle = hexA('#e6dcff', 0.8);
  ctx.lineWidth = 1.4 / scale;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, TAU);
  ctx.stroke();
  ctx.beginPath();
  for (const sx of [1, -1]) {
    ctx.moveTo(sx * r * 1.45, 0);
    ctx.lineTo(sx * r * 0.78, 0);
  }
  ctx.moveTo(0, -r * 1.45);
  ctx.lineTo(0, -r * 0.78);
  ctx.moveTo(0, r * 1.45);
  ctx.lineTo(0, r * 0.78);
  ctx.stroke();
  // Carga de disparo estable: arco que se cierra en 0.35 s.
  if (charge > 0) {
    ctx.strokeStyle = charge >= 1 ? '#7ef7c8' : hexA('#ffd166', 0.9);
    ctx.lineWidth = 2 / scale;
    ctx.beginPath();
    ctx.arc(0, 0, r * 1.2, -Math.PI / 2, -Math.PI / 2 + TAU * charge);
    ctx.stroke();
  } else {
    ctx.globalAlpha = 0.35 + 0.2 * Math.sin(time * 4);
    ctx.beginPath();
    ctx.arc(0, 0, r * 1.2, -0.4, 0.4);
    ctx.stroke();
  }
  ctx.restore();

  // Línea guía tenue nave→retícula (no tapa la acción).
  ctx.save();
  ctx.globalAlpha = 0.22;
  ctx.strokeStyle = '#e6dcff';
  ctx.lineWidth = 1 / scale;
  ctx.setLineDash([4 / scale, 6 / scale]);
  ctx.beginPath();
  ctx.moveTo(p.x + Math.cos(angle) * (SHIP.radius + 6), p.y + Math.sin(angle) * (SHIP.radius + 6));
  ctx.lineTo(cx, cy);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
  return true;
}

// ────────────────────────────────────────────────────────────── minimapa

/**
 * Coberturas y pads en el minimapa. Los rectángulos se dibujan como muros
 * (relleno azul acero tenue) y los círculos legacy como puntos: el minimapa
 * enseña la arquitectura de un vistazo sin ensuciar el HUD.
 * `opts`: { sx, sy, pads, smokes, hidden }.
 */
export function drawMinimapWalls(ctx, covers, opts = {}) {
  const list = Array.isArray(covers) ? covers : [];
  const sx = num(opts.sx, 1);
  const sy = num(opts.sy, 1);
  ctx.save();
  ctx.fillStyle = opts.color ?? SMOKE_STYLE.minimap;
  for (const c of list) {
    if (!c) continue;
    const w = num(c.w, 0);
    const h = num(c.h, 0);
    if (w > 0 && h > 0) {
      ctx.fillRect((c.x - w / 2) * sx, (c.y - h / 2) * sy, Math.max(1.4, w * sx), Math.max(1.4, h * sy));
      continue;
    }
    ctx.beginPath();
    ctx.arc(c.x * sx, c.y * sy, Math.max(1.2, Math.min(3, num(c.r, 6) * sx)), 0, TAU);
    ctx.fill();
  }
  ctx.restore();
  return list.length;
}

/** Marcadores de weapon pads en el minimapa (rombo con el color del tipo). */
export function drawMinimapPads(ctx, pads, opts = {}) {
  const list = collectPads(pads);
  const sx = num(opts.sx, 1);
  const sy = num(opts.sy, 1);
  for (const pad of list) {
    const style = PAD_STYLE[pad.type] ?? PAD_STYLE.sniper;
    const x = pad.x * sx;
    const y = pad.y * sy;
    ctx.save();
    ctx.translate(x, y);
    ctx.beginPath();
    ctx.moveTo(0, -3.2);
    ctx.lineTo(3.2, 0);
    ctx.lineTo(0, 3.2);
    ctx.lineTo(-3.2, 0);
    ctx.closePath();
    ctx.fillStyle = hexA(style.core, pad.remaining > 0 ? 0.5 : 0.95);
    ctx.fill();
    ctx.restore();
  }
  return list.length;
}

/** Discos de humo en el minimapa (niebla que también tapa puntos). */
export function drawMinimapSmokes(ctx, smokes, opts = {}) {
  const list = collectSmokes(smokes);
  const sx = num(opts.sx, 1);
  const sy = num(opts.sy, 1);
  ctx.save();
  ctx.fillStyle = SMOKE_STYLE.minimap;
  ctx.globalAlpha = 0.5;
  for (const s of list) {
    ctx.beginPath();
    ctx.arc(s.x * sx, s.y * sy, Math.max(2, s.r * sx * 0.5), 0, TAU);
    ctx.fill();
  }
  ctx.restore();
  return list.length;
}
