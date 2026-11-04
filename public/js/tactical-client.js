// Orbit Hill — LAB TÁCTICO: parser del snapshot `tac` y utilidades de control.
//
// Módulo puro (sin DOM) para poder probarlo en Node. La autoridad es SIEMPRE
// del servidor: aquí solo se normaliza lo que llega y se sanea la INTENCIÓN que
// el cliente envía (weapon / dash / interact / aim / move / smoke / bounce /
// model). Ninguna posición, vida ni munición viaja desde el cliente.
//
// Contrato de snapshot v1 (índices fijos, sin tocar los existentes):
//   snap.tac = {
//     on: boolean,                                     // perfil táctico ∧ koth|tdm
//     ps: [[id, weapon, dashCd, downedRemaining, reviveProgress, downedHp]],
//     cs: [[id, x, y, r, hp, maxHp]],
//   }
//   snap.bs[i][6] = kind 'auto' | 'plasma' (respaldo 'auto')
//
// Extensión v2 (ADITIVA, misma filosofía: los índices viejos no cambian):
//   snap.tac.map = 'citadel' | 'orbit'
//   snap.tac.wp  = [[id, x, y, type, remaining]]                 type: sniper|boomer|smoke
//   snap.tac.sm  = [[id, x, y, r, remaining, team]]              nubes de humo
//   snap.tac.ps  = [... , 6:model, 7:aiming, 8:ammoSniper, 9:ammoBoomer,
//                       10:smokeAmmo, 11:bounceCd, 12:aimCharge01]
//   snap.tac.cs  = [... , 6:w, 7:h, 8:kind 'wall'|'block'|'hex']
//
// Extensión v3 (ADITIVA): snap.tac.dashCooldown = número [0,10]. Es el
// cooldown AUTORITATIVO de la sala (0 = evasión sin espera). Si el servidor
// todavía no manda el campo, la vista conserva el 2,6 s legacy.
//
// Regla de compatibilidad (idéntica a la del servidor): si una fila NO trae los
// índices nuevos se trata como la fila v1 — un `cs` de 6 campos sigue siendo un
// círculo y un `ps` de 6 campos no inventa arma especial ni munición. Así los
// tests históricos del prototipo siguen pasando sin tocar el contrato viejo.
//
// Si el servidor todavía no manda `tac` (backend en implementación) el parser
// devuelve un estado apagado y vacío: "gracefully missing", nunca lanza.

import { TACTICAL, isTacticalMode } from '../../shared/tactical.js';
import { BATTLEFIELDS, sanitizeBattlefield } from '../../shared/battlefield.js';
import { SHIP_DEFAULT, SHIP_MODELS, sanitizeShipModel } from '../../shared/ships.js';
import { ARSENAL, SMOKE, BOUNCE, AIM } from '../../shared/arsenal.js';
import { sanitizeFlight } from '../../shared/flight-profiles.js';

/** Armas base del prototipo v1 (siempre disponibles, sin munición). */
export const WEAPONS = Object.freeze(['auto', 'plasma']);
/** Catálogo completo v2: las especiales salen de los pads del mapa. */
export const ALL_WEAPONS = Object.freeze(['auto', 'plasma', 'sniper', 'boomer']);
export const DEFAULT_WEAPON = 'auto';

/** Tipos de pad del mapa (mismos identificadores que shared/battlefield.js). */
export const PAD_TYPES = Object.freeze(['sniper', 'boomer', 'smoke']);
export const PAD_LABEL = Object.freeze({ sniper: 'SNIPER', boomer: 'BOOMER', smoke: 'HUMO' });
/** Distancia (centro a centro) con la que el HUD avisa de un pad cercano. */
export const PAD_PROMPT_RANGE = 140;

/** Modelos cosméticos (la lista es la fuente compartida, nunca una copia). */
export const MODELS = SHIP_MODELS;
export { SHIP_DEFAULT, sanitizeShipModel };

/** Campo del snapshot `ps` que guarda la munición de cada arma especial. */
export const AMMO_FIELD = Object.freeze({ sniper: 'ammoSniper', boomer: 'ammoBoomer' });

/** Topes de munición de cada arma especial (del contrato compartido). */
export const AMMO_MAX = Object.freeze({
  sniper: Math.max(1, Math.round(ARSENAL?.sniper?.ammo ?? 6)),
  boomer: Math.max(1, Math.round(ARSENAL?.boomer?.ammo ?? 3)),
  smoke: Math.max(1, Math.round(SMOKE?.ammo ?? 2)),
});

/** Parámetros de puntería usados por el HUD (contrato compartido). */
export const AIM_CONTRACT = Object.freeze({
  turnSpeed: Number(AIM?.turnSpeed) || 6.5,
  maxSpeed: Number(AIM?.maxSpeed) || 220,
  steadySeconds: Number(AIM?.steadySeconds) || 0.35,
});
export const BOUNCE_CONTRACT = Object.freeze({
  cooldown: Number(BOUNCE?.cooldown) || 0.38,
  range: Number(BOUNCE?.range) || 46,
});

/** Cooldown de esquiva que conserva la API legacy (2,6 s del contrato). */
export const DASH_COOLDOWN_FALLBACK = Number(TACTICAL?.dash?.cooldown) || 2.6;
/** Tope del campo numérico que puede anunciar el servidor (0…10 s). */
export const DASH_COOLDOWN_MAX = 10;

/**
 * Sanea el cooldown autoritativo de una sala. Es ADITIVO: un snapshot legacy
 * sin `dashCooldown` conserva el 2,6 s de siempre. Un valor no finito cae al
 * respaldo; fuera de [0,10] se acota. Cero es un valor VÁLIDO (sin espera).
 */
export function sanitizeDashCooldown(value, fallback = DASH_COOLDOWN_FALLBACK) {
  const base = Number(fallback);
  const safeFallback = Number.isFinite(base)
    ? Math.max(0, Math.min(DASH_COOLDOWN_MAX, base))
    : DASH_COOLDOWN_FALLBACK;
  // null/booleanos/objetos no son un número de servidor: respaldo, nunca 0.
  if (typeof value !== 'number' && typeof value !== 'string') return safeFallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return safeFallback;
  return n < 0 ? 0 : n > DASH_COOLDOWN_MAX ? DASH_COOLDOWN_MAX : n;
}

/**
 * Estado del HUD/dial de esquiva. Con cooldown 0 la barra está SIEMPRE al
 * 100 % y el texto es «SIN ESPERA»: la autoridad del servidor decide el
 * impulso, aquí solo se pinta. Nunca produce NaN/Infinity (tampoco con 0).
 */
export function dashState(player, cooldown = DASH_COOLDOWN_FALLBACK) {
  const max = sanitizeDashCooldown(cooldown);
  const remaining = Math.max(0, finite(player?.dashCd, 0));
  if (max <= 0) {
    return {
      zero: true,
      cooldown: 0,
      remaining: 0,
      ready: true,
      fraction: 1,
      text: 'SIN ESPERA',
    };
  }
  const fraction = clamp01(1 - remaining / max);
  const ready = remaining <= 0.02;
  return {
    zero: false,
    cooldown: max,
    remaining,
    ready,
    fraction: ready ? 1 : fraction,
    text: ready ? 'LISTO' : `${remaining.toFixed(1)}s`,
  };
}

export const WEAPON_INFO = Object.freeze({
  auto: Object.freeze({
    label: 'Cañón automático',
    short: 'AUTO',
    key: '1',
    hint: 'Cadencia rápida, daño por impacto. Alcance completo y munición ilimitada.',
  }),
  plasma: Object.freeze({
    label: 'Escopeta plasma',
    short: 'PLASMA',
    key: '2',
    hint: `${TACTICAL.shotgun.pellets} perdigones de corto alcance (vida ${TACTICAL.shotgun.life}s). Munición ilimitada.`,
  }),
  sniper: Object.freeze({
    label: 'Rifle de precisión',
    short: 'SNIPER',
    key: '3',
    cadence: Number(ARSENAL?.sniper?.cooldown) || 1.35,
    hint: `${ARSENAL?.sniper?.damageHip ?? 60} de cadera · ${ARSENAL?.sniper?.damageAimed ?? 110} con puntería fija (${AIM_CONTRACT.steadySeconds}s). Se recoge en el mapa.`,
  }),
  boomer: Object.freeze({
    label: 'Lanzador explosivo',
    short: 'BOOMER',
    key: '4',
    cadence: Number(ARSENAL?.boomer?.cooldown) || 1.5,
    hint: `${ARSENAL?.boomer?.damage ?? 85} de daño en ${ARSENAL?.boomer?.radius ?? 135} de radio y ${ARSENAL?.boomer?.coverDamage ?? 100} a coberturas (no las derriba de un golpe). Se recoge en el mapa.`,
  }),
});

export const DASH_LABEL = Object.freeze({ '-1': 'izquierda', 0: 'neutro', 1: 'derecha' });

/** Fila neutra para un jugador sin datos tácticos (nunca compartida). */
export function neutralTactical() {
  return {
    weapon: DEFAULT_WEAPON,
    dashCd: 0,
    downed: false,
    downedRemaining: 0,
    reviveProgress: 0,
    downedHp: 0,
    // ── v2 (aditivo): sin datos = cosmético por defecto, sin munición, sin puntería.
    model: SHIP_DEFAULT,
    aiming: false,
    ammoSniper: 0,
    ammoBoomer: 0,
    smokeAmmo: 0,
    bounceCd: 0,
    aimCharge01: 0,
  };
}

const finite = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const clamp01 = (value) => {
  const n = finite(value, 0);
  return n < 0 ? 0 : n > 1 ? 1 : n;
};

const clampAxis = (value) => {
  const n = finite(value, 0);
  return n < -1 ? -1 : n > 1 ? 1 : n;
};

const count = (value) => Math.max(0, Math.floor(finite(value, 0)));

/** Normaliza un arma al catálogo v2 (respaldo 'auto'). */
export function normalizeWeapon(raw, fallback = DEFAULT_WEAPON) {
  return ALL_WEAPONS.includes(raw) ? raw : fallback;
}

/** El arma base contraria (botón/toggle clásico: □/X sin datos de munición). */
export function toggleWeapon(current) {
  return normalizeWeapon(current) === 'plasma' ? 'auto' : 'plasma';
}

/** ¿El arma gasta munición de pad? `null` = nunca (auto/plasma). */
export function ammoKey(weapon) {
  return AMMO_FIELD[normalizeWeapon(weapon)] ?? null;
}

/** Munición disponible de un arma para un jugador (null = ilimitada). */
export function ammoOf(player, weapon) {
  const key = ammoKey(weapon);
  return key ? count(player?.[key]) : null;
}

/** ¿Se puede equipar el arma? Las especiales exigen munición > 0. */
export function weaponAvailable(player, weapon) {
  const key = ammoKey(weapon);
  if (!key) return ALL_WEAPONS.includes(weapon);
  return count(player?.[key]) > 0;
}

/** Tope de munición del arma (para pintar el contador). null = ilimitada. */
export function ammoMax(weapon) {
  // OJO: `ammoKey` devuelve el CAMPO del jugador (`ammoSniper`), mientras que
  // `AMMO_MAX` está indexado por ARMA (`sniper`). Mezclarlos daba `null` en el
  // tooltip del HUD ("SNIPER 0/null").
  const id = normalizeWeapon(weapon);
  if (!AMMO_FIELD[id]) return null;
  return AMMO_MAX[id] ?? null;
}

/**
 * Siguiente arma DISPONIBLE ciclando el catálogo completo.
 * `□/X` nunca deja el arma en una especial sin munición: si no hay ninguna
 * disponible se queda en la que está (o en `auto` si la actual tampoco vale).
 */
export function cycleAvailableWeapon(current, player) {
  const now = normalizeWeapon(current);
  const start = ALL_WEAPONS.indexOf(now);
  for (let i = 1; i <= ALL_WEAPONS.length; i++) {
    const candidate = ALL_WEAPONS[(start + i) % ALL_WEAPONS.length];
    if (weaponAvailable(player, candidate)) return candidate;
  }
  return weaponAvailable(player, now) ? now : DEFAULT_WEAPON;
}

export function weaponInfo(raw) {
  return WEAPON_INFO[normalizeWeapon(raw, 'auto')] ?? WEAPON_INFO.auto;
}

/** Rótulo legible de un modelo cosmético (nunca lanza con basura). */
export function modelLabel(raw) {
  const id = sanitizeShipModel(raw) ?? SHIP_DEFAULT;
  return MODELS.find((m) => m.id === id)?.label ?? id;
}

/** ¿Este modo usa las reglas tácticas (rey de la colina / combate por equipos)? */
export function tacticalMode(mode) {
  return isTacticalMode(mode);
}

/** Ángulo de apuntado saneado: finito y envuelto a (-π, π]. */
export function sanitizeAimAngle(value) {
  const n = finite(value, 0);
  if (!Number.isFinite(n)) return 0;
  const TAU = Math.PI * 2;
  let a = n % TAU;
  if (a > Math.PI) a -= TAU;
  if (a <= -Math.PI) a += TAU;
  return Object.is(a, -0) ? 0 : a;
}

/**
 * Sanea la intención táctica v1 del cliente (3 campos exactos: la API histórica
 * no crece; el resto de la v2 vive en `sanitizeInputIntent`).
 */
export function sanitizeTacticalIntent(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    weapon: normalizeWeapon(source.weapon),
    dash: source.dash === 1 ? 1 : source.dash === -1 ? -1 : 0,
    interact: source.interact === true,
  };
}

/** Claves EXACTAS que viajan en el mensaje `input` (nada de estado forjado). */
export const INPUT_INTENT_KEYS = Object.freeze([
  'rot', 'thrust', 'brake', 'fire', 'boost',
  'weapon', 'dash', 'interact',
  'aim', 'aimAngle', 'moveX', 'moveY',
  'smoke', 'bounce', 'model',
]);

const intents = (raw) => {
  if (raw && typeof raw === 'object') return raw;
  // El input táctico anidado (v1) se acepta como fuente, nunca como contrato.
  return {};
};

/**
 * Sanea la intención COMPLETA v2 del mensaje `input`.
 * Devuelve exactamente las claves de INPUT_INTENT_KEYS: cualquier campo de
 * estado (x, y, hp, score, ammo…) se descarta aquí y el servidor hace lo mismo.
 */
export function sanitizeInputIntent(raw = {}) {
  const source = intents(raw);
  return {
    rot: Math.max(-1, Math.min(1, Math.trunc(finite(source.rot, 0)))),
    thrust: source.thrust === true,
    brake: source.brake === true,
    fire: source.fire === true,
    boost: source.boost === true,
    weapon: normalizeWeapon(source.weapon),
    dash: source.dash === 1 ? 1 : source.dash === -1 ? -1 : 0,
    interact: source.interact === true,
    aim: source.aim === true,
    aimAngle: sanitizeAimAngle(source.aimAngle),
    moveX: clampAxis(source.moveX),
    moveY: clampAxis(source.moveY),
    smoke: source.smoke === true,
    bounce: source.bounce === true,
    model: sanitizeShipModel(source.model) ?? SHIP_DEFAULT,
    ...(Number.isSafeInteger(source.dashId) && source.dashId >= 0 ? { dashId: source.dashId } : {}),
    ...(sanitizeFlight(source.flight) ? { flight: sanitizeFlight(source.flight) } : {}),
  };
}

/** Mensaje de intención con `seq` (el servidor siempre responde con su verdad). */
export function inputWireIntent(raw = {}, seq = 0) {
  const payload = { t: 'input', seq: Math.max(0, Math.trunc(finite(seq, 0))) };
  return { ...payload, ...sanitizeInputIntent(raw) };
}

/**
 * Campos tácticos v1 para el mensaje `input`.
 * Con el perfil táctico apagado se manda un valor NEUTRO explícito (nunca una
 * acción inválida) para que el servidor suelte cualquier intención anterior.
 */
export function tacticalWireIntent({ tactical = false, weapon, dash = 0, interact = false } = {}) {
  if (!tactical) return { weapon: DEFAULT_WEAPON, dash: 0, interact: false };
  return sanitizeTacticalIntent({ weapon, dash, interact });
}

/** Dirección de esquiva a partir del eje horizontal del stick derecho (o teclas). */
export function dashFromAxis(value, deadzone = 0.35) {
  const n = finite(value, 0);
  const zone = Math.abs(finite(deadzone, 0.35));
  if (n > zone) return 1;
  if (n < -zone) return -1;
  return 0;
}

/** Combina varias fuentes de esquiva (teclado > táctil > mando). */
export function combineDash(...values) {
  for (const value of values) {
    const dash = value === 1 ? 1 : value === -1 ? -1 : 0;
    if (dash !== 0) return dash;
  }
  return 0;
}

/** Primera fuente con acción para el rescate sostenido. */
export function combineInteract(...values) {
  return values.some((value) => value === true);
}

/**
 * Fila de jugador táctico, o null si la fila es inservible.
 * Con 7+ campos se añaden los del contrato v2; con 6 se conserva la forma v1
 * exacta (los campos ausentes se leen desde `neutralTactical()` en la vista).
 */
export function parseTacticalPlayer(row) {
  if (!Array.isArray(row) || row.length < 1) return null;
  const id = row[0];
  if (typeof id !== 'string' || id.length === 0) return null;
  const downedRemaining = Math.max(0, finite(row[3], 0));
  const parsed = {
    id,
    weapon: normalizeWeapon(row[1]),
    dashCd: Math.max(0, finite(row[2], 0)),
    downedRemaining,
    downed: downedRemaining > 0,
    reviveProgress: clamp01(row[4]),
    downedHp: Math.max(0, finite(row[5], 0)),
  };
  if (row.length > 6) {
    parsed.model = sanitizeShipModel(row[6]) ?? SHIP_DEFAULT;
    parsed.aiming = row[7] === true;
    parsed.ammoSniper = count(row[8]);
    parsed.ammoBoomer = count(row[9]);
    parsed.smokeAmmo = count(row[10]);
    parsed.bounceCd = Math.max(0, finite(row[11], 0));
    parsed.aimCharge01 = clamp01(row[12]);
  }
  return parsed;
}

/**
 * Cobertura estática destruible {id,x,y,r,hp,maxHp}.
 * Con 7+ campos incorpora el rectángulo axis-aligned del contrato v2:
 * `w`/`h` > 0 es RECTÁNGULO (la `r` es solo radio envolvente para minimapa y
 * evitado de colina); sin ellos sigue siendo un círculo clásico.
 */
export function parseTacticalCover(row) {
  if (!Array.isArray(row) || row.length < 4) return null;
  const id = row[0];
  if (id === null || id === undefined) return null;
  const hp = Math.max(0, finite(row[4], 0));
  const maxHp = Math.max(0, finite(row[5], Math.max(hp, TACTICAL.cover.hp)));
  const r = Math.max(1, finite(row[3], TACTICAL.cover.radius));
  const parsed = { id, x: finite(row[1], 0), y: finite(row[2], 0), r, hp, maxHp };
  if (row.length > 6) {
    parsed.w = Math.max(0, finite(row[6], 0));
    parsed.h = Math.max(0, finite(row[7], 0));
    const kind = row[8];
    parsed.kind = kind === 'wall' || kind === 'block' || kind === 'hex'
      ? kind
      : parsed.w > 0 && parsed.h > 0 ? 'block' : 'hex';
  }
  return parsed;
}

/** ¿La cobertura es un rectángulo (w y h positivos)? */
export function coverIsRect(cover) {
  return Number(cover?.w) > 0 && Number(cover?.h) > 0;
}

/** Caja del rectángulo axis-aligned de una cobertura, o null si es circular. */
export function coverBox(cover) {
  if (!coverIsRect(cover)) return null;
  return {
    x0: finite(cover.x, 0) - cover.w / 2,
    y0: finite(cover.y, 0) - cover.h / 2,
    x1: finite(cover.x, 0) + cover.w / 2,
    y1: finite(cover.y, 0) + cover.h / 2,
  };
}

/** Pad de arma del mapa: {id,x,y,type,remaining} o null si la fila es basura. */
export function parseWeaponPad(row) {
  if (!Array.isArray(row) || row.length < 4) return null;
  const id = row[0];
  if (id === null || id === undefined || (typeof id !== 'number' && typeof id !== 'string')) return null;
  const type = PAD_TYPES.includes(row[3]) ? row[3] : null;
  if (!type) return null;
  return {
    id,
    x: finite(row[1], 0),
    y: finite(row[2], 0),
    type,
    remaining: Math.max(0, finite(row[4], 0)),
  };
}

/** Nube de humo activa: {id,x,y,r,remaining,team}. */
export function parseSmoke(row) {
  if (!Array.isArray(row) || row.length < 5) return null;
  const id = row[0];
  if (id === null || id === undefined || (typeof id !== 'number' && typeof id !== 'string')) return null;
  return {
    id,
    x: finite(row[1], 0),
    y: finite(row[2], 0),
    r: Math.max(1, finite(row[3], SMOKE?.radius ?? 145)),
    remaining: Math.max(0, finite(row[4], 0)),
    team: typeof row[5] === 'string' ? row[5] : null,
  };
}

/** Índice 6 de la fila de bala: kind de las armas del arsenal v2. */
export function parseBulletKind(row) {
  const raw = Array.isArray(row) ? row[6] : undefined;
  return ALL_WEAPONS.includes(raw) ? raw : 'auto';
}

/**
 * Convierte el bloque `tac` del snapshot en la vista del cliente.
 * `on` solo es verdadero con perfil táctico Y modo koth/tdm. El mapa
 * (`map`) es un dato de sala: se lee incluso con el perfil apagado.
 */
export function parseTactical(raw, { mode } = {}) {
  const on = raw?.on === true && tacticalMode(mode);
  const players = new Map();
  const covers = [];
  const weaponPads = [];
  const smokes = [];
  const map = sanitizeBattlefield(raw?.map);
  // v3 aditivo: solo se lee si el campo EXISTE (legacy = 2,6 s intacto).
  const hasDashCooldown = !!raw && typeof raw === 'object' &&
    Object.prototype.hasOwnProperty.call(raw, 'dashCooldown');
  const dashCooldown = hasDashCooldown
    ? sanitizeDashCooldown(raw.dashCooldown)
    : DASH_COOLDOWN_FALLBACK;
  if (on) {
    if (Array.isArray(raw?.ps)) {
      for (const row of raw.ps) {
        const parsed = parseTacticalPlayer(row);
        if (parsed) players.set(parsed.id, parsed);
      }
    }
    if (Array.isArray(raw?.cs)) {
      for (const row of raw.cs) {
        const parsed = parseTacticalCover(row);
        if (parsed) covers.push(parsed);
      }
    }
    if (Array.isArray(raw?.wp)) {
      for (const row of raw.wp) {
        const parsed = parseWeaponPad(row);
        if (parsed) weaponPads.push(parsed);
      }
    }
    if (Array.isArray(raw?.sm)) {
      for (const row of raw.sm) {
        const parsed = parseSmoke(row);
        if (parsed) smokes.push(parsed);
      }
    }
  }
  return { on, players, covers, map, weaponPads, smokes, dashCooldown };
}

/** Estado táctico vacío (perfil apagado) reutilizable por el cliente. */
export function emptyTactical() {
  return {
    on: false,
    players: new Map(),
    covers: [],
    map: null,
    weaponPads: [],
    smokes: [],
    dashCooldown: DASH_COOLDOWN_FALLBACK,
  };
}

/** Entrada táctica de un jugador dentro de una vista táctica (o neutra). */
export function tacticalOf(tac, id) {
  const found = tac?.players?.get?.(id);
  return found ? { ...neutralTactical(), ...found } : neutralTactical();
}

/** Etiqueta de mapa legible ('Ciudadela orbital' / 'Órbita abierta'), o ''. */
export function battlefieldLabel(id) {
  const safe = sanitizeBattlefield(id);
  return BATTLEFIELDS.find((b) => b.id === safe)?.label ?? '';
}

/**
 * Filas del HUD compacto de armas: las cuatro del arsenal con su munición.
 * Las especiales sin munición van `available: false` (el HUD las apaga y el
 * bucle de armas las salta).
 */
export function weaponHudRows(player) {
  return ALL_WEAPONS.map((id) => {
    const info = weaponInfo(id);
    const ammo = ammoOf(player, id);
    return {
      id,
      short: info.short,
      label: info.label,
      key: info.key,
      hint: info.hint,
      ammo,
      ammoMax: ammoMax(id),
      available: weaponAvailable(player, id),
      special: ammo !== null,
    };
  });
}

/** Chip de cargas de humo: '2' con reserva, '0' agotado. */
export function smokeRail(player) {
  const ammo = Math.min(count(player?.smokeAmmo), AMMO_MAX.smoke);
  return { ammo, max: AMMO_MAX.smoke, text: `${ammo}/${AMMO_MAX.smoke}` };
}

/** Estado de puntería estable: 0..1 según `aimCharge01` del servidor. */
export function aimState(player) {
  const charge = clamp01(player?.aimCharge01);
  return {
    on: player?.aiming === true,
    charge,
    steady: player?.aiming === true && charge >= 1,
    text: player?.aiming === true ? (charge >= 1 ? 'PUNTERÍA FIJA' : `FIJANDO ${Math.round(charge * 100)}%`) : '',
  };
}

/** Cooldown del rebote en pared: {ready, remaining, fraction}. */
export function bounceState(player) {
  const cd = Math.max(0, finite(player?.bounceCd, 0));
  return {
    ready: cd <= 0,
    remaining: cd,
    fraction: clamp01(1 - cd / BOUNCE_CONTRACT.cooldown),
    text: cd > 0 ? `${cd.toFixed(1)}s` : 'LISTO',
  };
}

/**
 * Pad de arma más cercano dentro del rango de aviso (toro real del mundo).
 * Solo avisa a un piloto VIVO: derribado no se recoge nada.
 */
export function nearestPad(pads, self, world, distance, range = PAD_PROMPT_RANGE) {
  if (!Array.isArray(pads) || !self || self.downed || self.alive === false) return null;
  if (typeof distance !== 'function') return null;
  let best = null;
  for (const pad of pads) {
    if (!pad || typeof pad.type !== 'string') continue;
    const dist = distance(self.x, self.y, pad.x, pad.y, world);
    if (!Number.isFinite(dist) || dist > range) continue;
    if (!best || dist < best.dist) best = { ...pad, dist };
  }
  return best;
}

/** Texto del aviso de pad cercano ('' si no hay ninguno). */
export function padPromptText(pad) {
  if (!pad) return '';
  const label = PAD_LABEL[pad.type] ?? 'PAD';
  return `${label} CERCA · ACÉRCATE PARA RECOGER`;
}

/** Mapa del HUD ('CIUDADELA') a partir del id de battlefield. */
export function battlefieldChip(id) {
  const label = battlefieldLabel(id);
  return label ? label.split(' ')[0].toUpperCase() : '';
}

/**
 * Compañero derribado rescatable más cercano (mismo equipo y dentro del radio
 * del contrato). `distance(ax, ay, bx, by, world)` permite usar el toro real.
 */
export function nearestReviveTarget(players, self, world, distance) {
  if (!Array.isArray(players) || !self || typeof distance !== 'function') return null;
  let best = null;
  for (const p of players) {
    if (!p || !p.downed || p.id === self.id) continue;
    if (p.team !== self.team) continue;
    const dist = distance(self.x, self.y, p.x, p.y, world);
    if (!Number.isFinite(dist) || dist > TACTICAL.downed.reviveRadius) continue;
    if (!best || dist < best.dist) {
      best = { id: p.id, x: p.x, y: p.y, dist, progress: clamp01(p.reviveProgress) };
    }
  }
  return best;
}

/** Texto del HUD cuando la propia nave está derribada (nunca "respawn 3s"). */
export function downedStatusText(entry) {
  const remaining = Math.max(0, finite(entry?.downedRemaining, 0));
  const progress = clamp01(entry?.reviveProgress);
  if (progress > 0) return `RESCATANDO… ${Math.round(progress * 100)}%`;
  return `DERRIBADO · ${Math.ceil(remaining)}s`;
}

/** Texto del HUD cuando hay un compañero derribado cerca y podemos rescatar. */
export function reviveStatusText(target) {
  if (!target) return '';
  const progress = clamp01(target.progress);
  if (progress > 0) return `RESCATE ${Math.round(progress * 100)}%`;
  return 'MANTÉN F PARA RESCATAR';
}
