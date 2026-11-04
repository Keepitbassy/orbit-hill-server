// Contrato compartido del prototipo táctico (LAB TÁCTICO).
//
// Módulo PURO: lo usan el servidor (autoridad) y los tests. No importa nada del
// servidor ni toca estado de partida.
//
// Cuatro piezas del prototipo:
//   1. escopeta de plasma (perdigones, corto alcance)
//   2. esquiva lateral (dash relativo a la orientación)
//   3. coberturas estáticas destructibles
//   4. derribo / rescate
//
// `TACTICAL` conserva los valores del contrato original (pellets, daño, vida,
// cooldown, spread, velocidad/cooldown de dash, hp/radio de cobertura y
// tiempos de derribo). Se le añaden SOLO topes de seguridad para que los buffs
// no multipliquen el daño a niveles absurdos; ningún valor existente cambia.

import { HILL, WORLD, SPAWN_AREA, WEAPON_DEFAULT, WEAPONS } from './constants.js';
import { mulberry32, torusDistance } from './physics.js';
import { spawnArea } from './rules.js';

export const TACTICAL = Object.freeze({
  shotgun: Object.freeze({
    pellets: 7,
    damage: 16,
    speed: 840,
    life: .36,
    cooldown: .85,
    spread: .12,
    // Topes adicionales (no forman parte del contrato original):
    maxLive: 14,       // perdigones vivos por jugador (≈2 voleas completas)
    maxPellets: 9,     // tope duro por disparo (7 + bonus de buff)
    rapidFactor: .65,  // el disparo rápido acorta el cooldown, no lo divide
    spreadBonus: 2,    // el triple disparo suma 2 perdigones, no lo triplica
  }),
  dash: Object.freeze({ speed: 520, cooldown: 2.6, duration: .22 }),
  cover: Object.freeze({
    count: 12,
    radius: 62,
    hp: 320,
    margin: 40,          // colchón respecto al muro (nunca pegado al borde)
    spawnClearance: 200, // radio extra libre alrededor del spawn de cada equipo
    hillClearance: 40,   // colchón extra sobre el radio de la colina
    minGap: 2.2,         // separación mínima entre coberturas (× radio)
  }),
  downed: Object.freeze({
    seconds: 12,
    hp: 50,
    reviveSeconds: 2.5,
    reviveRadius: 90,
    reviveHp: 45,
    speed: 70,
    reviveProtect: 1.5, // protección breve tras el rescate
  }),
});

/** ¿El modo pertenece al perfil táctico? Se combina SIEMPRE con el perfil. */
export const isTacticalMode = mode => mode === 'koth' || mode === 'tdm' || mode === 'chaos';

/**
 * Perfil táctico efectivo: hace falta el perfil (`tacticalProfile`) Y un modo
 * táctico. FFA y arcade conservan sus reglas clásicas aunque el perfil esté
 * activado, porque `tac.on` nunca debe mentir al cliente.
 */
export function tacticalActive(profile, mode) {
  return profile === true && isTacticalMode(mode);
}

/** Armas válidas (lista canónica compartida con `sanitizeWeapon`). */
export { WEAPONS, WEAPON_DEFAULT };

/**
 * Rejilla determinista de coberturas para un mundo y una semilla.
 * Devuelve [{x,y}] con como máximo `count` posiciones, equilibradas:
 *  - nunca en la zona de aparición de ningún equipo
 *  - nunca encima de la colina (centro + radio + colchón)
 *  - separadas entre sí (> 2×radio mientras se pueda) y con colchón al muro
 * Todo es toroidal (distancias del toro) y reproducible: la misma semilla +
 * arena dan siempre exactamente el mismo reparto.
 */
export function coverLayout(world, seed, opts = {}) {
  const w = world ?? WORLD;
  const count = Math.max(0, opts.count ?? TACTICAL.cover.count);
  const radius = opts.radius ?? TACTICAL.cover.radius;
  const margin = opts.margin ?? TACTICAL.cover.margin;
  const spawnClearance = radius + (opts.spawnClearance ?? TACTICAL.cover.spawnClearance);
  const hillClearance = radius + HILL.radius + (opts.hillClearance ?? TACTICAL.cover.hillClearance);
  if (count === 0) return [];

  const rnd = mulberry32((seed >>> 0) ^ 0x9e3779b9);
  const pad = radius + margin;
  const minX = Math.min(pad, w.w / 2);
  const maxX = Math.max(w.w - pad, w.w / 2);
  const minY = Math.min(pad, w.h / 2);
  const maxY = Math.max(w.h - pad, w.h / 2);

  // Rejilla con jitter determinista: reparte el mapa sin amontonar nada.
  const cols = 8;
  const rows = 5;
  const cellW = (maxX - minX) / cols;
  const cellH = (maxY - minY) / rows;
  const candidates = [];
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      const cx = minX + (i + 0.5) * cellW;
      const cy = minY + (j + 0.5) * cellH;
      candidates.push({
        x: cx + (rnd() - 0.5) * cellW * 0.6,
        y: cy + (rnd() - 0.5) * cellH * 0.6,
      });
    }
  }

  const spawns = [spawnArea('cyan', w) ?? defaultSpawn('cyan', w), spawnArea('coral', w) ?? defaultSpawn('coral', w)];
  const center = { x: w.w / 2, y: w.h / 2 };
  const free = candidates.filter((c) => {
    for (const s of spawns) {
      if (!s) continue;
      if (torusDistance(c.x, c.y, s.x, s.y, w) < spawnClearance) return false;
    }
    if (torusDistance(c.x, c.y, center.x, center.y, w) < hillClearance) return false;
    return true;
  });
  free.sort((a, b) => compareCandidates(a, b, center, w));

  // Muestreo "farthest-point" con separación mínima. El pool se filtra TRAS
  // CADA elección: nunca se coloca una cobertura que solape a otra ya puesta.
  // Si la arena es pequeña, la exigencia se relaja por tramos, jamás por
  // debajo del diámetro (2×radio).
  const baseGap = radius * (opts.minGap ?? TACTICAL.cover.minGap);
  let chosen = [];
  for (const gap of [baseGap, baseGap * 0.85, radius * 2 + 4, radius * 2]) {
    chosen = [];
    const remaining = free.slice();
    while (chosen.length < count && remaining.length > 0) {
      let bestIdx = -1;
      let bestScore = -1;
      for (let k = 0; k < remaining.length; k++) {
        const c = remaining[k];
        let near = Infinity;
        for (const p of chosen) near = Math.min(near, torusDistance(c.x, c.y, p.x, p.y, w));
        if (chosen.length > 0 && near < gap) continue; // filtrado tras cada elección
        const score = chosen.length === 0 ? Infinity : near;
        if (score > bestScore + 1e-9) {
          bestScore = score;
          bestIdx = k;
        }
      }
      if (bestIdx < 0) break;
      chosen.push(remaining.splice(bestIdx, 1)[0]);
    }
    if (chosen.length >= count) break;
  }
  return chosen.slice(0, count).map((c) => ({ x: c.x, y: c.y }));
}

/** Orden determinista: primero lo más lejano al centro, luego x, luego y. */
function compareCandidates(a, b, center, world) {
  const da = torusDistance(a.x, a.y, center.x, center.y, world);
  const db = torusDistance(b.x, b.y, center.x, center.y, world);
  if (Math.abs(da - db) > 1e-9) return db - da;
  if (Math.abs(a.x - b.x) > 1e-9) return a.x - b.x;
  return a.y - b.y;
}

/** Zona de aparición reescalada (respaldo si `spawnArea` no la conoce). */
function defaultSpawn(team, world) {
  const base = SPAWN_AREA[team];
  if (!base) return null;
  return { x: (base.x / WORLD.w) * world.w, y: (base.y / WORLD.h) * world.h };
}
