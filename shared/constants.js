// Orbit Hill - constantes compartidas entre servidor autoritativo y cliente.
// Este módulo es la unica fuente de verdad de las reglas de juego.

export const TICK_RATE = 60;               // ticks de simulacion por segundo
export const DT = 1 / TICK_RATE;
export const SNAPSHOT_RATE = 20;           // snapshots de red por segundo
export const TICKS_PER_SNAPSHOT = TICK_RATE / SNAPSHOT_RATE;

// ───────────────────────────────────────────────────────────────────── arenas
// Cada partida lleva SU PROPIO mundo (Match.world) elegido en el lobby. El
// registro ARENAS es inmutable: es solo el catalogo de tamaños disponibles.
// WORLD sigue siendo el tamaño clasico de siempre para no romper la API
// antigua (constantes, fisica y tests historicos).
export const ARENAS = Object.freeze({
  classic: Object.freeze({ w: 1800, h: 1200, label: 'Clásica 1800×1200' }),
  wide: Object.freeze({ w: 2400, h: 1600, label: 'Amplia 2400×1600' }),
  large: Object.freeze({ w: 3000, h: 2000, label: 'Grande 3000×2000' }),
  huge: Object.freeze({ w: 3600, h: 2400, label: 'Enorme 3600×2400' }),
});

export const ARENA_DEFAULT = 'classic';
export const ARENA_NAMES = Object.freeze(Object.keys(ARENAS));
export const STOCK_OPTIONS = Object.freeze([1, 3, 5, 7]);
export const STOCKS_DEFAULT = 3;

// Escenario del prototipo Ciudadela (v0.2). Aditivo: no toca `settings` (arena
// + colina) ni los defaults históricos. `orbit` es el campo de batalla clásico
// (el que usa la API directa de Match y, por tanto, las pruebas históricas);
// `citadel` es el nuevo y el que usan las salas nuevas.
export const BATTLEFIELD_DEFAULT = 'citadel';

/** Mundo por defecto (clasico). Nunca debe mutarse: es el fallback global. */
export const WORLD = Object.freeze({ w: ARENAS.classic.w, h: ARENAS.classic.h });

export const TEAMS = ['cyan', 'coral'];

// En todos contra todos cada piloto es su propia "facción": no hay aliados ni
// fuego amigo, y el color identifica al jugador. Son equipos sintéticos que
// solo existen para pintar y ordenar la tabla; nunca forman alianzas.
export const FFA_TEAMS = ['f0', 'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7'];
export const FFA_COLORS = ['#3ff2ff', '#ff6b5e', '#ffd166', '#6ef7a8', '#b18cff', '#ff9f43', '#5ec8ff', '#ff7ad9'];
const FFA_COLOR_MAP = Object.fromEntries(FFA_TEAMS.map((t, i) => [t, FFA_COLORS[i]]));
const FFA_LABEL_MAP = Object.fromEntries(FFA_TEAMS.map((t, i) => [t, `Piloto ${i + 1}`]));

export const TEAM_COLORS = { cyan: '#3ff2ff', coral: '#ff6b5e', ...FFA_COLOR_MAP };
export const TEAM_LABEL = { cyan: 'Cyan', coral: 'Coral', ...FFA_LABEL_MAP };

export const MAX_HUMANS_PER_ROOM = 8;
export const TEAM_SIZE = 4;                // maximo 4 jugadores por equipo

// ───────────────────────────────────────────────────────────── modos de juego
// El anfitrión elige el modo en el lobby (o entre rondas) y el servidor lo
// valida. `koth` conserva las reglas originales de rey de la colina.
export const MODES = ['koth', 'tdm', 'ffa', 'arcade', 'asteroids', 'asteroids3', 'stocks', 'chaos'];
export const MODE_DEFAULT = 'koth';

export const KILLS_TO_WIN = { tdm: 25, ffa: 15 };

export const MODE_LABEL = {
  koth: 'Rey de la colina',
  tdm: 'Combate por equipos',
  ffa: 'Todos contra todos',
  arcade: 'Arcade cooperativo',
  asteroids: 'Asteroids clásico',
  asteroids3: 'Asteroids · 3 impactos',
  stocks: 'Stocks · último en pie',
  chaos: 'Caos orbital',
};

export const MODE_OBJECTIVE = {
  koth: 'Domina la colina sin rivales dentro y llega a 100 puntos.',
  tdm: '4 contra 4: suma 25 bajas de equipo antes que el rival.',
  ffa: 'Cada piloto por su cuenta: 15 bajas antes que nadie.',
  arcade: 'Cooperativo 1-8: superad 5 oleadas de asteroides con 12 reapariciones comunes.',
  asteroids: 'Duelo de equipos: balas puntuales, 3 vidas por piloto y retroceso al impacto.',
  asteroids3: 'Duelo de equipos: tres impactos para destruir; los dos primeros empujan.',
  stocks: 'Último equipo en pie: configura las vidas y no reapareces al agotarlas.',
  chaos: 'Combate casual: armas, powerups y explosiones por toda la arena. Gana quien consiga 30 bajas.',
};

// `bots:false` en arcade: nunca se añaden bots en cooperativo.
// `botsFill` indica cómo se completa la sala (por equipos 4v4 o por jugadores).
export const MODE_RULES = {
  koth: { teamBased: true, bots: true, botsFill: 'teams', pvp: true, timeLimit: 360, target: 100, usesHill: true },
  tdm: { teamBased: true, bots: true, botsFill: 'teams', pvp: true, timeLimit: 360, target: 25, usesHill: false },
  ffa: { teamBased: false, bots: true, botsFill: 'players', pvp: true, timeLimit: 360, target: 15, usesHill: false },
  arcade: { teamBased: false, bots: false, botsFill: 'none', pvp: false, timeLimit: null, target: null, usesHill: false },
  asteroids: { teamBased: true, bots: true, botsFill: 'teams', pvp: true, timeLimit: 360, target: null, usesHill: false },
  asteroids3: { teamBased: true, bots: true, botsFill: 'teams', pvp: true, timeLimit: 360, target: null, usesHill: false },
  stocks: { teamBased: true, bots: true, botsFill: 'teams', pvp: true, timeLimit: 360, target: null, usesHill: false },
  chaos: { teamBased: false, bots: true, botsFill: 'players', pvp: true, timeLimit: 360, target: 30, usesHill: false },
};

export const SHIP = {
  radius: 13,
  thrust: 620,        // aceleracion normal px/s^2
  boostThrust: 1180,  // aceleracion con boost
  turnSpeed: 4.4,     // rad/s
  maxSpeed: 560,
  boostMaxSpeed: 860,
  damping: 0.9,       // friccion exponencial por segundo
  boostDuration: 1.5,
  boostCooldown: 5.0,
  maxHp: 100,
};

export const BULLET = {
  radius: 3.5,
  speed: 760,
  life: 1.15,
  damage: 25,
  cooldown: 0.26,      // cadencia maxima por nave
  maxLive: 6,          // limite de balas vivas por jugador
  maxTotal: 120,       // tope global de balas vivas (acota el snapshot)
  inherited: 0.35,     // fraccion de la velocidad heredada de la nave
};

// Powerups autoritativos: caen de asteroides destruidos POR DISPAROS, no al
// aparecer. El cliente solo los ve; nunca los crea ni los recoge por su cuenta.
export const POWERUP = {
  dropChance: 0.25,    // probabilidad por asteroide destruido a tiros
  maxActive: 10,       // maximo de drops vivos a la vez
  life: 18,            // caducidad en segundos
  radius: 17,          // radio de recogida por proximidad toroidal
  repair: 40,          // vida recuperada (con tope en SHIP.maxHp)
  shieldSeconds: 6,    // escudo: bloquea dano
  rapidSeconds: 8,     // disparo rapido
  rapidCooldown: 0.11, // cadencia con disparo rapido
  rapidMaxLive: 10,    // balas vivas con disparo rapido
  spreadSeconds: 8,    // triple disparo
  spreadCount: 3,      // balas por disparo
  spreadAngle: 0.2,    // separacion angular entre balas
  spreadMaxLive: 12,   // balas vivas con triple disparo
  warnSeconds: 4,      // aviso visual de caducidad inminente
  // Caos Orbital: el mapa mantiene objetos en circulación aun cuando nadie
  // esté rompiendo rocas. Los valores viven aquí para que servidor y HUD
  // hablen del mismo catálogo.
  chaosMaxActive: 38,
  chaosDropChance: 0.82,
  chaosAmbientEvery: 2.6,
  chaosAmbientBatch: 3,
  chaosRespawnSeconds: 0.8,
  chaosProtectSeconds: 1.2,
  overdriveSeconds: 7,
  overdriveFactor: 1.32,
  magnetSeconds: 9,
  magnetReach: 82,
  leechSeconds: 9,
  leechFraction: 0.28,
  barrageSeconds: 8,
  barrageCount: 5,
  barrageAngle: 0.13,
  novaSeconds: 8,
  novaRadius: 190,
  novaDamage: 74,
  novaCoverDamage: 145,
  blinkDistance: 300,
  blinkShieldSeconds: 1.6,
  jamSeconds: 4,
  volatileDamage: 42,
};

export const POWERUP_TYPES = [
  'repair', 'shield', 'rapid', 'spread',
  'laser', 'heavy', 'homing', 'mine', 'barrage', 'nova',
  'overdrive', 'magnet', 'leech', 'blink',
  // Riesgos exclusivos de Caos: se ven como objetos del mapa y se activan
  // al tocarlos, igual que una ayuda.
  'jam', 'volatile',
];

// ───────────────────────────────────────────────────────── armas del prototipo
// Selección ABSOLUTA por input (`weapon`): el cliente dice cuál quiere y el
// servidor la valida. `auto` es el cañón de siempre (compatibilidad total);
// `plasma` es la escopeta de perdigones del laboratorio táctico.
export const WEAPONS = ['auto', 'plasma'];
// Armas ESPECIALES del prototipo: nunca son gratuitas, solo se obtienen en los
// pads de armas del mapa (ver shared/arsenal.js). Su munición es autoritativa.
export const SPECIAL_WEAPONS = ['sniper', 'boomer'];
/** Catálogo completo de `kind` de arma/proyectil que el input puede pedir. */
export const WEAPON_KINDS = [...WEAPONS, ...SPECIAL_WEAPONS];
export const WEAPON_DEFAULT = 'auto';

export const POWERUP_INFO = {
  repair: { label: 'Reparación', short: 'REP', color: '#6ef7a8', icon: '+' },
  shield: { label: 'Escudo', short: 'ESC', color: '#7fd8ff', icon: '◎' },
  rapid: { label: 'Disparo rápido', short: 'RAP', color: '#ffd166', icon: '⚡' },
  spread: { label: 'Triple disparo', short: 'TRI', color: '#ff9f43', icon: '≡' },
  laser: { label: 'Láser', short: 'LAS', color: '#ff4fd8', icon: '━' },
  heavy: { label: 'Ametralladora', short: 'HMG', color: '#f7f7f7', icon: '✹' },
  homing: { label: 'Misil guiado', short: 'HOM', color: '#7aa7ff', icon: '➤' },
  mine: { label: 'Mina de proximidad', short: 'MIN', color: '#ff6b5e', icon: '✹' },
  barrage: { label: 'Ráfaga de cinco', short: 'RAF', color: '#ffcc66', icon: '✦' },
  nova: { label: 'Cañón nova', short: 'NOVA', color: '#ff75f4', icon: '✹' },
  overdrive: { label: 'Sobremarcha', short: 'SPD', color: '#56f0d3', icon: '»' },
  magnet: { label: 'Imán de botín', short: 'MAG', color: '#c38cff', icon: '◉' },
  leech: { label: 'Drenaje vital', short: 'VMP', color: '#ff6fae', icon: '♥' },
  blink: { label: 'Motor de salto', short: 'BLINK', color: '#72f6ff', icon: '↯' },
  jam: { label: 'Pulso EMP', short: 'EMP', color: '#b9a6ff', icon: '⌁' },
  volatile: { label: 'Carga volátil', short: '¡!', color: '#ff475f', icon: '✹' },
};

/** Info legible de un powerup (con respaldo seguro para la UI). */
export function powerupInfo(type) {
  return POWERUP_INFO[type] ?? { label: 'Powerup', short: '?', color: '#ffffff', icon: '?' };
}

// Modo arcade cooperativo: oleadas finitas, sin bots y sin reinicios infinitos.
export const ARCADE = {
  wavesToWin: 5,
  sharedLives: 12,     // reserva comun de reapariciones
  waveBase: 6,         // asteroides de la oleada 1
  waveGrowth: 3,       // +3 por oleada
  waveMax: 22,         // tope de rocas por oleada
  waveDelay: 2.5,      // pausa entre oleadas
};

export const ASTEROID_SIZES = [
  { r: 58, hp: 130, damage: 46, child: 1, value: 20 },
  { r: 34, hp: 70, damage: 30, child: 2, value: 12 },
  { r: 19, hp: 36, damage: 18, child: -1, value: 6 },
];

export const ASTEROID_START_COUNT = 7;
export const ASTEROID_TARGET_COUNT = 9;
export const ASTEROID_MAX = 46;
export const ASTEROID_RESPAWN_EVERY = 7;  // segundos entre intentos de repoblado

export const HILL = {
  x: WORLD.w / 2,
  y: WORLD.h / 2,
  radius: 215,
  margin: 40,             // colchón extra entre el borde de la colina y el muro
  pointsPerSecond: 2,     // el equipo que domina suma 2 puntos/s
  moveMinDistance: 320,   // separación mínima entre colinas consecutivas
  rockClearance: 60,      // colchón para no nacer encima de una roca grande
};

// La colina de koth se mueve cada N segundos de juego efectivo. `0` la deja
// fija (comportamiento clásico); el resto son las opciones válidas del lobby.
export const HILL_SECONDS_DEFAULT = 45;
export const HILL_SECONDS_OPTIONS = Object.freeze([0, 30, 45, 60, 90]);
export const HILL_WARN_SECONDS = 5;   // aviso del próximo destino a partir de aquí

export const SCORE_TO_WIN = 100;
export const MATCH_SECONDS = 360;       // limite de tiempo por partida
export const COUNTDOWN_SECONDS = 3;
export const RESPAWN_SECONDS = 3;
export const PROTECT_SECONDS = 2.5;
export const ENDED_SECONDS = 45;        // pausa final antes de rendirse la sala

export const SPAWN_AREA = {
  cyan: { x: WORLD.w * 0.16, y: WORLD.h * 0.5 },
  coral: { x: WORLD.w * 0.84, y: WORLD.h * 0.5 },
};

// Flags de estado por jugador dentro del snapshot (bitfield compacto).
export const FLAG = {
  ALIVE: 1,
  PROTECTED: 2,
  BOT: 4,
  HOST: 8,
  BOOSTING: 16,
  SHIELD: 32,
  RAPID: 64,
  SPREAD: 128,
  ELIMINATED: 256,
};

export const NET = {
  maxMessageBytes: 2048,     // payload maximo aceptado por el WebSocket
  maxSnapshotBytes: 16384,   // tope justificado del snapshot servidor->cliente
  maxBufferedBytes: 65536,   // backpressure: si el socket acumula mas, se descarta
  maxRoomCodeLength: 6,
  maxNameLength: 14,
  maxChatLength: 120,
  msgsPerSecond: 90,         // ritmo sostenido permitido
  msgBurst: 140,             // rafaga inicial de tokens
  strikesBeforeClose: 25,    // mensajes invalidos antes de cerrar la conexion
  inputSendHz: 30,
};

export const BOT_NAMES = [
  'Vega', 'Nyx', 'Kepler', 'Rhea', 'Orion', 'Titán', 'Nova', 'Wren',
  'Halley', 'Sirio', 'Lyra', 'Atlas', 'Mira', 'Caronte', 'Zeta', 'Ío',
];
