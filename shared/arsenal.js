// Orbit Hill v0.2 — arsenal del prototipo Ciudadela (valores del contrato fijo).
// Módulo PURO: lo usan el servidor (autoridad), el cliente (predicción/UI) y los
// tests. No importa nada del servidor ni toca estado de partida.
//
// Nada de lo ya acordado cambia de nombre ni de valor: ARSENAL, SMOKE, BOUNCE y
// AIM son exactamente los del contrato. Lo ÚNICO añadido son los topes y los
// pads del mapa (munición máxima, cooldown de pad y radio de recogida).

export const ARSENAL = Object.freeze({
  // Rifle de francotirador: 60 de daño a la cadera, 110 si el apuntado (LT) ha
  // estado estable `AIM.steadySeconds`. Una bala por disparo, munición de pad.
  sniper: Object.freeze({
    ammo: 6,
    cooldown: 1.35,
    speed: 2100,
    life: 1.1,
    damageAimed: 110,
    damageHip: 60,
  }),
  // Lanzagranadas: 85 de daño en área (135 de radio), 100 a coberturas.
  boomer: Object.freeze({
    ammo: 3,
    cooldown: 1.5,
    speed: 420,
    life: 2,
    damage: 85,
    radius: 135,
    coverDamage: 100,
  }),
});

export const SMOKE = Object.freeze({ ammo: 2, cooldown: 6, life: 6, radius: 145, range: 190, fuse: .5, maxActive: 8 });
export const BOUNCE = Object.freeze({ range: 46, cooldown: .38, speed: 620, duration: .13 });
export const AIM = Object.freeze({ steadySeconds: .35, maxSpeed: 220, turnSpeed: 6.5 });

/**
 * Tope de munición por tipo. Se usa el cargador del arma como tope duro: un
 * pad nunca deja acumular más de una carga completa (sin farm infinito).
 */
export const AMMO_MAX = Object.freeze({
  sniper: ARSENAL.sniper.ammo,
  boomer: ARSENAL.boomer.ammo,
  smoke: SMOKE.ammo,
});

/**
 * Pads de armas del mapa. `type` es el tipo de cobertura del diseño:
 *  - `sniper`: patio superior (munición completa cada 18 s)
 *  - `boomer`: mirador inferior (munición completa cada 24 s)
 *  - `smoke` : ruta lateral (repone 2 granadas cada 18 s)
 * `radius` es el radio de recogida desde el casco de una nave VIVA.
 */
export const PAD = Object.freeze({
  sniper: Object.freeze({ cooldown: 18, ammo: ARSENAL.sniper.ammo, radius: 26 }),
  boomer: Object.freeze({ cooldown: 24, ammo: ARSENAL.boomer.ammo, radius: 26 }),
  smoke: Object.freeze({ cooldown: 18, ammo: SMOKE.ammo, radius: 26 }),
});

export const PAD_TYPES = Object.freeze(Object.keys(PAD));

/** ¿Es un pad conocido? (respaldo seguro para geometría o red corrupta) */
export function padInfo(type) {
  return PAD[type] ?? null;
}
