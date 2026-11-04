// Orbit Hill - indicadores de reaparición (1P, 2P, … / TÚ).
// Módulo puro y sin DOM: el cliente lo usa para pintar sobre las naves humanas
// y los tests verifican el estado y la numeración directamente.
//
// Diseño clave: el estado se deriva de los snapshots (vida + protección), no de
// un evento puntual. Así, si un evento `respawn` se pierde, la insignia sigue
// apareciendo igual, y funciona al inicio de partida, al reaparecer y en la
// entrada tardía.

import { humanBadgeLabel } from './rules.js';

export const SPAWN_BADGE_MS = 3000;

export class SpawnBadges {
  constructor(holdMs = SPAWN_BADGE_MS) {
    this.holdMs = holdMs;
    this.marks = new Map();  // id -> instante en que empezó la insignia
    this.was = new Map();    // id -> ¿estaba viva y protegida en el snapshot previo?
    this.phase = null;       // última fase conocida (para rearmar el flanco)
  }

  /**
   * Alimenta el rastreador con el estado actual.
   * `players`: [{ id, alive, protected, slot, bot }]; `now` en ms.
   * `phase` (opcional): fase del snapshot. La transición a 'playing' rearma el
   * flanco: durante la cuenta atrás la protección no se consume, así que sin
   * este rearme la insignia expiraría justo al empezar a jugar.
   * Sin `phase` el rastreador funciona solo con vida+protección (respawn,
   * entrada tardía).
   */
  update(players, now, phase) {
    if (phase !== undefined && phase !== null) {
      if (phase === 'playing' && this.phase !== 'playing') this.was.clear();
      this.phase = phase;
    }
    const seen = new Set();
    for (const p of players) {
      seen.add(p.id);
      const claimable = !!p.alive && !p.bot && Number.isInteger(p.slot) && p.slot >= 1;
      const freshly = claimable && p.protected > 0;
      if (freshly && !this.was.get(p.id)) this.marks.set(p.id, now);
      this.was.set(p.id, freshly);
      if (!claimable) this.marks.delete(p.id);
    }
    for (const id of [...this.marks.keys()]) if (!seen.has(id)) this.marks.delete(id);
    for (const id of [...this.was.keys()]) if (!seen.has(id)) this.was.delete(id);
    return this;
  }

  /** Progreso 1 -> 0 de la insignia, o null si no está activa. */
  progress(id, now) {
    const mark = this.marks.get(id);
    if (mark == null) return null;
    const t = (now - mark) / this.holdMs;
    return t >= 1 || t < 0 ? null : t;
  }

  active(id, now) {
    return this.progress(id, now) != null;
  }

  /** Etiqueta a pintar ('TÚ' para la propia nave, 'nP' para el resto). */
  label(id, selfId, slot) {
    return humanBadgeLabel(slot, id === selfId);
  }

  clear() {
    this.marks.clear();
    this.was.clear();
    this.phase = null;
  }
}
