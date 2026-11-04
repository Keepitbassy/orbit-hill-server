// Orbit Hill - reglas de juego puras.
// Todo aqui son funciones sin efectos colaterales: faciles de testear y
// reutilizadas por el servidor (autoridad) y por el cliente (solo para UI).

import { sanitizeFlight } from './flight-profiles.js';
import {
  TEAMS,
  TEAM_SIZE,
  HILL,
  SCORE_TO_WIN,
  SPAWN_AREA,
  WORLD,
  NET,
  MODES,
  MODE_DEFAULT,
  MODE_RULES,
  MODE_LABEL,
  MODE_OBJECTIVE,
  MAX_HUMANS_PER_ROOM,
  FFA_TEAMS,
  ARENAS,
  ARENA_DEFAULT,
  ARENA_NAMES,
  HILL_SECONDS_OPTIONS,
  STOCK_OPTIONS,
  WEAPON_KINDS,
  WEAPON_DEFAULT,
} from './constants.js';
import { clamp, wrap, torusDistance } from './physics.js';
import { sanitizeShipModel } from './ships.js';

/** Normaliza un modo de juego. Devuelve null si no es conocido. */
export function sanitizeMode(raw) {
  if (typeof raw !== 'string') return null;
  const mode = raw.toLowerCase();
  return MODES.includes(mode) ? mode : null;
}

/** Reglas resumidas de un modo (con respaldo seguro a koth). */
export function modeRules(mode) {
  return MODE_RULES[sanitizeMode(mode) ?? MODE_DEFAULT];
}

/** Metadatos que el cliente usa para menús, HUD y ayuda. */
export function modeInfo(mode) {
  const key = sanitizeMode(mode) ?? MODE_DEFAULT;
  return { mode: key, label: MODE_LABEL[key], objective: MODE_OBJECTIVE[key], ...MODE_RULES[key] };
}

/** Todos los modos con su descripción (para el selector del anfitrión). */
export function listModes() {
  return MODES.map((m) => ({ mode: m, label: MODE_LABEL[m], objective: MODE_OBJECTIVE[m], ...MODE_RULES[m] }));
}

/**
 * ¿Puede la bala de `bullet` dañar a `player`?
 *  - arcade: nadie (todos aliados, el enemigo son las rocas)
 *  - ffa:    todos menos el propio dueño (sin fuego amigo)
 *  - koth/tdm: solo el equipo contrario
 */
export function isEnemyTarget(mode, bullet, player) {
  const rules = modeRules(mode);
  if (!rules.pvp) return false;
  if (!player.alive) return false;
  if (rules.teamBased) return bullet.team !== player.team;
  return bullet.owner !== player.id;
}

/** ¿Son `a` y `b` enemigos en este modo? (IA y comprobaciones lógicas) */
export function areEnemies(mode, a, b) {
  const rules = modeRules(mode);
  if (!rules.pvp || a.id === b.id) return false;
  if (rules.teamBased) return a.team !== b.team;
  return true;
}

/** Normaliza el nombre de un jugador. Devuelve null si no es aceptable. */
export function sanitizeName(raw) {
  if (typeof raw !== 'string') return null;
  const clean = raw.replace(/[\u0000-\u001f\u007f<>]/g, '').trim();
  if (clean.length < 1) return null;
  return clean.slice(0, NET.maxNameLength);
}

/** Normaliza un codigo de sala (solo A-Z0-9). */
export function sanitizeRoomCode(raw) {
  if (typeof raw !== 'string') return null;
  const clean = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (clean.length < 4 || clean.length > NET.maxRoomCodeLength) return null;
  return clean;
}

/** Normaliza el texto de chat. Devuelve null si queda vacio. */
export function sanitizeChat(raw) {
  if (typeof raw !== 'string') return null;
  const clean = raw.replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim();
  if (!clean) return null;
  return clean.slice(0, NET.maxChatLength);
}

/**
 * Normaliza el arma pedida por el cliente (selección absoluta). Devuelve null
 * si no es una de las armas conocidas. Acepta TODAS las armas del catálogo
 * (incluidas las especiales de pad); tener munición o no lo decide el servidor,
 * nunca este saneador.
 */
export function sanitizeWeapon(raw) {
  if (typeof raw !== 'string') return null;
  const weapon = raw.toLowerCase();
  return WEAPON_KINDS.includes(weapon) ? weapon : null;
}

/** Normaliza un ángulo a (-PI, PI]. Devuelve null si no es finito. */
export function sanitizeAimAngle(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  const wrapped = wrap(n, Math.PI * 2);
  return wrapped > Math.PI ? wrapped - Math.PI * 2 : wrapped;
}

/**
 * Valida y normaliza un input de control venido del cliente.
 * Cualquier campo basura se sustituye por un valor seguro; nunca lanza.
 *
 * Los campos tácticos (`weapon`, `dash`, `interact`) y los del prototipo
 * Ciudadela (`aim`, `aimAngle`, `moveX`, `moveY`, `smoke`, `bounce`, `model`)
 * son OPCIONALES y solo se incluyen en el resultado cuando el cliente los
 * envía: así los contratos y comparaciones históricas (que esperan exactamente
 * los 6 campos clásicos) siguen intactos. La OMISIÓN es neutra (la acción no
 * ocurre) y el arma/modelo ya elegidos PERSISTEN porque el servidor solo los
 * cambia cuando el campo llega.
 *
 * NUNCA se acepta estado del juego (posición, vida, munición, marcador): solo
 * control. Cualquier campo extra del cliente se descarta por diseño.
 */
export function sanitizeInput(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const rot = clamp(Number.isFinite(raw.rot) ? Math.trunc(raw.rot) : 0, -1, 1);
  const seq = Number.isFinite(raw.seq) ? Math.max(0, Math.trunc(raw.seq)) : 0;
  const input = {
    seq,
    rot,
    thrust: raw.thrust === true,
    brake: raw.brake === true,
    fire: raw.fire === true,
    boost: raw.boost === true,
  };
  if (Object.hasOwn(raw, 'weapon')) {
    input.weapon = sanitizeWeapon(raw.weapon) ?? WEAPON_DEFAULT;
  }
  if (Object.hasOwn(raw, 'dash')) {
    input.dash = clamp(Number.isFinite(raw.dash) ? Math.trunc(raw.dash) : 0, -1, 1);
  }
  if (Number.isSafeInteger(raw.dashId) && raw.dashId >= 0) input.dashId = raw.dashId;
  if (Object.hasOwn(raw, 'interact')) {
    input.interact = raw.interact === true;
  }
  // ── prototipo Ciudadela (v0.2): todos opcionales y neutros si faltan ──────
  if (Object.hasOwn(raw, 'aim')) {
    input.aim = raw.aim === true;
  }
  if (Object.hasOwn(raw, 'aimAngle')) {
    const angle = sanitizeAimAngle(raw.aimAngle);
    if (angle !== null) input.aimAngle = angle;
  }
  if (Object.hasOwn(raw, 'moveX') && Number.isFinite(Number(raw.moveX))) {
    input.moveX = clamp(Number(raw.moveX), -1, 1);
  }
  if (Object.hasOwn(raw, 'moveY') && Number.isFinite(Number(raw.moveY))) {
    input.moveY = clamp(Number(raw.moveY), -1, 1);
  }
  // `smoke` y `bounce` son flancos: el servidor los dispara al pasar de false a
  // true (mantener pulsado no repite).
  if (Object.hasOwn(raw, 'smoke')) {
    input.smoke = raw.smoke === true;
  }
  if (Object.hasOwn(raw, 'bounce')) {
    input.bounce = raw.bounce === true;
  }
  if (Object.hasOwn(raw, 'model')) {
    const model = typeof raw.model === 'string' ? sanitizeShipModel(raw.model.toLowerCase()) : null;
    if (model) input.model = model;
  }
  const flight = sanitizeFlight(raw.flight);
  if (flight) input.flight = flight;
  return input;
}

/** Cuenta cuantas naves vivas de cada equipo estan dentro de la colina. */
export function countInHill(players, hill = HILL) {
  const counts = { cyan: 0, coral: 0 };
  for (const p of players) {
    if (!p.alive) continue;
    const dx = p.x - hill.x;
    const dy = p.y - hill.y;
    if (dx * dx + dy * dy <= hill.radius * hill.radius) counts[p.team] += 1;
  }
  return counts;
}

/**
 * Estado de la colina a partir de los ocupantes:
 *  - 'idle'      nadie dentro
 *  - 'cyan'      solo cyan dentro  -> cyan puntua
 *  - 'coral'     solo coral dentro -> coral puntua
 *  - 'contested' ambos dentro      -> nadie puntua
 */
export function hillState(counts) {
  const c = counts.cyan > 0;
  const o = counts.coral > 0;
  if (c && o) return 'contested';
  if (c) return 'cyan';
  if (o) return 'coral';
  return 'idle';
}

/** Aplica la puntuacion de captura de un tick. Devuelve los puntos sumados. */
export function applyHillScore(score, counts, dt, pointsPerSecond = HILL.pointsPerSecond) {
  const state = hillState(counts);
  if (state === 'cyan' || state === 'coral') {
    const gain = pointsPerSecond * dt;
    score[state] += gain;
    return { state, gained: gain, team: state };
  }
  return { state, gained: 0, team: null };
}

/** Cuenta humanos y bots por equipo (solo equipos competitivos reales). */
export function teamCounts(players) {
  const humans = { cyan: 0, coral: 0 };
  const bots = { cyan: 0, coral: 0 };
  let humanTotal = 0;
  for (const p of players) {
    const known = TEAMS.includes(p.team);
    if (p.bot) {
      if (known) bots[p.team] += 1;
    } else {
      if (known) humans[p.team] += 1;
      humanTotal += 1;
    }
  }
  return { humans, bots, humanTotal };
}

/** Facción sintética de todos-contra-todos segun indice de puesto. */
export function ffaTeamForIndex(index) {
  return FFA_TEAMS[Math.max(0, index) % FFA_TEAMS.length];
}

/** Cupo de jugadores de una sala segun el modo (arcade tambien admite 8). */
export function playerCapacity(_mode) {
  return MAX_HUMANS_PER_ROOM;
}

/**
 * Plaza humana libre 1-8 para numerar naves (1P, 2P, ...). Los bots no ocupan
 * plaza. Estable mientras el jugador siga conectado; al salir se libera.
 */
export function freeHumanSlot(usedSlots, capacity = MAX_HUMANS_PER_ROOM) {
  const used = new Set();
  for (const s of usedSlots) if (Number.isInteger(s) && s >= 1) used.add(s);
  for (let i = 1; i <= capacity; i++) if (!used.has(i)) return i;
  return null;
}

/**
 * Etiqueta de una plaza humana. Siempre incluye el número (1P, 2P, …) y la
 * nave propia añade además "TÚ" para destacarse: "1P · TÚ".
 */
export function humanBadgeLabel(slot, isSelf) {
  if (!Number.isInteger(slot) || slot < 1) return null;
  return isSelf ? `${slot}P · TÚ` : `${slot}P`;
}

/** Un humano puede elegir equipo solo si hay cupo de humanos. */
export function canChooseTeam(players, team) {
  if (!TEAMS.includes(team)) return { ok: false, reason: 'equipo_invalido' };
  const { humans } = teamCounts(players);
  if (humans[team] >= TEAM_SIZE) return { ok: false, reason: 'equipo_lleno' };
  return { ok: true };
}

/** Equipo sugerido al entrar: el que tenga menos humanos (empate -> pedido). */
export function suggestedTeam(players, preferred) {
  const { humans } = teamCounts(players);
  if (preferred && TEAMS.includes(preferred) && humans[preferred] < TEAM_SIZE) return preferred;
  if (humans.cyan < TEAM_SIZE && humans.cyan <= humans.coral) return 'cyan';
  if (humans.coral < TEAM_SIZE) return 'coral';
  if (humans.cyan < TEAM_SIZE) return 'cyan';
  return null; // ambos equipos llenos de humanos
}

/**
 * Condicion de victoria generica: alcanzar el objetivo o, al agotarse el
 * tiempo, tener mas puntos. `target` depende del modo (100 colina, 25 tdm,
 * 15 ffa). Los tests historicos de koth la llaman sin el tercer argumento.
 */
export function checkWin(score, timeLeft, target = SCORE_TO_WIN) {
  if (score.cyan >= target || score.coral >= target) {
    const winner = score.cyan >= target ? 'cyan' : 'coral';
    return { over: true, winner, reason: 'meta' };
  }
  if (timeLeft <= 0) {
    if (score.cyan > score.coral) return { over: true, winner: 'cyan', reason: 'tiempo' };
    if (score.coral > score.cyan) return { over: true, winner: 'coral', reason: 'tiempo' };
    return { over: true, winner: 'draw', reason: 'tiempo' };
  }
  return { over: false, winner: null, reason: null };
}

/**
 * Punto de aparición con dispersión aleatoria.
 *  - koth/tdm/arcade: lado del equipo.
 *  - ffa: repartido por toda la arena (cada piloto es su propia facción).
 * `world` es opcional: sin él se usa la arena clásica (API antigua intacta).
 */
export function chooseSpawn(team, rng = Math.random, mode = MODE_DEFAULT, world = WORLD) {
  const w = world ?? WORLD;
  if (!SPAWN_AREA[team] || (mode === 'ffa' && !TEAMS.includes(team))) {
    const x = rng() * w.w;
    const y = rng() * w.h;
    return { x, y, angle: rng() * Math.PI * 2 };
  }
  const base = spawnArea(team, w) ?? spawnArea('cyan', w);
  const angle = rng() * Math.PI * 2;
  const dist = 90 + rng() * 120;
  const x = wrap(base.x + Math.cos(angle) * dist, w.w);
  const y = wrap(base.y + Math.sin(angle) * dist, w.h);
  return { x, y, angle: team === 'cyan' ? 0 : Math.PI };
}

/**
 * Zona de aparición de un equipo reescalada al mundo de la partida.
 * Las proporciones son las mismas que en la arena clásica (16% / 84% del ancho).
 */
export function spawnArea(team, world = WORLD) {
  const base = SPAWN_AREA[team];
  if (!base) return null;
  const w = world ?? WORLD;
  return { x: (base.x / WORLD.w) * w.w, y: (base.y / WORLD.h) * w.h };
}

// ─────────────────────────────────────────────────────────── arenas y colina
/**
 * Normaliza un identificador de arena. Estricto: solo nombres exactos del
 * catálogo propio (`Object.hasOwn`), nunca propiedades heredadas como
 * `__proto__` o `constructor`, que romperían el mundo de la partida.
 */
export function sanitizeArena(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  return Object.hasOwn(ARENAS, raw) ? raw : null;
}

/** Normaliza los segundos de rotación de la colina (solo opciones válidas). */
export function sanitizeHillSeconds(raw) {
  if (typeof raw !== 'number' || !Number.isInteger(raw)) return null;
  return HILL_SECONDS_OPTIONS.includes(raw) ? raw : null;
}

/** Mundo (nuevo objeto, nunca compartido) de una arena. */
export function arenaWorld(arena = ARENA_DEFAULT) {
  const name = sanitizeArena(arena) ?? ARENA_DEFAULT;
  return { w: ARENAS[name].w, h: ARENAS[name].h };
}

/** Metadatos de una arena para la UI. */
export function arenaInfo(arena = ARENA_DEFAULT) {
  const name = sanitizeArena(arena) ?? ARENA_DEFAULT;
  const a = ARENAS[name];
  return { arena: name, w: a.w, h: a.h, label: a.label };
}

/** Catálogo completo de arenas (selector del anfitrión). */
export function listArenas() {
  return ARENA_NAMES.map((name) => arenaInfo(name));
}

/**
 * Valida un mensaje de configuración del anfitrión de forma atómica:
 * si CUALQUIER campo presente es inválido, no se aplica nada.
 * `undefined` (ausente) = "no lo toco"; `null` explícito = valor inválido y
 * por tanto se rechaza el mensaje completo. Solo se leen claves propias.
 */
export function sanitizeArenaSettings(msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return { ok: false, reason: 'settings_invalidos' };
  const hasArena = Object.hasOwn(msg, 'arena') && msg.arena !== undefined;
  const hasHill = Object.hasOwn(msg, 'hillSeconds') && msg.hillSeconds !== undefined;
  const hasStocks = Object.hasOwn(msg, 'stocks') && msg.stocks !== undefined;
  if (!hasArena && !hasHill && !hasStocks) return { ok: false, reason: 'sin_cambios' };
  let arena;
  let hillSeconds;
  let stocks;
  if (hasArena) {
    arena = sanitizeArena(msg.arena);
    if (!arena) return { ok: false, reason: 'arena_invalida' };
  }
  if (hasHill) {
    hillSeconds = sanitizeHillSeconds(msg.hillSeconds);
    if (hillSeconds === null) return { ok: false, reason: 'hill_seconds_invalido' };
  }
  if (hasStocks) {
    const n = Number(msg.stocks);
    if (!Number.isInteger(n) || !STOCK_OPTIONS.includes(n)) return { ok: false, reason: 'stocks_invalidos' };
    stocks = n;
  }
  const result = { ok: true, arena, hillSeconds };
  if (hasStocks) result.stocks = stocks;
  return result;
}

/** Límites jugables del centro de la colina dentro de un mundo. */
export function hillBounds(world = WORLD, radius = HILL.radius) {
  const w = world ?? WORLD;
  const pad = radius + HILL.margin;
  const minX = Math.min(pad, w.w / 2);
  const maxX = Math.max(w.w - pad, w.w / 2);
  const minY = Math.min(pad, w.h / 2);
  const maxY = Math.max(w.h - pad, w.h / 2);
  return { minX, maxX, minY, maxY };
}

/** Separación mínima exigida entre la colina anterior y la nueva. */
export function hillMinDistance(world = WORLD) {
  const w = world ?? WORLD;
  return Math.max(HILL.moveMinDistance, Math.min(w.w, w.h) * 0.22);
}

/**
 * Rejilla determinista de candidatos dentro de los límites jugables. Se usa
 * como respaldo cuando el rng no encuentra sitio: nunca depende de la suerte
 * (ni de un rng degenerado) y respeta margen y toro por construcción.
 */
export function hillGridCandidates(world = WORLD, radius = HILL.radius, cols = 9, rows = 9) {
  const w = world ?? WORLD;
  const { minX, maxX, minY, maxY } = hillBounds(w, radius);
  const out = [];
  const cN = Math.max(2, cols | 0);
  const rN = Math.max(2, rows | 0);
  for (let i = 0; i < cN; i++) {
    const fx = i / (cN - 1);
    for (let j = 0; j < rN; j++) {
      const fy = j / (rN - 1);
      out.push({ x: minX + fx * (maxX - minX), y: minY + fy * (maxY - minY) });
    }
  }
  return out;
}

/**
 * Elige la siguiente posición de la colina:
 *  - respeta margen y toro (el centro nunca toca el muro)
 *  - se aleja de la posición anterior al menos `hillMinDistance(world)`
 *  - evita solaparse con asteroides grandes si hay sitio viable
 * Necesita `prev` + `obstacles` ({x,y,r}) para hacerlo de forma consciente.
 * Si los intentos aleatorios fallan se prueban candidatos deterministas, de
 * modo que con un `rng` constante la colina igualmente cambia de sitio.
 */
export function pickHillPosition(
  world = WORLD,
  rng = Math.random,
  prev = null,
  obstacles = [],
  { radius = HILL.radius, attempts = 64 } = {},
) {
  const w = world ?? WORLD;
  const { minX, maxX, minY, maxY } = hillBounds(w, radius);
  const minDist = hillMinDistance(w);
  const clearance = radius + HILL.rockClearance;

  const evaluate = (x, y) => {
    const dPrev = prev ? torusDistance(x, y, prev.x, prev.y, w) : Infinity;
    let blocked = 0;
    for (const o of obstacles) {
      if (!o) continue;
      const d = torusDistance(x, y, o.x, o.y, w) - (o.r ?? radius);
      if (d < clearance) blocked += 1;
    }
    return { x, y, dPrev, blocked, distOk: dPrev >= minDist, clearOk: blocked === 0 };
  };
  // La distancia a la colina anterior manda; esquivar rocas solo desempata.
  const score = (c) => (c.distOk ? 1e9 : 0) + (c.clearOk ? 1e6 : 0) + Math.min(c.dPrev, 1e5) - c.blocked * 1e3;

  const tries = Math.max(1, attempts | 0);
  let best = null;
  for (let i = 0; i < tries; i++) {
    const c = evaluate(minX + rng() * (maxX - minX), minY + rng() * (maxY - minY));
    if (c.distOk && c.clearOk) return { x: c.x, y: c.y };
    if (!best || score(c) > score(best)) best = c;
  }

  for (const cand of hillGridCandidates(w, radius)) {
    const c = evaluate(cand.x, cand.y);
    if (c.distOk && c.clearOk) return { x: c.x, y: c.y };
    if (!best || score(c) > score(best)) best = c;
  }
  return { x: best.x, y: best.y };
}

/** PPM (puntos por minuto) seguro para la UI. */
export function ratePerMinute(score, elapsedSeconds) {
  if (elapsedSeconds <= 0) return 0;
  return (score / elapsedSeconds) * 60;
}

// ─────────────────────────────────────── colina en mapas con arquitectura
/**
 * Elige la siguiente posición de la colina en un mapa CON ARQUITECTURA
 * (Ciudadela). La política es deliberadamente distinta de la clásica (`orbit`):
 *
 *  - la colina PUEDE ENGLOBAR coberturas (es deseable tácticamente): solo su
 *    CENTRO tiene que ser transitable, y eso lo decide `centerFree(x,y)`, que
 *    el servidor resuelve con el contacto EXACTO (rectángulos incluidos) y un
 *    disco de nave, nunca inflando el bounding radius de cada pared con el
 *    radio entero de la colina
 *  - se mantienen intactos `HILL.radius` y `HILL.moveMinDistance`
 *  - solo se esquivan las ROCAS grandes (`rocks`, {x,y,r}) con el colchón
 *    histórico `HILL.rockClearance`
 *  - respeta margen y toro por construcción (`hillBounds`) y usa reintentos
 *    aleatorios ACOTADOS + rejilla determinista de respaldo: siempre converge
 */
export function pickHillPositionOpen(
  world = WORLD,
  rng = Math.random,
  prev = null,
  { radius = HILL.radius, attempts = 64, centerFree = null, rocks = [], rockClearance = HILL.rockClearance } = {},
) {
  const w = world ?? WORLD;
  const { minX, maxX, minY, maxY } = hillBounds(w, radius);
  const minDist = hillMinDistance(w);
  const clearance = radius + rockClearance;
  const isFree = typeof centerFree === 'function' ? centerFree : () => true;

  const evaluate = (x, y) => {
    return {
      x,
      y,
      dPrev: prev ? torusDistance(x, y, prev.x, prev.y, w) : Infinity,
      blocked: rocks.filter((o) => o && torusDistance(x, y, o.x, o.y, w) - (o.r ?? 0) < clearance).length,
      free: isFree(x, y) === true,
    };
  };
  const score = (c) => (c.distOk ? 1e9 : 0) + (c.clearOk ? 1e6 : 0) + (c.free ? 1e5 : 0) + Math.min(c.dPrev, 1e5) - c.blocked * 1e3;
  const finish = (c) => {
    c.distOk = c.dPrev >= minDist;
    c.clearOk = c.blocked === 0;
    return c;
  };

  const tries = Math.max(1, attempts | 0);
  let best = null;
  for (let i = 0; i < tries; i++) {
    const c = finish(evaluate(minX + rng() * (maxX - minX), minY + rng() * (maxY - minY)));
    if (c.free && c.distOk && c.clearOk) return { x: c.x, y: c.y };
    if (!best || score(c) > score(best)) best = c;
  }
  for (const cand of hillGridCandidates(w, radius)) {
    const c = finish(evaluate(cand.x, cand.y));
    if (c.free && c.distOk && c.clearOk) return { x: c.x, y: c.y };
    if (!best || score(c) > score(best)) best = c;
  }
  return { x: best.x, y: best.y };
}
