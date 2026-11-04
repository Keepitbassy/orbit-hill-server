// Orbit Hill - simulacion autoritativa de una partida.
// Este modulo NO conoce la red: recibe inputs ya sanitizados y produce estado.
// Todo el resultado de la partida (posiciones, vida, puntos, bajas, oleadas y
// powerups) se decide aqui, jamas a partir de lo que diga un cliente.
//
// Cuatro modos: koth (rey de la colina), tdm (4v4 a 25 bajas), ffa (todos
// contra todos a 15 bajas) y arcade (cooperativo de oleadas, sin bots).

import { sanitizeFlight } from '../shared/flight-profiles.js';
import {
  DT,
  TEAMS,
  TEAM_SIZE,
  SHIP,
  BULLET,
  HILL,
  ASTEROID_SIZES,
  ASTEROID_START_COUNT,
  ASTEROID_TARGET_COUNT,
  ASTEROID_MAX,
  ASTEROID_RESPAWN_EVERY,
  MATCH_SECONDS,
  COUNTDOWN_SECONDS,
  RESPAWN_SECONDS,
  PROTECT_SECONDS,
  ENDED_SECONDS,
  FLAG,
  BOT_NAMES,
  POWERUP,
  POWERUP_TYPES,
  ARCADE,
  MODE_DEFAULT,
  FFA_TEAMS,
  ARENA_DEFAULT,
  HILL_SECONDS_DEFAULT,
  WEAPON_DEFAULT,
  WEAPON_KINDS,
  STOCKS_DEFAULT,
  STOCK_OPTIONS,
} from '../shared/constants.js';
import {
  stepShip,
  spawnBullet,
  stepBullet,
  wrap,
  torusDelta,
  torusDistance,
  clamp,
  angleDelta,
  asteroidShape,
} from '../shared/physics.js';
import {
  countInHill,
  applyHillScore,
  checkWin,
  chooseSpawn,
  isEnemyTarget,
  areEnemies,
  modeRules,
  sanitizeMode,
  ffaTeamForIndex,
  sanitizeArena,
  sanitizeHillSeconds,
  arenaWorld,
  pickHillPosition,
  pickHillPositionOpen,
} from '../shared/rules.js';
import { TACTICAL, tacticalActive, coverLayout } from '../shared/tactical.js';
import { buildBattlefield, coverContact, segmentBlocked, sanitizeBattlefield } from '../shared/battlefield.js';
import { ARSENAL, AMMO_MAX, PAD, SMOKE, BOUNCE, AIM } from '../shared/arsenal.js';
import { SHIP_MODELS, SHIP_DEFAULT, sanitizeShipModel } from '../shared/ships.js';

// Tipos de cobertura aceptados en el snapshot (contrato v2).
const COVER_KINDS = ['wall', 'block', 'hex'];
// Radio de recogida base de un pad (desde el casco de la nave viva).
const PAD_REACH = 26;

const rand = (rng, a, b) => a + rng() * (b - a);
const BUFF_TYPES = ['shield', 'rapid', 'spread', 'laser', 'heavy', 'homing', 'mine', 'barrage', 'overdrive', 'magnet', 'leech', 'jam'];
// Un respawn "pendiente" dura segundos; un eliminado queda prácticamente para
// siempre. El umbral separa ambos casos sin usar Infinity (JSON no lo soporta).
const ELIMINATED_AFTER = 1e5;
const ELIMINATED_OFFSET = 1e6;

// Enfriamiento de esquiva válido: número finito acotado a [0, 10] segundos.
// Un valor basura (NaN/Infinity/absent) cae al LEGACY (2.6) para conservar la
// API; un valor fuera de rango se acota en vez de romper la simulación.
export const DASH_COOLDOWN_MIN = 0;
export const DASH_COOLDOWN_MAX = 10;
export function sanitizeDashCooldown(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return TACTICAL.dash.cooldown;
  return clamp(n, DASH_COOLDOWN_MIN, DASH_COOLDOWN_MAX);
}

export class Match {
  constructor({
    rng = Math.random,
    seed = 12345,
    mode = MODE_DEFAULT,
    arena = ARENA_DEFAULT,
    hillSeconds = HILL_SECONDS_DEFAULT,
    tactical = false,
    battlefield = 'orbit',
    dashCooldown = TACTICAL.dash.cooldown,
    dashSpeed = TACTICAL.dash.speed,
    stocks = STOCKS_DEFAULT,
  } = {}) {
    this.rng = rng;
    this.seed = seed;
    // Perfil de combate táctico. Se pide EXPLÍCITAMENTE (la sala lo activa en
    // este prototipo, pero los tests clásicos que construyen `new Match(...)`
    // directamente conservan el comportamiento histórico: sin coberturas, sin
    // derribos y sin escopeta).
    this.tacticalProfile = tactical === true;
    // ── contrato de esquiva (dash) ──────────────────────────────────────────
    // El enfriamiento es un parámetro de Match (autoridad pura): por defecto
    // conserva el valor LEGACY del contrato táctico (2.6 s) para no alterar la
    // API ni las pruebas históricas. Las salas NUEVAS de este prototipo piden
    // 0 s (Zero Dash). Nunca viaja por `settings` ni lo puede fijar el cliente.
    this.dashCooldown = sanitizeDashCooldown(dashCooldown);
    this.dashSpeed = Number.isFinite(dashSpeed) ? clamp(dashSpeed, 100, 700) : TACTICAL.dash.speed;
    this.stocks = STOCK_OPTIONS.includes(Number(stocks)) ? Number(stocks) : STOCKS_DEFAULT;
    // ── arena, campo de batalla y colina PROPIAS de esta partida ────────────
    // Nunca se usan los objetos globales WORLD/HILL para simular: cada Match
    // posee su `this.world` y su `this.hill`, así dos salas no se pisan.
    this.arena = sanitizeArena(arena) ?? ARENA_DEFAULT;
    this.world = arenaWorld(this.arena);
    // El campo de batalla es la GEOMETRÍA de la partida: `orbit` conserva el
    // reparto circular clásico (coverLayout) y `citadel` usa el mapa del
    // agente de geometría (buildBattlefield). La API directa de Match arranca
    // en `orbit` para no alterar ninguna prueba histórica.
    this.battlefield = sanitizeBattlefield(battlefield) ?? 'orbit';
    this.spawns = null;                      // anclas de aparición del mapa (o null)
    this.hillSeconds = sanitizeHillSeconds(hillSeconds) ?? HILL_SECONDS_DEFAULT;
    this.hill = { x: this.world.w / 2, y: this.world.h / 2, radius: HILL.radius };
    this.hillRemaining = this.hillSeconds;   // segundos hasta el próximo movimiento
    this.hillNext = null;                    // destino ya predeterminado
    this.hillMoves = 0;
    this.players = new Map();
    this.bullets = [];
    this.asteroids = [];
    this.pickups = [];
    this.covers = [];          // coberturas estáticas destructibles (táctica)
    this.pads = [];            // pads de armas especiales del mapa (v0.2)
    this.smokes = [];          // nubes de humo activas (v0.2)
    this.events = [];
    this.score = { cyan: 0, coral: 0 };
    // En tdm el marcador es ACUMULATIVO: se suma al matar un rival y no se
    // recalcula desde los jugadores conectados (no se pierde al desconectar
    // ni se mueve al cambiar de equipo).
    this.teamKills = { cyan: 0, coral: 0 };
    this.phase = 'lobby';      // lobby | countdown | playing | ended
    this.time = 0;             // reloj monótono de la simulación (segundos)
    this.tickCount = 0;
    this.countdown = 0;
    this.timeLeft = MATCH_SECONDS;
    this.endedTimer = 0;
    this.winner = null;
    this.winReason = null;
    this.winnerId = null;      // en ffa: piloto ganador
    this.hillStatus = 'idle';
    this.hillCounts = { cyan: 0, coral: 0 };
    this.ids = { player: 0, bullet: 0, asteroid: 0, pickup: 0, cover: 0, pad: 0, smoke: 0 };
    this.botModelSeq = 0;      // los bots recorren todo el catálogo cosmético
    this.respawnTimer = 0;
    this.chaosDropTimer = 0;
    this.roundNumber = 1;
    this.wave = 0;             // arcade: oleada actual (1..wavesToWin)
    this.lives = 0;            // arcade: reserva común de reapariciones
    this.waveTimer = 0;
    this.superTimer = 0;
    this.superCore = null;
    this.superTimer = 0;
    this.superCore = null;
    this.ffaLeader = null;     // ffa: piloto líder (para el resultado por jugador)
    this.mode = MODE_DEFAULT;
    this.rules = modeRules(MODE_DEFAULT);
    this.setMode(mode, { silent: true });
    this.ensureCovers();
    this.resetHill();
  }

  /**
   * Combate táctico efectivo AHORA MISMO: perfil pedido Y modo táctico
   * (koth/tdm). FFA y arcade conservan sus reglas clásicas aunque el perfil
   * esté activado, y `tac.on` del snapshot nunca miente.
   */
  get tacticalActive() {
    return tacticalActive(this.tacticalProfile, this.mode);
  }

  get barrelRollActive() {
    return this.tacticalProfile === true && (this.mode === 'asteroids' || this.mode === 'asteroids3' || this.mode === 'stocks');
  }

  // ------------------------------------------------------- coberturas (táctica)
  /**
   * Rehace el parque de coberturas (y los pads del mapa) de forma
   * DETERMINISTA. Se llama en reset/start/rematch/cambio de arena, de modo y de
   * campo de batalla. Sin perfil táctico no hay coberturas ni pads (juego
   * clásico intacto).
   *
   * Geometría:
   *  - `orbit` : reparto circular clásico (coverLayout) — idéntico a la v0.1.
   *  - `citadel` y demás: `buildBattlefield(id, world, seed)` del módulo de
   *    geometría (autoridad de rectángulos, zonas, pads y spawns).
   */
  ensureCovers() {
    this.pads = [];
    this.ids.pad = 0;
    this.ids.cover = 0;
    if (!this.tacticalActive) {
      this.covers = [];
      return this.covers;
    }
    if (this.battlefield === 'orbit') {
      const layout = coverLayout(this.world, this.seed, {
        count: TACTICAL.cover.count,
        radius: TACTICAL.cover.radius,
        margin: TACTICAL.cover.margin,
      });
      this.covers = layout.map((c) => ({
        id: ++this.ids.cover,
        x: c.x,
        y: c.y,
        r: TACTICAL.cover.radius,
        hp: TACTICAL.cover.hp,
        maxHp: TACTICAL.cover.hp,
        w: 0,
        h: 0,
        kind: 'block',
      }));
      this.spawns = null;
      return this.covers;
    }

    const geo = buildBattlefield(this.battlefield, this.world, this.seed) ?? {};
    this.covers = (geo.covers ?? []).map((c) => normalizeCover(c, ++this.ids.cover, this.world));
    this.pads = (geo.pads ?? [])
      .filter((p) => p && PAD[p.type])
      .map((p) => ({
        id: ++this.ids.pad,
        x: wrap(Number(p.x) || 0, this.world.w),
        y: wrap(Number(p.y) || 0, this.world.h),
        type: p.type,
        cd: 0,
      }));
    this.spawns = geo.spawns ?? null;
    return this.covers;
  }

  /**
   * Contacto (radio `r`) contra una cobertura. La AUTORIDAD es `coverContact`
   * del módulo de geometría (círculos legacy y rectángulos, toroidal).
   *
   * Red de seguridad: mientras ese módulo no ofrezca geometría (los tres
   * agentes se integran en paralelo), una cobertura SIN rectangularidad (la
   * cobertura circular clásica de `orbit`) conserva EXACTAMENTE la colisión de
   * la v0.1. Las coberturas rectangulares nunca se aproximan con un círculo:
   * si el módulo no las resuelve, no hay contacto (jamás un falso positivo).
   */
  coverContactAt(x, y, r, cover) {
    const hit = coverContact(x, y, r, cover, this.world);
    if (hit) return hit;
    if ((cover.w ?? 0) > 0 || (cover.h ?? 0) > 0) return null;
    const d = torusDistance(x, y, cover.x, cover.y, this.world);
    const minD = cover.r + r;
    if (d >= minD) return null;
    const near = torusDelta(cover.x, cover.y, x, y, this.world);
    const len = Math.hypot(near.dx, near.dy);
    if (len < 1e-6) return { nx: 1, ny: 0, depth: minD - d };
    return { nx: near.dx / len, ny: near.dy / len, depth: minD - d };
  }

  /** Cobertura que solapa el disco (x,y,r), o null. */
  coverAt(x, y, r) {
    for (const c of this.covers) {
      if (this.coverContactAt(x, y, r, c)) return c;
    }
    return null;
  }

  /**
   * ¿El segmento a→b está tapado por alguno de `shapes`?
   * Autoridad: `segmentBlocked` (sirve rectángulos y círculos: LOS de la
   * explosión del boomer y del humo). Se añade un test circular legacy SOLO
   * para formas sin rectangularidad (nubes de humo y coberturas circulares):
   * así "tapa" nunca deja de tapar, y las formas rectangulares no se aproximan
   * ni se sustituyen.
   */
  losBlocked(ax, ay, bx, by, shapes) {
    if (!shapes || shapes.length === 0) return false;
    if (segmentBlocked(ax, ay, bx, by, shapes, this.world)) return true;
    for (const s of shapes) {
      if ((s.w ?? 0) > 0 || (s.h ?? 0) > 0) continue;
      if (this.segmentCircle(ax, ay, bx, by, s)) return true;
    }
    return false;
  }

  /** Distancia mínima del centro de un círculo al segmento a→b (toroidal). */
  segmentCircle(ax, ay, bx, by, circle) {
    const seg = torusDelta(ax, ay, bx, by, this.world);
    const to = torusDelta(ax, ay, circle.x, circle.y, this.world);
    const len2 = seg.dx * seg.dx + seg.dy * seg.dy;
    const t = len2 <= 1e-9 ? 0 : clamp((to.dx * seg.dx + to.dy * seg.dy) / len2, 0, 1);
    const cx = to.dx - seg.dx * t;
    const cy = to.dy - seg.dy * t;
    return Math.hypot(cx, cy) <= circle.r;
  }

  /** Nubes de humo como círculos puros (para LOS y para la IA). */
  smokeCircles() {
    return this.smokes.map((s) => ({ x: s.x, y: s.y, r: s.r }));
  }

  /** ¿La LOS entre dos puntos está tapada por humo? (la IA no ve a través) */
  smokeBlocked(ax, ay, bx, by) {
    return this.losBlocked(ax, ay, bx, by, this.smokeCircles());
  }

  /** Obstáculos estáticos que la colina debe intentar esquivar. */
  coverObstacles() {
    return this.covers.map((c) => ({ x: c.x, y: c.y, r: c.r }));
  }

  // -------------------------------------------------- arena y colina (por partida)
  /** Payload de configuración para welcome/roster/snapshot. */
  settingsPayload() {
    const settings = { arena: this.arena, hillSeconds: this.hillSeconds };
    if (this.mode === 'stocks') settings.stocks = this.stocks;
    return settings;
  }

  /**
   * Estado de la colina para el cliente:
   *  - `remaining`: segundos hasta el movimiento (0 si nunca se mueve)
   *  - `nextX`/`nextY`: destino ya predeterminado (null si no hay rotación)
   * Fuera de koth la colina no existe como objetivo: no hay temporizador.
   */
  hillPayload() {
    const scheduled = this.rules.usesHill && this.hillSeconds > 0;
    return {
      x: r2(this.hill.x),
      y: r2(this.hill.y),
      r: this.hill.radius,
      remaining: scheduled ? r1(Math.max(0, this.hillRemaining)) : 0,
      nextX: scheduled && this.hillNext ? r2(this.hillNext.x) : null,
      nextY: scheduled && this.hillNext ? r2(this.hillNext.y) : null,
    };
  }

  /** Asteroides grandes ({x,y,r}) que la colina debe intentar esquivar. */
  largeRocks() {
    return this.asteroids
      .filter((a) => a.hp > 0 && a.size === 0)
      .map((a) => ({ x: a.x, y: a.y, r: ASTEROID_SIZES[0].r }));
  }

  /** Obstáculos que la colina evita: rocas grandes + coberturas tácticas. */
  hillObstacles() {
    return [...this.largeRocks(), ...this.coverObstacles()];
  }

  /**
   * ¿El CENTRO de la colina es transitable en este mapa? Se comprueba con el
   * contacto EXACTO (rectángulos y círculos) contra un disco de nave con un
   * pequeño colchón. En `orbit` (o sin arquitectura) siempre es cierto: la
   * política clásica no cambia.
   */
  hillCenterFree(x, y) {
    if (this.battlefield === 'orbit' || this.covers.length === 0) return true;
    const probe = SHIP.radius + 12;
    for (const c of this.covers) {
      if (this.coverContactAt(x, y, probe, c)) return false;
    }
    return true;
  }

  /**
   * Siguiente posición de la colina segun el mapa:
   *  - `orbit` (y mapas sin arquitectura): reglas clásicas intactas.
   *  - arquitectura (Ciudadela): solo el CENTRO debe ser transitable; la colina
   *    puede englobar coberturas. Se esquivan únicamente las rocas grandes.
   */
  nextHillPosition() {
    if (this.battlefield === 'orbit') {
      return pickHillPosition(this.world, this.rng, this.hill, this.hillObstacles());
    }
    return pickHillPositionOpen(this.world, this.rng, this.hill, {
      radius: this.hill.radius,
      rocks: this.largeRocks(),
      centerFree: (x, y) => this.hillCenterFree(x, y),
    });
  }

  /** Predetermina el próximo destino de la colina (aviso de últimos segundos). */
  scheduleNextHill() {
    if (this.hillSeconds <= 0) {
      this.hillNext = null;
      return null;
    }
    const next = this.nextHillPosition();
    this.hillNext = next ?? { x: this.world.w / 2, y: this.world.h / 2 };
    return this.hillNext;
  }

  /** Colina al centro de la arena: se usa al empezar y al reiniciar partida. */
  resetHill() {
    this.hill.x = this.world.w / 2;
    this.hill.y = this.world.h / 2;
    this.hillRemaining = this.hillSeconds;
    this.hillMoves = 0;
    this.hillStatus = 'idle';
    this.hillCounts = { cyan: 0, coral: 0 };
    this.scheduleNextHill();
    return this.hill;
  }

  /** Coloca la colina en una posición concreta (tests y casos manuales). */
  setHill(x, y) {
    this.hill.x = wrap(x, this.world.w);
    this.hill.y = wrap(y, this.world.h);
    this.hillCounts = { cyan: 0, coral: 0 };
    this.hillStatus = 'idle';
    return this.hill;
  }

  /**
   * Mueve la colina a su destino predeterminado. La ocupación se reinicia: no
   * queda ningún crédito de puntuación en la posición anterior.
   */
  moveHill() {
    const next = this.hillNext ?? this.nextHillPosition();
    this.hill.x = next?.x ?? this.world.w / 2;
    this.hill.y = next?.y ?? this.world.h / 2;
    this.hillRemaining = this.hillSeconds;
    this.hillCounts = { cyan: 0, coral: 0 };
    this.hillStatus = 'idle';
    this.hillMoves += 1;
    this.scheduleNextHill();
    this.emit({ k: 'hill_move', x: Math.round(this.hill.x), y: Math.round(this.hill.y) });
    return this.hill;
  }

  /**
   * Ancla del temporizador de la colina. SOLO corre en `playing` y en koth:
   * en lobby, cuenta atrás, final o modos sin colina no consume tiempo.
   */
  stepHillTimer(dt) {
    if (!this.rules.usesHill || this.hillSeconds <= 0) {
      this.hillRemaining = this.hillSeconds;
      return 0;
    }
    if (this.hillRemaining > dt) {
      this.hillRemaining -= dt;
      return 0;
    }
    this.moveHill();
    return 1;
  }

  /**
   * Cambia arena y/o segundos de rotación. Solo la sala decide cuándo puede
   * llamarse (lobby/ended); aquí se reorganiza el mundo de forma coherente.
   * Devuelve true si algo cambió.
   */
  applySettings({ arena, hillSeconds, stocks } = {}) {
    let changed = false;
    const nextArena = arena === undefined ? this.arena : sanitizeArena(arena);
    const nextHill = hillSeconds === undefined ? this.hillSeconds : sanitizeHillSeconds(hillSeconds);
    const nextStocks = stocks === undefined ? this.stocks : STOCK_OPTIONS.includes(Number(stocks)) ? Number(stocks) : null;
    if (nextArena === null || nextHill === null || nextStocks === null) return false;
    if (nextStocks !== this.stocks) { this.stocks = nextStocks; changed = true; }

    if (nextArena !== this.arena) {
      this.arena = nextArena;
      this.world = arenaWorld(nextArena);
      // Todo lo que estaba fuera del nuevo mundo vuelve a entrar (toro).
      for (const p of this.list()) {
        p.x = wrap(p.x, this.world.w);
        p.y = wrap(p.y, this.world.h);
      }
      for (const list of [this.bullets, this.asteroids, this.pickups]) {
        for (const e of list) {
          e.x = wrap(e.x, this.world.w);
          e.y = wrap(e.y, this.world.h);
        }
      }
      // El humo pertenece a la geometría que se va: se disipa al cambiar de
      // arena (y las nubes fuera del mundo nuevo volverían a entrar igualmente).
      this.smokes = [];
      this.ids.smoke = 0;
      // Las coberturas y los pads son de ESTA arena: se regeneran deterministas.
      this.ensureCovers();
      changed = true;
    }
    if (nextHill !== this.hillSeconds) {
      this.hillSeconds = nextHill;
      changed = true;
    }
    if (changed) this.resetHill();
    return changed;
  }

  /**
   * Cambia el CAMPO DE BATALLA de la partida (geometría: coberturas, pads y
   * anclas de aparición). La sala decide cuándo puede llamarse (solo anfitrión,
   * solo lobby/ended). Devuelve true si algo cambió de verdad.
   *
   * Es atómico: si el identificador no es válido no toca absolutamente nada.
   */
  setBattlefield(raw) {
    const clean = sanitizeBattlefield(raw);
    if (!clean || clean === this.battlefield) return false;
    this.battlefield = clean;
    // Todo lo que estaba fuera del mundo vuelve a entrar (el mundo no cambia
    // aquí, pero el mapa nuevo puede recolocar coberturas y pads).
    for (const p of this.list()) {
      p.x = wrap(p.x, this.world.w);
      p.y = wrap(p.y, this.world.h);
    }
    // El humo es de la geometría anterior: se disipa al mudarse de mapa.
    this.smokes = [];
    this.ids.smoke = 0;
    this.ensureCovers();
    // Nadie puede aparecer dentro de una cobertura del mapa nuevo.
    if (this.tacticalActive) {
      for (const p of this.list()) this.resolveCoverCollisions(p);
    }
    this.resetHill();
    return true;
  }

  /** Identificador del campo de batalla vigente (viaja fuera de `settings`). */
  battlefieldPayload() {
    return this.battlefield;
  }

  // ------------------------------------------------------------------ modos
  /** Cambia de modo y deja la partida en lobby, lista para la nueva partida. */
  setMode(mode, { silent = false } = {}) {
    const clean = sanitizeMode(mode);
    if (!clean) return false;
    this.mode = clean;
    this.rules = modeRules(clean);
    this.roundNumber = 1;
    this.backToLobby();
    // Cambiar de modo recompone el objetivo: la colina vuelve al centro y el
    // parque de coberturas se reconstruye (con o sin perfil táctico).
    this.ensureCovers();
    this.resetHill();
    // Coherencia de plantilla: en arcade nunca puede quedar un bot de la
    // partida anterior (la sala vuelve a completar los demás modos).
    if (!this.rules.bots) this.removeAllBots();
    if (!silent) this.emit({ k: 'mode', mode: clean });
    return true;
  }

  // ------------------------------------------------------------------ eventos
  emit(ev) {
    if (this.events.length < 64) this.events.push(ev);
  }

  drainEvents() {
    const ev = this.events;
    this.events = [];
    return ev;
  }

  // ----------------------------------------------------------------- jugadores
  addPlayer(id, { name, bot = false, team, slot = null, model = null }) {
    const p = {
      id,
      name,
      team,
      bot,
      slot: bot ? null : slot,   // plaza humana estable 1-8 (los bots no se numeran)
      alive: false,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      angle: 0,
      hp: SHIP.maxHp,
      lives: 3,
      fireCd: 0,
      boostCd: 0,
      boostTimer: 0,
      protectUntil: 0,
      respawnAt: 0,
      buffs: Object.fromEntries(BUFF_TYPES.map((type) => [type, 0])),
      kills: 0,
      deaths: 0,
      captures: 0,
      ack: 0,
      input: { seq: 0, rot: 0, thrust: false, brake: false, fire: false, boost: false },
      // ── estado táctico (inocuo cuando el perfil está apagado) ──────────
      weapon: WEAPON_DEFAULT,  // selección absoluta persistente por nave
      dashCd: 0,               // enfriamiento de esquiva
      dashTimer: 0,            // duración activa del impulso lateral
      dashVx: 0,
      dashVy: 0,
      dashHeld: false,         // flanco servidor: mantener no re-emite cada tick
      dashDir: 0,              // última dirección de esquiva pedida (-1/0/+1)
      downed: false,           // derribado (alive=false pero rescatable)
      downedUntil: 0,
      downedHp: 0,
      downedUsed: false,       // un derribo por vida: el siguiente letal mata
      reviveProgress: 0,
      reviverId: null,
      reserveKiller: null,     // asesino reservado si muere por desangrado
      // ── prototipo Ciudadela (v0.2) ────────────────────────────────────
      model: sanitizeShipModel(model) ?? SHIP_DEFAULT, // cosmético, nunca stats
      aiming: false,           // mantiene LT/L2 (apuntado) ahora mismo
      aimTime: 0,              // segundos de apuntado estable (autoritativo)
      aimCharge01: 0,          // 0..1: carga de apuntado (sniper 60 vs 110)
      ammoSniper: 0,           // munición de arma especial (solo de pads)
      ammoBoomer: 0,
      smokeAmmo: SMOKE.ammo,   // granadas de humo por vida
      smokeCd: 0,
      bounceCd: 0,             // enfriamiento de rebote de pared
      bounceTimer: 0,
      bounceVx: 0,
      bounceVy: 0,
      smokeHeld: false,        // flanco servidor: mantener no repite
      bounceHeld: false,
      ai: bot ? { timer: 0, rot: 0, thrust: false, fire: false, boost: false, wander: 0 } : null,
    };
    this.players.set(id, p);
    if (this.phase === 'playing' || this.phase === 'countdown') this.spawnPlayer(p);
    return p;
  }

  removePlayer(id) {
    this.players.delete(id);
    this.bullets = this.bullets.filter((b) => b.owner !== id);
  }

  getPlayer(id) {
    return this.players.get(id) ?? null;
  }

  list() {
    return [...this.players.values()];
  }

  listTeam(team) {
    return this.list().filter((p) => p.team === team);
  }

  countHumans() {
    return this.list().filter((p) => !p.bot).length;
  }

  /** Crea un bot en la facción indicada, reutilizando nombres libres. */
  addBot(team) {
    const used = new Set(this.list().map((p) => p.name));
    const name = BOT_NAMES.find((n) => !used.has(n)) ?? `Bot-${this.ids.player + 1}`;
    const id = `b${++this.ids.player}`;
    // Los bots recorren todo el catálogo cosmético (reparto determinista y
    // equilibrado; jamás cambia ninguna estadística).
    const model = SHIP_MODELS[this.botModelSeq++ % SHIP_MODELS.length].id;
    return this.addPlayer(id, { name, bot: true, team, model });
  }

  /**
   * Rellena la sala con bots segun el modo:
   *  - koth/tdm: 4 por equipo (bots reemplazables).
   *  - ffa: hasta 8 jugadores, cada uno con su propia facción.
   *  - arcade: ninguno (cooperativo sin bots enemigos).
   * Devuelve cuantos bots se añadieron.
   */
  fillWithBots() {
    if (!this.rules.bots) return 0;
    let added = 0;
    if (this.rules.botsFill === 'players') {
      const used = new Set(this.list().map((p) => p.team));
      let idx = 0;
      while (this.list().length < 8) {
        while (used.has(ffaTeamForIndex(idx))) idx += 1;
        const team = ffaTeamForIndex(idx);
        used.add(team);
        idx += 1;
        this.addBot(team);
        added += 1;
      }
      return added;
    }
    for (const team of TEAMS) {
      while (this.listTeam(team).length < TEAM_SIZE) {
        this.addBot(team);
        added += 1;
      }
    }
    return added;
  }

  /** Quita todos los bots (necesario al pasar a arcade). */
  removeAllBots() {
    let removed = 0;
    for (const p of this.list()) {
      if (p.bot) {
        this.removePlayer(p.id);
        removed += 1;
      }
    }
    return removed;
  }

  /** Quita un bot del equipo para dejar sitio a un humano. */
  removeBotFrom(team) {
    const bot = this.listTeam(team).find((p) => p.bot);
    if (!bot) return null;
    this.removePlayer(bot.id);
    return bot;
  }

  /** Quita cualquier bot (usado en ffa cuando el puesto del humano lo ocupa uno). */
  removeAnyBot() {
    const bot = this.list().find((p) => p.bot);
    if (!bot) return null;
    this.removePlayer(bot.id);
    return bot;
  }

  /** Facción libre para un humano en ffa (ninguna repetida si hay huecos). */
  freeFfaTeam() {
    const used = new Set(this.list().map((p) => p.team));
    const free = FFA_TEAMS.find((t) => !used.has(t));
    return free ?? ffaTeamForIndex(this.list().length);
  }

  setTeam(id, team) {
    const p = this.getPlayer(id);
    if (!p) return false;
    p.team = team;
    return true;
  }

  setInput(id, input) {
    const p = this.getPlayer(id);
    if (!p) return false;
    // Guardar la activación separada de la intención continua: un paquete
    // neutro puede llegar antes del siguiente tick sin borrar la pulsación.
    if (input.dashId === 0) p.pendingDash = null; // blur / menú: cancelación explícita
    if (Number.isSafeInteger(input.dashId) && input.dashId > (p.lastDashId ?? 0)) {
      p.lastDashId = input.dashId;
      if (this.phase === 'playing' && (this.tacticalActive || this.barrelRollActive) && p.alive && !p.downed && input.dash) {
        p.pendingDash = { ...input };
      }
    }
    p.input = input;
    p.ack = input.seq;
    return true;
  }

  // ------------------------------------------------------------------ ciclo
  resetArena() {
    this.asteroids = [];
    this.bullets = [];
    this.ids.asteroid = 0;
    for (let i = 0; i < ASTEROID_START_COUNT; i++) this.spawnAsteroid(0);
  }

  spawnAsteroid(sizeIndex = 0, x = null, y = null, superCore = false) {
    if (this.asteroids.length >= ASTEROID_MAX) return null;
    const size = clamp(sizeIndex | 0, 0, ASTEROID_SIZES.length - 1);
    const rng = this.rng;
    const angle = rng() * Math.PI * 2;
    const speed = rand(rng, 26, 74) * (size === 0 ? 0.75 : 1.15);
    let px = x;
    let py = y;
    if (px === null || py === null) {
      // Aparece lejos de la colina DE ESTA PARTIDA para no aplastarla al inicio.
      const a = rng() * Math.PI * 2;
      const d = this.hill.radius + 220 + rng() * 320;
      px = wrap(this.hill.x + Math.cos(a) * d, this.world.w);
      py = wrap(this.hill.y + Math.sin(a) * d, this.world.h);
    }
    const a = {
      id: ++this.ids.asteroid,
      x: px,
      y: py,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      angle: rng() * Math.PI * 2,
      spin: rand(rng, -0.9, 0.9),
      size,
      hp: ASTEROID_SIZES[size].hp,
      shape: asteroidShape(this.seed + this.ids.asteroid * 977),
      superCore,
    };
    this.asteroids.push(a);
    return a;
  }

  stepSuperCore(dt) {
    if (this.mode !== 'stocks') return;
    this.superTimer = (this.superTimer ?? 0) + dt;
    if (this.superCore && this.superCore.hp > 0) return;
    if (this.superTimer < 20) return;
    this.superTimer = 0;
    const core = this.spawnAsteroid(2, this.world.w * 0.5, this.world.h * 0.5, true);
    if (core) { core.hp = 90; this.superCore = core; this.emit({ k: 'super_spawn', x: Math.round(core.x), y: Math.round(core.y) }); }
  }

  clearBuffs(p) {
    for (const type of BUFF_TYPES) p.buffs[type] = 0;
    p.speedBoost = 1;
  }

  /** Limpia por completo el estado de derribo (al reaparecer o entre rondas). */
  clearDowned(p) {
    p.downed = false;
    p.downedUntil = 0;
    p.downedHp = 0;
    p.downedUsed = false;
    p.reviveProgress = 0;
    p.reviverId = null;
    p.reserveKiller = null;
  }

  /**
   * Punto de aparición de una nave: ancla del mapa si el campo de batalla la
   * declara (con dispersión determinista alrededor), o el reparto clásico por
   * lados en `orbit`/modos sin equipos reales.
   */
  pickSpawn(p) {
    const anchors = this.spawns;
    if (anchors && (p.team === 'cyan' || p.team === 'coral') && anchors[p.team]) {
      const base = anchors[p.team];
      const ang = this.rng() * Math.PI * 2;
      const dist = this.rng() * 90;
      return {
        x: wrap(base.x + Math.cos(ang) * dist, this.world.w),
        y: wrap(base.y + Math.sin(ang) * dist, this.world.h),
        angle: p.team === 'cyan' ? 0 : Math.PI,
      };
    }
    return chooseSpawn(p.team, this.rng, this.mode, this.world);
  }

  /**
   * Carga de una vida: la munición ESPECIAL (pads) y las cargas de habilidad se
   * pierden al morir; el humo vuelve a sus 2 granadas por vida y el arma vuelve
   * a la base si la elegida era una especial agotada. Nunca toca las stats.
   */
  resetLifeLoadout(p) {
    p.ammoSniper = 0;
    p.ammoBoomer = 0;
    p.smokeAmmo = SMOKE.ammo;
    p.smokeCd = 0;
    p.bounceCd = 0;
    p.bounceTimer = 0;
    p.bounceVx = 0;
    p.bounceVy = 0;
    p.aiming = false;
    p.aimTime = 0;
    p.aimCharge01 = 0;
    p.smokeHeld = false;
    p.bounceHeld = false;
    if (p.weapon === 'sniper' || p.weapon === 'boomer') p.weapon = WEAPON_DEFAULT;
    return p;
  }

  spawnPlayer(p) {
    const spawn = this.pickSpawn(p);
    p.x = spawn.x;
    p.y = spawn.y;
    p.vx = 0;
    p.vy = 0;
    p.angle = spawn.angle;
    p.hp = SHIP.maxHp;
    p.alive = true;
    p.fireCd = 0;
    p.boostCd = 0;
    p.boostTimer = 0;
    p.respawnAt = 0;
    p.dashCd = 0;
    p.dashTimer = 0;
    p.dashVx = 0;
    p.dashVy = 0;
    p.pendingDash = null;
    p.dashHeld = false;
    p.dashDir = 0;
    this.resetLifeLoadout(p);
    this.clearBuffs(p);
    this.clearDowned(p);
    p.protectUntil = this.time + PROTECT_SECONDS;
    // Nunca debe aparecer dentro de una cobertura: si el azar lo deja debajo,
    // se empuja fuera de forma resuelta y determinista.
    if (this.tacticalActive) this.resolveCoverCollisions(p);
    this.emit({ k: 'respawn', x: Math.round(p.x), y: Math.round(p.y), team: p.team });
  }

  startMatch() {
    this.phase = 'countdown';
    this.countdown = COUNTDOWN_SECONDS;
    this.timeLeft = this.rules.timeLimit ?? 0;
    this.score = { cyan: 0, coral: 0 };
    this.teamKills = { cyan: 0, coral: 0 };
    this.winner = null;
    this.winReason = null;
    this.winnerId = null;
    this.hillStatus = 'idle';
    this.hillCounts = { cyan: 0, coral: 0 };
    this.bullets = [];
    this.pickups = [];
    this.ids.pickup = 0;
    // El humo y los pads son de la ronda anterior: se limpian por completo.
    this.smokes = [];
    this.ids.smoke = 0;
    this.wave = 0;
    this.waveTimer = 0;
    this.superTimer = 0;
    this.superCore = null;
    this.respawnTimer = 0;
    this.chaosDropTimer = 0;
    // La colina vuelve al centro y su temporizador arranca de cero con la
    // configuración vigente (el rematch conserva arena/hillSeconds).
    this.resetHill();
    // Rematch: las coberturas se reconstruyen iguales (deterministas) y con
    // la vida al máximo.
    this.ensureCovers();

    if (this.mode === 'arcade') {
      this.lives = ARCADE.sharedLives;
      this.asteroids = [];
      this.startWave(1);
    } else {
      this.lives = 0;
      this.resetArena();
    }

    for (const p of this.list()) {
      this.clearDowned(p);
      p.dashCd = 0;
      p.dashTimer = 0;
      p.dashVx = 0;
      p.dashVy = 0;
      p.pendingDash = null;
      p.dashHeld = false;
      p.dashDir = 0;
      this.spawnPlayer(p);
      p.kills = 0;
      p.deaths = 0;
      p.lives = this.mode === 'stocks' ? this.stocks : this.mode === 'asteroids' ? 3 : 0;
      p.hits = this.mode === 'asteroids3' ? 3 : 0;
      p.captures = 0;
      this.clearBuffs(p);
    }
    this.emit({ k: 'start', mode: this.mode });
  }

  backToLobby() {
    this.phase = 'lobby';
    this.countdown = 0;
    this.bullets = [];
    this.asteroids = [];
    this.pickups = [];
    this.smokes = [];
    this.ids.smoke = 0;
    this.events = [];
    this.winner = null;
    this.winReason = null;
    this.winnerId = null;
    this.score = { cyan: 0, coral: 0 };
    this.teamKills = { cyan: 0, coral: 0 };
    this.timeLeft = this.rules.timeLimit ?? 0;
    this.wave = 0;
    this.lives = 0;
    this.waveTimer = 0;
    this.chaosDropTimer = 0;
    for (const p of this.list()) {
      p.alive = false;
      p.hp = SHIP.maxHp;
      p.vx = 0;
      p.vy = 0;
      p.fireCd = 0;
      p.boostCd = 0;
      p.boostTimer = 0;
      p.protectUntil = 0;
      p.respawnAt = 0;
      p.dashCd = 0;
      p.dashTimer = 0;
      p.dashVx = 0;
      p.dashVy = 0;
      p.pendingDash = null;
      p.dashHeld = false;
      p.dashDir = 0;
      this.resetLifeLoadout(p);
      p.weapon = WEAPON_DEFAULT;
      this.clearDowned(p);
      this.clearBuffs(p);
    }
    // Los pads del mapa vuelven a estar disponibles entre rondas.
    for (const pad of this.pads) pad.cd = 0;
  }

  endMatch(winner, reason, winnerId = null) {
    this.phase = 'ended';
    this.winner = winner;
    this.winReason = reason;
    this.winnerId = winnerId;
    this.endedTimer = ENDED_SECONDS;
    // En la pausa final no progresa ni el rescate ni el combate: nadie queda
    // "derribado" colgado en la pantalla de resultado.
    for (const p of this.list()) this.clearDowned(p);
    this.emit({ k: 'win', team: winner, reason, id: winnerId });
  }

  /** Un paso de simulacion. dt en segundos. */
  tick(dt = DT) {
    this.time += dt;
    this.tickCount += 1;

    if (this.phase === 'ended') {
      this.endedTimer = Math.max(0, this.endedTimer - dt);
      return;
    }
    if (this.phase === 'countdown') {
      this.countdown -= dt;
      // Durante la cuenta atrás nadie debe quedar sin protección: la ventana de
      // spawn no se consume mientras se prepara la partida.
      for (const p of this.list()) {
        if (p.alive) p.protectUntil = Math.max(p.protectUntil, this.time + PROTECT_SECONDS);
      }
      if (this.countdown <= 0) {
        this.countdown = 0;
        this.phase = 'playing';
        // Al empezar a jugar la protección arranca entera (2.5 s completos).
        for (const p of this.list()) {
          if (p.alive) p.protectUntil = this.time + PROTECT_SECONDS;
        }
        this.emit({ k: 'go' });
      }
      return;
    }
    if (this.phase !== 'playing') return;

    if (this.rules.timeLimit != null) this.timeLeft = Math.max(0, this.timeLeft - dt);

    this.stepPlayers(dt);
    this.stepRevives(dt);
    this.stepBullets(dt);
    this.stepAsteroids(dt);
    this.stepSuperCore(dt);
    this.stepPickups(dt);
    if (this.mode === 'chaos') this.stepChaosDrops(dt);
    this.stepSmokes(dt);
    this.stepPads(dt);
    if (this.mode === 'arcade') this.stepWaves(dt);
    else this.stepAsteroidRespawn(dt);

    this.stepScores(dt);
    if (this.mode === 'arcade') {
      this.checkArcadeOutcome();
      return;
    }
    if (this.mode === 'asteroids' || this.mode === 'asteroids3' || this.mode === 'stocks') {
      const outcome = this.checkAsteroidsOutcome();
      if (outcome) this.endMatch(outcome, outcome === 'draw' ? 'time' : 'lives');
      return;
    }
    const outcome = checkWin(this.score, this.timeLeft, this.rules.target);
    if (outcome.over) {
      const cap = this.rules.target;
      this.score.cyan = Math.min(this.score.cyan, cap);
      this.score.coral = Math.min(this.score.coral, cap);
      this.endMatch(outcome.winner, outcome.reason, this.winnerIdFor(outcome));
    }
  }

  winnerIdFor(outcome) {
    if (this.mode !== 'ffa' || outcome.winner === 'draw') return null;
    return this.ffaLeader ?? null;
  }

  checkAsteroidsOutcome() {
    const teams = new Set(this.list().filter((p) => this.mode === 'asteroids3' ? (p.hits > 0 && p.alive) : (p.lives > 0 || p.alive)).map((p) => p.team));
    const cyan = teams.has('cyan');
    const coral = teams.has('coral');
    if (cyan && coral) {
      if (this.timeLeft > 0) return null;
      return this.score.cyan === this.score.coral ? 'draw' : this.score.cyan > this.score.coral ? 'cyan' : 'coral';
    }
    if (cyan) return 'cyan';
    if (coral) return 'coral';
    return 'draw';
  }

  stepPlayers(dt) {
    for (const p of this.list()) {
      p.fireCd = Math.max(0, p.fireCd - dt);
      p.boostCd = Math.max(0, p.boostCd - dt);
      p.dashCd = Math.max(0, p.dashCd - dt);
      p.bounceCd = Math.max(0, p.bounceCd - dt);
      p.smokeCd = Math.max(0, p.smokeCd - dt);
      for (const key of BUFF_TYPES) p.buffs[key] = Math.max(0, p.buffs[key] - dt);

      if (p.downed) {
        // Un derribado no apunta, no dispara, no esquiva, no rebota, no humea y
        // no recoge nada: solo se arrastra (y puede ser rematado).
        this.setAiming(p, false, dt);
        p.smokeHeld = false;
        p.bounceHeld = false;
        p.pendingDash = null;
        p.dashHeld = false;
        p.dashDir = 0;
        this.stepDownedPlayer(p, dt);
        continue;
      }

      if (!p.alive) {
        this.setAiming(p, false, dt);
        p.smokeHeld = false;
        p.bounceHeld = false;
        p.pendingDash = null;
        p.dashHeld = false;
        p.dashDir = 0;
        if (this.time >= p.respawnAt) this.spawnPlayer(p);
        continue;
      }

      if (p.bot) this.botThink(p, dt);
      const input = p.input;
      p.speedBoost = p.buffs.overdrive > 0 ? POWERUP.overdriveFactor : 1;

      // Modelo cosmético: persistente por jugador; solo se cambia si el cliente
      // manda un identificador válido (el saneador ya lo garantiza).
      if (input?.model) p.model = input.model;

      // Arma: selección absoluta y persistente (solo si el cliente la envía y
      // SOLO si tiene munición cuando es especial; pedir un arma vacía no hace
      // nada: la autoridad no regala balas).
      if (this.tacticalActive) this.applyWeaponSelection(p, input);

      // Apuntado (LT/L2): carga autoritativa y orientación por `aimAngle`.
      this.setAiming(p, this.tacticalActive && input?.aim === true && Number.isFinite(input.aimAngle), dt);

      // Esquiva lateral autoritativa. Con enfriamiento 0 (prototipo Zero Dash)
      // una NUEVA pulsación o un cambio de dirección reinicia el impulso aunque
      // haya uno activo; mantener la MISMA dirección solo encadena al terminar
      // su duración (jamás re-emite 60 eventos por segundo).
      if (this.tacticalActive || this.barrelRollActive) {
        const dir = clamp(Math.trunc(input.dash) || 0, -1, 1);
        const pending = p.pendingDash;
        p.pendingDash = null;
        if (pending && p.dashCd <= 0) {
          this.startDash(p, pending.dash, pending);
        } else if (dir !== 0 && input.dashId === undefined) {
          const rising = !p.dashHeld;          // nueva pulsación
          const turned = dir !== p.dashDir;    // reverso/giro mientras se mantiene
          if (p.dashCd <= 0 && (rising || turned || p.dashTimer <= 0)) this.startDash(p, dir);
        }
        p.dashHeld = dir !== 0;
        p.dashDir = dir;
      }

      // Rebote de pared (A/✕): por FLANCO (mantener no repite), solo cerca de
      // una cobertura y con cooldown propio. No da invulnerabilidad.
      const bouncePressed = this.tacticalActive && input.bounce === true && !p.bounceHeld;
      p.bounceHeld = input.bounce === true;
      if (bouncePressed) this.startBounce(p);

      // Granada de humo (R3): por FLANCO, gasta carga y respeta su cooldown.
      const smokePressed = this.tacticalActive && input.smoke === true && !p.smokeHeld;
      p.smokeHeld = input.smoke === true;
      if (smokePressed) this.throwSmoke(p);

      // El boost clásico NO se bloquea por un `aim` que el modo no usa: en FFA
      // y arcade `input.aim` se ignora por completo (no hay apuntado), así que
      // el boost legacy sigue funcionando igual que siempre.
      if (input.boost && p.buffs.jam <= 0 && !p.aiming && p.boostCd <= 0 && p.boostTimer <= 0) {
        p.boostTimer = SHIP.boostDuration;
        p.boostCd = SHIP.boostCooldown;
      }

      // Vuelo: en modos Clásicos (FFA/arcade, `tac.on` false) el input se filtra
      // a los 6 campos LEGACY. Así un cliente malicioso no puede habilitar
      // apuntado ni strafe en partidas donde esa física no existe.
      const flightBase = this.tacticalActive ? input : legacyFlight(input);
      const flight = p.buffs.jam > 0 ? { ...flightBase, boost: false } : flightBase;
      stepShip(p, flight, dt, this.world);

      // Impulsos (esquiva y rebote): se aplican DESPUÉS de la física normal para
      // que el tope de velocidad clásico no los anule de golpe; decaen y NUNCA
      // dan invulnerabilidad. La resolución de coberturas va después, así que
      // tampoco atraviesan ninguna pared.
      if (p.dashTimer > 0) {
        p.x = wrap(p.x + p.dashVx * dt, this.world.w);
        p.y = wrap(p.y + p.dashVy * dt, this.world.h);
        p.dashTimer = Math.max(0, p.dashTimer - dt);
        if (p.dashTimer === 0) {
          p.dashVx = 0;
          p.dashVy = 0;
        }
      }
      if (p.bounceTimer > 0) {
        p.x = wrap(p.x + p.bounceVx * dt, this.world.w);
        p.y = wrap(p.y + p.bounceVy * dt, this.world.h);
        p.bounceTimer = Math.max(0, p.bounceTimer - dt);
        if (p.bounceTimer === 0) {
          p.bounceVx = 0;
          p.bounceVy = 0;
        }
      }

      if (this.tacticalActive) this.resolveCoverCollisions(p);

      if (input.fire && p.fireCd <= 0) this.firePlayer(p);
    }
  }

  /**
   * Estado de apuntado autoritativo: `p.aiming`, `p.aimTime` (segundos) y
   * `p.aimCharge01` (0..1 frente a `AIM.steadySeconds`). Es ESTABLE: se acumula
   * mientras se mantiene LT aunque el morro siga girando.
   */
  setAiming(p, aiming, dt) {
    if (!aiming) {
      p.aiming = false;
      p.aimTime = 0;
      p.aimCharge01 = 0;
      return false;
    }
    p.aiming = true;
    p.aimTime += dt;
    p.aimCharge01 = Math.min(1, p.aimTime / AIM.steadySeconds);
    return true;
  }

  /**
   * Arma pedida por el cliente. Auto y plasma están SIEMPRE disponibles; las
   * especiales exigen munición (que solo dan los pads del mapa). Pedir un arma
   * especial sin munición es una INTENCIÓN VACÍA: se ignora sin consecuencias.
   */
  applyWeaponSelection(p, input) {
    const want = input?.weapon;
    if (want === 'auto' || want === 'plasma') {
      p.weapon = want;
      return true;
    }
    if (want === 'sniper' && p.ammoSniper > 0) {
      p.weapon = 'sniper';
      return true;
    }
    if (want === 'boomer' && p.ammoBoomer > 0) {
      p.weapon = 'boomer';
      return true;
    }
    return false;
  }

  /**
   * Esquiva lateral relativa a la orientación. Sin invulnerabilidad: el que
   * esquiva sigue siendo dañable. Dirección -1 = izquierda, +1 = derecha.
   */
  startDash(p, dir, command = p.input) {
    const side = dir < 0 ? -1 : 1;
    const directional = sanitizeFlight(command?.flight) && Math.hypot(command.moveX ?? 0, command.moveY ?? 0) > 0.3;
    const angle = directional ? Math.atan2(command.moveY ?? 0, command.moveX ?? 0) : p.angle + side * (Math.PI / 2);
    p.dashVx = Math.cos(angle) * this.dashSpeed;
    p.dashVy = Math.sin(angle) * this.dashSpeed;
    p.dashTimer = TACTICAL.dash.duration;
    // En Asteroids/Stocks la esquiva es un barrel roll defensivo: conserva el
    // impulso, pero tiene una espera breve para que no sea permanente.
    p.dashCd = (this.mode === 'asteroids' || this.mode === 'asteroids3' || this.mode === 'stocks')
      ? 2.4
      : this.dashCooldown;
    this.emit({ k: 'dash', id: p.id, x: Math.round(p.x), y: Math.round(p.y), team: p.team });
  }

  /**
   * Rebote de pared: exige estar CERCA de una cobertura (rango desde el casco)
   * y un cooldown propio; sale con un impulso NORMAL + TANGENTE de magnitud
   * acotada. No da invulnerabilidad y la resolución de coberturas posterior
   * garantiza que no atraviesa la pared.
   *
   * La tangente se elige por el sentido en el que la nave ya se desliza; si
   * está prácticamente parada, se usa un criterio determinista estable.
   */
  startBounce(p) {
    if (!this.tacticalActive || p.bounceCd > 0) return false;
    const near = this.nearestCoverContact(p);
    if (!near) return false;

    let nx = near.nx;
    let ny = near.ny;
    // Robustez de la normal: debe apuntar FUERA de la cobertura.
    if (this.coverContactAt(wrap(p.x + nx * 2, this.world.w), wrap(p.y + ny * 2, this.world.h), SHIP.radius, near.cover)) {
      nx = -nx;
      ny = -ny;
    }

    const speed = Math.hypot(p.vx, p.vy);
    let side = 0;
    if (speed > 1) {
      const cross = p.vx * ny - p.vy * nx;
      side = cross === 0 ? 0 : Math.sign(cross);
    }
    if (side === 0) side = p.id.charCodeAt(p.id.length - 1) % 2 === 0 ? 1 : -1;

    // Normal + tangente, normalizado y con el tope de velocidad del contrato.
    const tx = -ny;
    const ty = nx;
    const ux = nx + tx * side * 0.9;
    const uy = ny + ty * side * 0.9;
    const len = Math.hypot(ux, uy) || 1;
    p.bounceVx = (ux / len) * BOUNCE.speed;
    p.bounceVy = (uy / len) * BOUNCE.speed;
    p.bounceTimer = BOUNCE.duration;
    p.bounceCd = BOUNCE.cooldown;
    // Sale del contacto antes de impulsarse: arranca pegado a la superficie.
    this.resolveCoverCollisions(p);
    this.emit({ k: 'bounce', id: p.id, x: Math.round(p.x), y: Math.round(p.y), team: p.team });
    return true;
  }

  /**
   * Cobertura más cercana al casco dentro del rango de rebote. Se sondea con un
   * disco inflado (`SHIP.radius + BOUNCE.range`): el contacto devuelve normal y
   * profundidad, y vale la MENOR profundidad (la superficie más próxima).
   */
  nearestCoverContact(p) {
    const reach = SHIP.radius + BOUNCE.range;
    let best = null;
    for (const c of this.covers) {
      const hit = this.coverContactAt(p.x, p.y, reach, c);
      if (!hit) continue;
      const depth = Number.isFinite(hit.depth) ? hit.depth : 0;
      if (!best || depth < best.depth) best = { cover: c, nx: hit.nx, ny: hit.ny, depth };
    }
    return best;
  }
  stepDownedPlayer(p, dt) {
    const input = p.input ?? {};
    stepShip(p, { rot: input.rot ?? 0, thrust: input.thrust === true, brake: false, boost: false }, dt, this.world);
    const speed = Math.hypot(p.vx, p.vy);
    const max = TACTICAL.downed.speed;
    if (speed > max) {
      p.vx = (p.vx / speed) * max;
      p.vy = (p.vy / speed) * max;
    }
    if (this.tacticalActive) this.resolveCoverCollisions(p);
    if (this.time >= p.downedUntil) {
      // Desangrado: la baja final se acredita al asesino reservado.
      this.finalDeath(p, p.reserveKiller ?? null);
    }
  }

  /**
   * Progreso de rescate. Solo un ayudante efectivo (el aliado vivo más
   * cercano con `interact` dentro del radio); más ayudantes no aceleran. Se
   * reinicia si el ayudante se aleja, suelta, muere o cambia.
   */
  stepRevives(dt) {
    if (!this.tacticalActive) return;
    const R = TACTICAL.downed;
    for (const p of this.list()) {
      if (!p.downed) continue;
      const isValid = (o) =>
        o != null &&
        o.id !== p.id &&
        o.alive &&
        o.team === p.team &&
        o.input?.interact === true &&
        torusDistance(o.x, o.y, p.x, p.y, this.world) <= R.reviveRadius;

      // Ayudante "pegajoso": mientras el rescatador en curso siga siendo
      // válido se mantiene, aunque otro aliado se acerque más. Así varios bots
      // que convergen no se turnan el rescate ni reinician el progreso.
      let helper = isValid(this.getPlayer(p.reviverId)) ? this.getPlayer(p.reviverId) : null;
      if (!helper) {
        let best = Infinity;
        for (const o of this.list()) {
          if (!isValid(o)) continue;
          const d = torusDistance(o.x, o.y, p.x, p.y, this.world);
          if (d < best) {
            best = d;
            helper = o;
          }
        }
      }
      if (!helper) {
        p.reviveProgress = 0;
        p.reviverId = null;
        continue;
      }
      if (p.reviverId !== helper.id) {
        // Solo se llega aquí si el rescatador anterior dejó de ser válido:
        // el relevo empieza de cero (cambio de ayudante = interrupción).
        p.reviveProgress = 0;
        p.reviverId = helper.id;
      }
      p.reviveProgress = Math.min(R.reviveSeconds, p.reviveProgress + dt);
      if (p.reviveProgress >= R.reviveSeconds) this.revivePlayer(p, helper);
    }
  }

  revivePlayer(p, helper) {
    p.downed = false;
    p.downedHp = 0;
    p.downedUntil = 0;
    p.reviveProgress = 0;
    p.reviverId = null;
    p.reserveKiller = null;
    p.hp = TACTICAL.downed.reviveHp;
    p.alive = true;
    p.vx = 0;
    p.vy = 0;
    p.dashTimer = 0;
    p.dashVx = 0;
    p.dashVy = 0;
    p.dashCd = 0;
    p.pendingDash = null;
    p.dashHeld = false;
    p.dashDir = 0;
    p.protectUntil = this.time + TACTICAL.downed.reviveProtect;
    this.emit({ k: 'revived', id: p.id, x: Math.round(p.x), y: Math.round(p.y), team: p.team, by: helper?.id ?? null });
  }

  /**
   * Disparo autoritativo. Enruta por arma: auto (clásica), plasma (escopeta),
   * sniper y boomer (especiales de pad). Si un arma especial se quedara sin
   * munición, cae a la base: nunca se dispara gratis.
   */
  firePlayer(p) {
    const weapon = this.tacticalActive ? p.weapon : WEAPON_DEFAULT;
    if (weapon === 'plasma') return this.firePlasma(p);
    if (weapon === 'sniper') {
      if (p.ammoSniper > 0) return this.fireSniper(p);
      p.weapon = WEAPON_DEFAULT;
      return this.fireAuto(p);
    }
    if (weapon === 'boomer') {
      if (p.ammoBoomer > 0) return this.fireBoomer(p);
      p.weapon = WEAPON_DEFAULT;
      return this.fireAuto(p);
    }
    return this.fireAuto(p);
  }

  /** Cañón automático clásico (con cadencias y topes por buff). */
  fireAuto(p) {
    const special = p.buffs.mine > 0 ? { speed: 0, life: 8, damage: 90, radius: 6, kind: 'mine' }
      : p.buffs.laser > 0 ? { speed: 1800, life: .18, damage: 14, kind: 'laser' }
      : p.buffs.homing > 0 ? { speed: 520, life: 2.2, damage: 28, kind: 'homing' }
      : null;
    const rapid = p.buffs.rapid > 0;
    const spread = p.buffs.spread > 0;
    const barrage = p.buffs.barrage > 0;
    const cooldown = p.buffs.heavy > 0 ? .11 : rapid ? POWERUP.rapidCooldown : barrage ? .32 : special ? .34 : BULLET.cooldown;
    const maxLive = barrage ? POWERUP.spreadMaxLive : rapid ? POWERUP.rapidMaxLive : spread ? POWERUP.spreadMaxLive : BULLET.maxLive;
    const live = this.bullets.filter((b) => b.owner === p.id).length;
    const shots = barrage ? POWERUP.barrageCount : spread ? POWERUP.spreadCount : 1;
    const capacity = Math.max(0, Math.min(maxLive - live, BULLET.maxTotal - this.bullets.length));

    if (capacity <= 0) {
      p.fireCd = cooldown * 0.5;
      return 0;
    }
    const n = Math.min(shots, capacity);
    for (let i = 0; i < n; i++) {
      const angle = barrage ? POWERUP.barrageAngle : POWERUP.spreadAngle;
      const offset = n > 1 ? (i - (n - 1) / 2) * angle : 0;
      const b = spawnBullet(p, ++this.ids.bullet, offset, this.world, special ?? (p.buffs.heavy > 0 ? { damage: 12, kind: 'heavy' } : undefined));
      this.bullets.push(b);
      this.emit({ k: 'shoot', x: Math.round(b.x), y: Math.round(b.y), team: p.team });
    }
    p.fireCd = cooldown;
    return n;
  }

  /**
   * Rifle de francotirador: UNA bala rapidísima y muy dañina. El daño depende
   * de la carga de apuntado AUTORITATIVA: 110 con el apuntado estable
   * (`AIM.steadySeconds`) y 60 a la cadera. Cadencia fija (1.35 s) y munición
   * de pad: al gastar la última bala el arma vuelve a la base.
   */
  fireSniper(p) {
    const A = ARSENAL.sniper;
    if (p.ammoSniper <= 0) {
      p.weapon = WEAPON_DEFAULT;
      return this.fireAuto(p);
    }
    if (this.bullets.length >= BULLET.maxTotal) {
      p.fireCd = A.cooldown;
      return 0;
    }
    const aimed = (p.aimCharge01 ?? 0) >= 1;
    const b = spawnBullet(p, ++this.ids.bullet, 0, this.world, {
      speed: A.speed,
      life: A.life,
      damage: aimed ? A.damageAimed : A.damageHip,
      radius: BULLET.radius,
      kind: 'sniper',
    });
    b.aimed = aimed;
    this.bullets.push(b);
    p.ammoSniper -= 1;
    if (p.ammoSniper <= 0) p.weapon = WEAPON_DEFAULT;
    p.fireCd = A.cooldown;
    this.emit({ k: 'shoot', x: Math.round(b.x), y: Math.round(b.y), team: p.team, w: 'sniper' });
    return 1;
  }

  /**
   * Lanzagranadas boomer: proyectil lento que estalla al chocar (o al agotar su
   * mecha) con un área de 135. El daño de área lo resuelve `boomerBlast`.
   */
  fireBoomer(p) {
    const A = ARSENAL.boomer;
    if (p.ammoBoomer <= 0) {
      p.weapon = WEAPON_DEFAULT;
      return this.fireAuto(p);
    }
    if (this.bullets.length >= BULLET.maxTotal) {
      p.fireCd = A.cooldown;
      return 0;
    }
    const b = spawnBullet(p, ++this.ids.bullet, 0, this.world, {
      speed: A.speed,
      life: A.life,
      damage: 0,
      radius: 5,
      kind: 'boomer',
    });
    this.bullets.push(b);
    p.ammoBoomer -= 1;
    if (p.ammoBoomer <= 0) p.weapon = WEAPON_DEFAULT;
    p.fireCd = A.cooldown;
    this.emit({ k: 'shoot', x: Math.round(b.x), y: Math.round(b.y), team: p.team, w: 'boomer' });
    return 1;
  }

  /**
   * Granada de humo: proyectil hacia delante con mecha corta (`SMOKE.fuse`) que
   * se convierte en nube (6 s, radio 145, tope 8 nubes). Cuesta una carga por
   * vida y respeta su cooldown de habilidad.
   */
  throwSmoke(p) {
    if (p.smokeCd > 0 || p.smokeAmmo <= 0) return 0;
    if (this.bullets.length >= BULLET.maxTotal) return 0;
    const speed = SMOKE.range / SMOKE.fuse;
    const b = spawnBullet(p, ++this.ids.bullet, 0, this.world, {
      speed,
      life: SMOKE.fuse,
      damage: 0,
      radius: 5,
      kind: 'smoke',
    });
    this.bullets.push(b);
    p.smokeAmmo -= 1;
    p.smokeCd = SMOKE.cooldown;
    return 1;
  }

  /**
   * Escopeta de plasma: 7 perdigones, daño 16 POR perdigón, vida corta y
   * cooldown largo. Tiene sus PROPIOS topes de balas vivas y de perdigones por
   * volea: los buffs ayudan, pero no multiplican el daño a niveles absurdos
   * (disparo rápido acorta el cooldown un 35 %; el triple suma 2 perdigones).
   */
  firePlasma(p) {
    const S = TACTICAL.shotgun;
    const rapid = p.buffs.rapid > 0;
    const spread = p.buffs.spread > 0;
    const cooldown = S.cooldown * (rapid ? S.rapidFactor : 1);
    const pellets = Math.min(S.maxPellets, S.pellets + (spread ? S.spreadBonus : 0));
    const live = this.bullets.filter((b) => b.owner === p.id).length;
    const capacity = Math.max(0, Math.min(S.maxLive - live, BULLET.maxTotal - this.bullets.length));
    if (capacity <= 0) {
      p.fireCd = cooldown;
      return 0;
    }
    const n = Math.min(pellets, capacity);
    let first = null;
    for (let i = 0; i < n; i++) {
      const offset = (i - (n - 1) / 2) * S.spread;
      const b = spawnBullet(p, ++this.ids.bullet, offset, this.world, {
        speed: S.speed,
        life: S.life,
        damage: S.damage,
        radius: BULLET.radius,
        kind: 'plasma',
      });
      this.bullets.push(b);
      if (!first) first = b;
    }
    if (first) this.emit({ k: 'shoot', x: Math.round(first.x), y: Math.round(first.y), team: p.team, w: 'plasma' });
    p.fireCd = cooldown;
    return n;
  }

  stepBullets(dt) {
    const survivors = [];
    for (const b of this.bullets) {
      const kind = b.kind ?? 'auto';
      // Proyectiles con detonación propia (boomer / humo): NUNCA dañan al
      // tocar, su efecto lo resuelve su propia deflagración.
      if (kind === 'boomer') {
        if (this.stepBoomer(b, dt)) survivors.push(b);
        continue;
      }
      if (kind === 'smoke') {
        if (this.stepSmokeGrenade(b, dt)) survivors.push(b);
        continue;
      }
      // Ruta clásica INTACTA (mismo alcance, mismo daño, mismo orden de
      // comprobaciones) para no alterar el comportamiento histórico.
      if (!this.tacticalActive) {
        if (this.stepBulletClassic(b, dt)) survivors.push(b);
        continue;
      }
      if (this.stepBulletTactical(b, dt)) survivors.push(b);
    }
    this.bullets = survivors;
  }

  /** Subpasos proporcionales a la velocidad: nada atraviesa una pared fina. */
  substeps(b, dt) {
    const speed = Math.hypot(b.vx, b.vy) || 1;
    return Math.max(1, Math.ceil((speed * dt) / 6));
  }

  /**
   * Bala táctica por SUBPASOS: el desplazamiento se parte en tramos de <=6 px
   * para que ningún perdigón rápido (840 px/s) atraviese una cobertura fina ni
   * una nave. Orden: cobertura -> roca -> nave (la cobertura intercepta).
   */
  stepBulletTactical(b, dt) {
    const steps = this.substeps(b, dt);
    const sub = dt / steps;
    for (let s = 0; s < steps; s++) {
      if (b.kind === 'mine') {
        const target = this.list().find((p) => this.canBulletHit(b, p) && p.alive && torusDistance(b.x, b.y, p.x, p.y, this.world) < 72);
        if (target) {
          this.boomerBlast(b, b.x, b.y);
          return false;
        }
      }
      if (b.kind === 'homing') {
        const target = this.list().filter((p) => this.canBulletHit(b, p) && p.alive)
          .sort((a, c) => torusDistance(b.x, b.y, a.x, a.y, this.world) - torusDistance(b.x, b.y, c.x, c.y, this.world))[0];
        if (target) {
          const to = torusDelta(b.x, b.y, target.x, target.y, this.world);
          const angle = Math.atan2(to.dy, to.dx);
          const speed = Math.hypot(b.vx, b.vy) || 520;
          b.vx += (Math.cos(angle) * speed - b.vx) * 0.18;
          b.vy += (Math.sin(angle) * speed - b.vy) * 0.18;
        }
      }
      if (!stepBullet(b, sub, this.world)) return false;
      if (this.bulletHitsCover(b)) return false;
      if (this.bulletHitsRock(b)) return false;
      if (this.bulletHitsPlayer(b)) return false;
    }
    return true;
  }

  /**
   * Proyectil boomer: por SUBPASOS (vuela a 420 px/s) hasta chocar con una
   * cobertura, una roca o una nave, o hasta agotar su mecha: entonces estalla.
   */
  stepBoomer(b, dt) {
    const steps = this.substeps(b, dt);
    const sub = dt / steps;
    for (let s = 0; s < steps; s++) {
      if (!stepBullet(b, sub, this.world)) {
        this.boomerBlast(b, b.x, b.y);
        return false;
      }
      const radius = b.radius ?? 5;
      const cover = this.coverAt(b.x, b.y, radius);
      if (cover) {
        // El punto de detonación SALE del collider: superficie + epsilon en la
        // normal de contacto. Si no, la propia pared taparía TODA la LOS de la
        // explosión (incluida la del lado al que mira el impacto).
        const { x, y } = this.blastPointOutside(b, cover, radius);
        this.boomerBlast(b, x, y);
        return false;
      }
      if (this.rockAt(b.x, b.y, radius)) {
        this.boomerBlast(b, b.x, b.y);
        return false;
      }
      if (this.shipAt(b.x, b.y, radius, b.owner)) {
        this.boomerBlast(b, b.x, b.y);
        return false;
      }
    }
    return true;
  }

  /**
   * Proyectil de humo: vuela hasta su mecha o hasta chocar con algo sólido; en
   * ese punto despliega la nube (el humo no hace daño, así que la pared solo
   * detiene el proyectil).
   */
  stepSmokeGrenade(b, dt) {
    const steps = this.substeps(b, dt);
    const sub = dt / steps;
    for (let s = 0; s < steps; s++) {
      if (!stepBullet(b, sub, this.world)) {
        this.spawnSmokeCloud(b, b.x, b.y);
        return false;
      }
      const radius = b.radius ?? 5;
      if (this.coverAt(b.x, b.y, radius) || this.rockAt(b.x, b.y, radius)) {
        this.spawnSmokeCloud(b, b.x, b.y);
        return false;
      }
    }
    return true;
  }

  /** Punto de detonación justo FUERA del collider, superficie + epsilon. */
  blastPointOutside(b, cover, radius) {
    const world = this.world;
    const hit = this.coverContactAt(b.x, b.y, radius, cover);
    let ex = b.x;
    let ey = b.y;
    if (!hit) return { x: ex, y: ey };
    let nx = hit.nx;
    let ny = hit.ny;
    let depth = Number.isFinite(hit.depth) ? Math.max(0, hit.depth) : 0;
    let guard = 0;
    do {
      ex = wrap(ex + nx * (depth + 3), world.w);
      ey = wrap(ey + ny * (depth + 3), world.h);
      const again = this.coverContactAt(ex, ey, radius, cover);
      if (!again) break;
      depth = Number.isFinite(again.depth) ? Math.max(0, again.depth) : 0;
      nx = again.nx;
      ny = again.ny;
    } while (++guard < 4);
    return { x: ex, y: ey };
  }

  /**
   * Deflagración del boomer en (x,y):
   *  - coberturas: `coverDamage` (100) a las que solapan el radio, con el
   *    contacto EXACTO (rectángulos incluidos), nunca por distancia al bounding
   *    radius
   *  - naves: 85 de área; SIN fuego amigo (los aliados salen ilesos) pero CON
   *    auto-daño; la LOS de las paredes SÍ bloquea la explosión
   *  - rocas: 85 a las que caigan dentro
   */
  boomerBlast(b, x, y) {
    const A = ARSENAL.boomer;
    const world = this.world;
    // LOS calculada contra una COPIA de las coberturas VIVAS hecha ANTES de
    // dañarlas: si esta misma explosión rompe la pared, esa pared sigue
    // protegiendo durante este impacto (nadie recibe el área a través de un
    // muro que aún estaba en pie cuando estalló). La copia conserva la
    // geometría y el hp previo.
    const walls = this.covers.map((c) => ({ ...c }));

    // Naves: primero el daño (con la LOS previa), el fuego amigo no existe y el
    // auto-daño sí.
    const shot = { owner: b.owner, team: b.team };
    for (const p of this.list()) {
      const self = p.id === b.owner;
      if (!self && !this.isHostileShot(shot, p)) continue;
      if (!p.alive && !p.downed) continue;
      if (torusDistance(x, y, p.x, p.y, world) > A.radius + SHIP.radius) continue;
      if (this.losBlocked(x, y, p.x, p.y, walls)) continue;
      this.damagePlayer(p, A.damage, b.owner, { x, y });
    }

    // Coberturas: pueden caer varias a la vez.
    for (const c of [...this.covers]) {
      if (this.coverContactAt(x, y, A.radius, c)) this.damageCover(c, A.coverDamage);
    }

    // Rocas grandes y medianas dentro del área.
    for (const a of [...this.asteroids]) {
      if (a.hp <= 0) continue;
      if (torusDistance(x, y, a.x, a.y, world) <= A.radius + ASTEROID_SIZES[a.size].r) {
        a.hp -= A.damage;
        if (a.hp <= 0) this.destroyAsteroid(a, b.owner, { byShot: true });
      }
    }

    this.emit({ k: 'blast', id: b.owner, x: Math.round(x), y: Math.round(y), team: b.team, w: 'boomer' });
    return true;
  }

  /** Despliega una nube de humo (tope `SMOKE.maxActive`, la más vieja cae). */
  spawnSmokeCloud(b, x, y) {
    const cloud = {
      id: ++this.ids.smoke,
      x: wrap(x, this.world.w),
      y: wrap(y, this.world.h),
      r: SMOKE.radius,
      remaining: SMOKE.life,
      team: b.team,
      owner: b.owner,
    };
    this.smokes.push(cloud);
    while (this.smokes.length > SMOKE.maxActive) this.smokes.shift();
    this.emit({ k: 'smoke', id: b.owner, x: Math.round(cloud.x), y: Math.round(cloud.y), team: cloud.team, w: 'smoke' });
    return cloud;
  }

  /** Caducidad del humo: la nube desaparece y deja de tapar la LOS. */
  stepSmokes(dt) {
    if (this.smokes.length === 0) return;
    for (const s of this.smokes) s.remaining -= dt;
    this.smokes = this.smokes.filter((s) => s.remaining > 0);
  }

  /**
   * Pads de armas del mapa: solo los recoge una nave VIVA y con HUECO en el
   * inventario (un derribado no, y quien ya lleva el cargador lleno tampoco:
   * así el pad no se consume en balde y sigue disponible para los demás).
   * Cada pad da su carga completa, con tope de cargador (sin farm infinito), y
   * queda en enfriamiento 18/24 s.
   */
  stepPads(dt) {
    if (this.pads.length === 0) return;
    for (const pad of this.pads) {
      pad.cd = Math.max(0, pad.cd - dt);
      if (pad.cd > 0) continue;
      const conf = PAD[pad.type];
      if (!conf) continue;
      const reach = SHIP.radius + (conf.radius ?? PAD_REACH);
      let taken = null;
      for (const p of this.list()) {
        if (!p.alive || p.downed) continue;
        if (!this.padHasRoom(p, pad.type)) continue;
        if (torusDistance(p.x, p.y, pad.x, pad.y, this.world) <= reach) {
          taken = p;
          break;
        }
      }
      // Nadie elegible: el pad NO se gasta (ni cooldown ni munición regalada).
      if (taken) this.grantPad(taken, pad, conf);
    }
  }

  /** ¿A este piloto le cabe la munición de `type`? (inventario no lleno) */
  padHasRoom(p, type) {
    const max = AMMO_MAX[type];
    if (!Number.isFinite(max)) return false;
    if (type === 'sniper') return (p.ammoSniper ?? 0) < max;
    if (type === 'boomer') return (p.ammoBoomer ?? 0) < max;
    if (type === 'smoke') return (p.smokeAmmo ?? 0) < max;
    return false;
  }

  /** Aplica la munición del pad (con tope de cargador) y lo enfría. */
  grantPad(p, pad, conf) {
    if (!conf || !this.padHasRoom(p, pad.type)) return false;
    if (pad.type === 'sniper') {
      p.ammoSniper = Math.min(AMMO_MAX.sniper, p.ammoSniper + conf.ammo);
    } else if (pad.type === 'boomer') {
      p.ammoBoomer = Math.min(AMMO_MAX.boomer, p.ammoBoomer + conf.ammo);
    } else if (pad.type === 'smoke') {
      p.smokeAmmo = Math.min(AMMO_MAX.smoke, p.smokeAmmo + conf.ammo);
    } else {
      return false;
    }
    pad.cd = conf.cooldown;
    this.emit({
      k: 'weapon_pickup',
      id: p.id,
      x: Math.round(pad.x),
      y: Math.round(pad.y),
      team: p.team,
      w: pad.type,
    });
    return true;
  }

  /** Roca con la que solapa el disco (x,y,r), o null. */
  rockAt(x, y, r) {
    for (const a of this.asteroids) {
      if (!a.hp || a.hp <= 0) continue;
      if (torusDistance(x, y, a.x, a.y, this.world) <= ASTEROID_SIZES[a.size].r + r) return a;
    }
    return null;
  }

  /** Nave con la que solapa el disco (excluyendo al dueño si se pide), o null. */
  shipAt(x, y, r, excludeId = null) {
    for (const p of this.list()) {
      if (p.id === excludeId) continue;
      if (!p.alive && !p.downed) continue;
      if (torusDistance(x, y, p.x, p.y, this.world) <= SHIP.radius + r) return p;
    }
    return null;
  }

  /** Un tick de bala clásico: rocas y naves. Devuelve false si muere. */
  stepBulletClassic(b, dt) {
    if (!stepBullet(b, dt, this.world)) return false;
    if (this.bulletHitsRock(b)) return false;
    if (this.bulletHitsPlayer(b)) return false;
    return true;
  }

  bulletHitsRock(b) {
    const world = this.world;
    const r = b.radius ?? BULLET.radius;
    const damage = b.damage ?? BULLET.damage;
    for (const a of this.asteroids) {
      if (!a.hp || a.hp <= 0) continue;
      const radius = ASTEROID_SIZES[a.size].r;
      if (torusDistance(b.x, b.y, a.x, a.y, world) <= radius + r) {
        a.hp -= damage;
        this.emit({ k: 'hitrock', x: Math.round(b.x), y: Math.round(b.y) });
        if (a.superCore && a.hp <= 0) {
          const owner = this.getPlayer(b.owner);
          if (owner) {
            owner.buffs.shield = Math.max(owner.buffs.shield, 10);
            owner.buffs.rapid = Math.max(owner.buffs.rapid, 10);
            owner.buffs.spread = Math.max(owner.buffs.spread, 10);
            this.emit({ k: 'super', id: owner.id, x: Math.round(a.x), y: Math.round(a.y) });
          }
          this.superCore = null;
          a.hp = 0;
          return true;
        }
        if (a.hp <= 0) this.destroyAsteroid(a, b.owner, { byShot: true });
        return true;
      }
    }
    return false;
  }

  /**
   * ¿Puede este disparo dañar a `p`? Las naves DERRIBADAS siguen siendo blanco
   * enemigo (rematar), pero nunca de sus aliados. Se usa tanto para balas como
   * para el área del boomer (`{owner, team}`).
   */
  isHostileShot(shot, p) {
    if (this.tacticalActive && p.downed) {
      if (!this.rules.pvp) return false;
      if (this.rules.teamBased) return shot.team !== p.team;
      return shot.owner !== p.id;
    }
    return isEnemyTarget(this.mode, shot, p);
  }

  canBulletHit(b, p) {
    return this.isHostileShot(b, p);
  }

  bulletHitsPlayer(b) {
    const world = this.world;
    const r = b.radius ?? BULLET.radius;
    const damage = b.damage ?? BULLET.damage;
    for (const p of this.list()) {
      if (!this.canBulletHit(b, p)) continue;
      if (torusDistance(b.x, b.y, p.x, p.y, world) <= SHIP.radius + r) {
        // Barrel roll: durante la animación la bala se repele/consume y no
        // aplica daño. El cooldown sigue siendo autoritativo en el servidor.
        if ((this.mode === 'asteroids' || this.mode === 'asteroids3' || this.mode === 'stocks') && p.dashTimer > 0) {
          this.emit({ k: 'barrel', x: Math.round(p.x), y: Math.round(p.y), team: p.team });
          return true;
        }
        this.damagePlayer(p, damage, b.owner, { x: b.x, y: b.y });
        return true;
      }
    }
    return false;
  }

  /**
   * Las coberturas interceptan la bala ANTES que cualquier nave. El contacto es
   * EXACTO (círculos legacy y rectángulos axis-aligned) vía `coverContact`: una
   * pared larga no se aproxima por su bounding radius.
   */
  bulletHitsCover(b) {
    if (this.covers.length === 0) return false;
    const r = b.radius ?? BULLET.radius;
    const damage = b.damage ?? BULLET.damage;
    for (const c of this.covers) {
      if (this.coverContactAt(b.x, b.y, r, c)) {
        this.damageCover(c, damage);
        return true;
      }
    }
    return false;
  }

  stepAsteroids(dt) {
    const world = this.world;
    for (const a of this.asteroids) {
      a.x = wrap(a.x + a.vx * dt, world.w);
      a.y = wrap(a.y + a.vy * dt, world.h);
      a.angle += a.spin * dt;
    }

    // Colision nave <-> asteroide (ambos reciben dano).
    for (const p of this.list()) {
      if (!p.alive) continue;
      for (const a of this.asteroids) {
        const radius = ASTEROID_SIZES[a.size].r;
        const d = torusDistance(p.x, p.y, a.x, a.y, world);
        if (d > radius + SHIP.radius) continue;
        const { dx, dy } = torusDelta(a.x, a.y, p.x, p.y, world);
        const len = Math.hypot(dx, dy) || 1;
        const push = 240;
        p.vx += (dx / len) * push;
        p.vy += (dy / len) * push;
        a.vx -= (dx / len) * push * 0.35;
        a.vy -= (dy / len) * push * 0.35;
        a.hp -= ASTEROID_SIZES[a.size].damage * 1.4;
        // Un choque de nave NO genera powerups: solo caen de asteroides
        // destruidos por disparos.
        if (a.hp <= 0) this.destroyAsteroid(a, null);
        this.damagePlayer(p, ASTEROID_SIZES[a.size].damage, null, { x: p.x, y: p.y });
        break;
      }
    }
    this.asteroids = this.asteroids.filter((a) => a.hp > 0);
  }

  stepAsteroidRespawn(dt) {
    this.respawnTimer += dt;
    if (this.respawnTimer < ASTEROID_RESPAWN_EVERY) return;
    this.respawnTimer = 0;
    if (this.asteroids.length < ASTEROID_TARGET_COUNT) this.spawnAsteroid(0);
  }

  stepHill(dt) {
    // La colina de ESTA partida (posición y radio propios), nunca la global.
    const counts = countInHill(this.list(), this.hill);
    const before = this.hillStatus;
    const result = applyHillScore(this.score, counts, dt);
    this.hillCounts = counts;
    this.hillStatus = result.state;
    if (result.state !== before && result.team) {
      this.emit({ k: 'capture', team: result.team });
    }
    return counts;
  }

  /** Puntuacion/objetivo por modo. La colina solo existe en koth. */
  stepScores(dt) {
    if (this.mode === 'koth' && this.rules.usesHill) {
      // El temporizador de rotación solo avanza aquí: `tick` ya garantiza que
      // estamos en `playing` (nunca en lobby, cuenta atrás ni final).
      this.stepHillTimer(dt);
      this.stepHill(dt);
      return;
    }
    this.hillCounts = { cyan: 0, coral: 0 };
    this.hillStatus = 'idle';
    if (this.mode === 'tdm') {
      // Acumulado en `teamKills`: sobrevive a desconexiones y cambios de equipo.
      this.score.cyan = this.teamKills.cyan;
      this.score.coral = this.teamKills.coral;
      return;
    }
    if (this.mode === 'ffa') {
      const sorted = this.list().sort((a, b) => b.kills - a.kills || b.deaths - a.deaths);
      this.ffaLeader = sorted[0]?.id ?? null;
      this.score.cyan = sorted[0]?.kills ?? 0;
      this.score.coral = sorted[1]?.kills ?? 0;
      return;
    }
    if (this.mode === 'chaos') {
      const sorted = this.list().sort((a, b) => b.kills - a.kills || b.deaths - a.deaths);
      this.ffaLeader = sorted[0]?.id ?? null;
      this.score.cyan = sorted[0]?.kills ?? 0;
      this.score.coral = sorted[1]?.kills ?? 0;
      return;
    }
    if (this.mode === 'asteroids' || this.mode === 'asteroids3' || this.mode === 'stocks') {
      this.score.cyan = this.teamKills.cyan;
      this.score.coral = this.teamKills.coral;
    }
  }

  // -------------------------------------------------------------- arcade coop
  startWave(n) {
    this.wave = n;
    this.waveTimer = 0;
    this.asteroids = [];
    const count = Math.min(ARCADE.waveBase + (n - 1) * ARCADE.waveGrowth, ARCADE.waveMax);
    for (let i = 0; i < count; i++) {
      // Oleadas avanzadas mezclan rocas medianas para subir la presion.
      const size = n >= 3 && i % 4 === 0 ? 1 : 0;
      this.spawnAsteroid(size);
    }
    this.emit({ k: 'wave', n });
  }

  /** Oleadas finitas: al limpiar todas las rocas avanza o se gana. */
  stepWaves(dt) {
    if (this.asteroids.length > 0) {
      this.waveTimer = 0;
      return;
    }
    this.waveTimer += dt;
    if (this.waveTimer < ARCADE.waveDelay) return;
    this.waveTimer = 0;
    if (this.wave >= ARCADE.wavesToWin) {
      this.endMatch('victory', 'oleadas');
      return;
    }
    this.startWave(this.wave + 1);
  }

  checkArcadeOutcome() {
    if (this.phase !== 'playing') return;
    if (this.list().length === 0) return;
    if (this.lives > 0) return;
    if (this.list().some((p) => p.alive)) return;
    // Un jugador que ya pagó su reaparición puede seguir en la cola de espera.
    const pending = this.list().some((p) => !p.alive && p.respawnAt - this.time < ELIMINATED_AFTER);
    if (pending) return;
    this.endMatch('defeat', 'reserva');
  }

  destroyAsteroid(a, ownerId, { byShot = false } = {}) {
    const size = ASTEROID_SIZES[a.size];
    this.emit({ k: 'boom', x: Math.round(a.x), y: Math.round(a.y), s: a.size });
    if (this.mode === 'arcade') this.score.cyan += size.value;
    if (byShot) this.maybeDrop(a);
    if (size.child >= 0 && a.hp <= 0 && a.size < ASTEROID_SIZES.length - 1) {
      const child = size.child;
      for (let i = 0; i < 2; i++) {
        const c = this.spawnAsteroid(child, a.x, a.y);
        if (c) {
          const ang = this.rng() * Math.PI * 2;
          const sp = rand(this.rng, 60, 140);
          c.vx = Math.cos(ang) * sp + a.vx * 0.4;
          c.vy = Math.sin(ang) * sp + a.vy * 0.4;
        }
      }
    }
    const idx = this.asteroids.indexOf(a);
    if (idx >= 0) this.asteroids.splice(idx, 1);
    if (ownerId != null) {
      const p = this.getPlayer(ownerId);
      if (p) p.rocks = (p.rocks ?? 0) + 1;
    }
    return true;
  }

  // ------------------------------------------------------------------ pickups
  /** Drop autoritativo: probabilidad por roca destruida a tiros y tope activo. */
  maybeDrop(a) {
    const maxActive = this.mode === 'chaos' ? POWERUP.chaosMaxActive : POWERUP.maxActive;
    if (this.pickups.length >= maxActive) return null;
    const chance = this.mode === 'chaos' ? POWERUP.chaosDropChance : POWERUP.dropChance;
    if (this.rng() >= chance) return null;
    const pool = this.mode === 'chaos' ? POWERUP_TYPES : POWERUP_TYPES.slice(0, 4);
    const type = pool[Math.floor(this.rng() * pool.length)] ?? 'repair';
    const first = this.spawnPickup(a.x, a.y, type);
    // En Caos, una parte de las rocas suelta un segundo objeto cercano.
    if (this.mode === 'chaos' && this.rng() < 0.46 && this.pickups.length < maxActive) {
      const second = pool[Math.floor(this.rng() * pool.length)] ?? 'repair';
      this.spawnPickup(a.x + rand(this.rng, -34, 34), a.y + rand(this.rng, -34, 34), second);
    }
    return first;
  }

  spawnPickup(x, y, type) {
    const pu = { id: ++this.ids.pickup, x: wrap(x, this.world.w), y: wrap(y, this.world.h), type, age: 0 };
    this.pickups.push(pu);
    return pu;
  }

  /** Caducidad, recogida por proximidad toroidal de naves vivas. */
  stepPickups(dt) {
    if (this.pickups.length === 0) return;
    const keep = [];
    for (const pu of this.pickups) {
      pu.age += dt;
      if (pu.age >= POWERUP.life) continue;
      let taken = null;
      for (const p of this.list()) {
        if (!p.alive) continue;
        const magnetReach = p.buffs.magnet > 0 ? POWERUP.magnetReach : 0;
        if (torusDistance(p.x, p.y, pu.x, pu.y, this.world) <= SHIP.radius + POWERUP.radius + magnetReach) {
          taken = p;
          break;
        }
      }
      if (taken) {
        this.applyPickup(taken, pu);
        continue;
      }
      keep.push(pu);
    }
    this.pickups = keep;
  }

  /** Aplica el buff refrescando duracion (nunca acumula de forma infinita). */
  applyPickup(p, pu) {
    switch (pu.type) {
      case 'repair':
        p.hp = Math.min(SHIP.maxHp, p.hp + POWERUP.repair);
        break;
      case 'shield':
        p.buffs.shield = Math.max(p.buffs.shield, POWERUP.shieldSeconds);
        break;
      case 'rapid':
        p.buffs.rapid = Math.max(p.buffs.rapid, POWERUP.rapidSeconds);
        break;
      case 'spread':
        p.buffs.spread = Math.max(p.buffs.spread, POWERUP.spreadSeconds);
        break;
      case 'laser':
        if (this.mode !== 'chaos') break;
        p.buffs.laser = Math.max(p.buffs.laser, 8);
        break;
      case 'heavy':
        if (this.mode !== 'chaos') break;
        p.buffs.heavy = Math.max(p.buffs.heavy, 8);
        break;
      case 'homing':
        if (this.mode !== 'chaos') break;
        p.buffs.homing = Math.max(p.buffs.homing, 8);
        break;
      case 'mine':
        if (this.mode !== 'chaos') break;
        p.buffs.mine = Math.max(p.buffs.mine, 10);
        break;
      case 'barrage':
        if (this.mode !== 'chaos') break;
        p.buffs.barrage = Math.max(p.buffs.barrage, POWERUP.barrageSeconds);
        break;
      case 'overdrive':
        if (this.mode !== 'chaos') break;
        p.buffs.overdrive = Math.max(p.buffs.overdrive, POWERUP.overdriveSeconds);
        break;
      case 'magnet':
        if (this.mode !== 'chaos') break;
        p.buffs.magnet = Math.max(p.buffs.magnet, POWERUP.magnetSeconds);
        break;
      case 'leech':
        if (this.mode !== 'chaos') break;
        p.buffs.leech = Math.max(p.buffs.leech, POWERUP.leechSeconds);
        break;
      case 'jam':
        if (this.mode !== 'chaos') break;
        p.buffs.jam = Math.max(p.buffs.jam, POWERUP.jamSeconds);
        break;
      case 'volatile':
        if (this.mode !== 'chaos') break;
        this.damagePlayer(p, POWERUP.volatileDamage, null, { x: pu.x, y: pu.y });
        this.emit({ k: 'hazard', id: p.id, x: Math.round(pu.x), y: Math.round(pu.y), team: p.team, pu: pu.type });
        return true;
      default:
        break;
    }
    this.emit({ k: 'pickup', x: Math.round(p.x), y: Math.round(p.y), id: p.id, pu: pu.type, team: p.team });
    return true;
  }

  /** Mantiene el mapa vivo: en Caos también caen cápsulas entre asteroides. */
  stepChaosDrops(dt) {
    this.chaosDropTimer += dt;
    if (this.chaosDropTimer < POWERUP.chaosAmbientEvery) return;
    this.chaosDropTimer = 0;
    const cap = POWERUP.chaosMaxActive - this.pickups.length;
    const count = Math.max(0, Math.min(cap, POWERUP.chaosAmbientBatch));
    for (let i = 0; i < count; i++) {
      const type = POWERUP_TYPES[Math.floor(this.rng() * POWERUP_TYPES.length)] ?? 'repair';
      this.spawnPickup(this.rng() * this.world.w, this.rng() * this.world.h, type);
    }
  }

  activateChaosWeapon(p) {
    if (this.mode !== 'chaos') return false;
    const sequence = ['laser', 'heavy', 'homing', 'mine', 'barrage', 'sniper', 'boomer', 'plasma'];
    const weapon = sequence[p.chaosWeaponIndex = ((p.chaosWeaponIndex ?? -1) + 1) % sequence.length];
    p.buffs.laser = p.buffs.heavy = p.buffs.homing = p.buffs.mine = p.buffs.barrage = p.buffs.rapid = p.buffs.spread = 0;
    if (weapon === 'laser' || weapon === 'heavy' || weapon === 'homing' || weapon === 'mine' || weapon === 'barrage') {
      p.buffs[weapon] = 12;
      p.weapon = 'auto';
    } else if (weapon === 'sniper') {
      p.ammoSniper = 6;
      p.weapon = 'sniper';
    } else if (weapon === 'boomer') {
      p.ammoBoomer = 3;
      p.weapon = 'boomer';
    } else {
      p.weapon = 'plasma';
    }
    this.emit({ k: 'armory', id: p.id, weapon, x: Math.round(p.x), y: Math.round(p.y), team: p.team });
    return true;
  }

  nearestPickup(x, y, maxDist = 460) {
    let best = null;
    let bestD = maxDist;
    for (const pu of this.pickups) {
      const d = torusDistance(x, y, pu.x, pu.y, this.world);
      if (d < bestD) {
        bestD = d;
        best = pu;
      }
    }
    return best ? { pu: best, dist: bestD } : null;
  }

  /**
   * Pad de arma disponible (sin enfriamiento, y del que al piloto aún le quepa
   * la munición) más cercano dentro de `maxDist`.
   */
  nearestPad(p, maxDist = 560) {
    let best = null;
    let bestD = maxDist;
    for (const pad of this.pads) {
      if (pad.cd > 0) continue;
      if (!this.padHasRoom(p, pad.type)) continue;
      const d = torusDistance(p.x, p.y, pad.x, pad.y, this.world);
      if (d < bestD) {
        bestD = d;
        best = pad;
      }
    }
    return best ? { pad: best, dist: bestD } : null;
  }

  damagePlayer(p, amount, ownerId, at) {
    // Caos Orbital es un modo de respawn rápido: no hay derribos ni rescates.
    if (this.mode === 'chaos') {
      if (!p.alive || this.time < p.protectUntil || p.buffs.shield > 0) return false;
      p.hp -= amount;
      this.emit({ k: 'hit', x: Math.round(p.x), y: Math.round(p.y), team: p.team, d: Math.round(amount) });
      if (p.hp <= 0) {
        p.alive = false;
        p.downed = false;
        p.deaths += 1;
        p.hp = 0;
        p.respawnAt = this.time + POWERUP.chaosRespawnSeconds;
        p.vx = 0;
        p.vy = 0;
        this.emit({ k: 'life', id: p.id, lives: 0, chaosRespawn: true });
        if (ownerId) {
          const killer = this.getPlayer(ownerId);
          if (killer) {
            killer.kills += 1;
            if (TEAMS.includes(killer.team)) this.teamKills[killer.team] += 1;
          }
        }
        this.clearBuffs(p);
        this.emit({ k: 'death', x: Math.round(p.x), y: Math.round(p.y), team: p.team, id: p.id, by: ownerId ?? null });
      }
      this.applyLeech(ownerId, p, amount);
      return true;
    }
    if (this.mode === 'asteroids3' && !p.downed) {
      if (!p.alive || this.time < p.protectUntil) return false;
      p.hits = Math.max(0, (p.hits ?? 3) - 1);
      const source = this.bullets.find((b) => b.owner === ownerId && Math.abs(b.x - at.x) < 2 && Math.abs(b.y - at.y) < 2);
      if (p.hits > 0) {
        const dx = source?.vx ?? 0;
        const dy = source?.vy ?? 0;
        const mag = Math.hypot(dx, dy) || 1;
        p.vx += (dx / mag) * 280;
        p.vy += (dy / mag) * 280;
      }
      this.emit({ k: 'hit', x: Math.round(p.x), y: Math.round(p.y), team: p.team, d: 1, hits: p.hits, knockback: p.hits > 0 });
      if (p.hits <= 0) this.finalDeath(p, ownerId);
      else this.emit({ k: 'hitcount', id: p.id, hits: p.hits });
      return true;
    }
    if ((this.mode === 'asteroids' || this.mode === 'stocks') && !p.downed) {
      if (!p.alive || this.time < p.protectUntil) return false;
      const source = this.bullets.find((b) => b.owner === ownerId && Math.abs(b.x - at.x) < 2 && Math.abs(b.y - at.y) < 2);
      const dx = source?.vx ?? 0;
      const dy = source?.vy ?? 0;
      const mag = Math.hypot(dx, dy) || 1;
      p.vx += (dx / mag) * 280;
      p.vy += (dy / mag) * 280;
      p.lives = Math.max(0, (p.lives ?? (this.mode === 'stocks' ? this.stocks : 3)) - 1);
      p.hp = 0;
      this.emit({ k: 'hit', x: Math.round(p.x), y: Math.round(p.y), team: p.team, d: 1, lives: p.lives, knockback: true });
      if (p.lives <= 0) this.finalDeath(p, ownerId);
      else {
        p.alive = false;
        p.respawnAt = this.time + RESPAWN_SECONDS;
        this.emit({ k: 'life', id: p.id, lives: p.lives });
      }
      return true;
    }
    // Nave derribada: sigue siendo un blanco válido (rematar). El daño va a su
    // vida de derribo y la muerte final se acredita a quien remata.
    if (p.downed) {
      p.downedHp -= amount;
      this.emit({ k: 'hit', x: Math.round(p.x), y: Math.round(p.y), team: p.team, d: Math.round(amount) });
      if (p.downedHp <= 0) this.finalDeath(p, ownerId);
      return true;
    }
    if (!p.alive) return false;
    if (this.time < p.protectUntil || p.buffs.shield > 0) {
      this.emit({ k: 'shield', x: Math.round(p.x), y: Math.round(p.y), team: p.team });
      return false;
    }
    p.hp -= amount;
    this.applyLeech(ownerId, p, amount);
    this.emit({ k: 'hit', x: Math.round(p.x), y: Math.round(p.y), team: p.team, d: Math.round(amount) });
    if (p.hp <= 0) {
      // En táctico el primer golpe letal DERRIBA (una vez por vida); el
      // siguiente letal ya es muerte real. Esto evita rescates infinitos.
      if (this.tacticalActive && !p.downedUsed) this.enterDowned(p, ownerId);
      else this.finalDeath(p, ownerId);
    }
    return true;
  }

  /** Drenaje vital: sana al atacante solo por daño que realmente entró. */
  applyLeech(ownerId, victim, amount) {
    if (!ownerId || ownerId === victim.id || amount <= 0) return;
    const owner = this.getPlayer(ownerId);
    if (!owner?.alive || owner.buffs.leech <= 0) return;
    owner.hp = Math.min(SHIP.maxHp, owner.hp + amount * POWERUP.leechFraction);
  }

  /**
   * Derribo táctico: la nave queda fuera de combate 12 s, sin disparar, sin
   * boost/dash y sin recoger powerups. Un aliado vivo cercano con `interact`
   * la reanima en 2.5 s. Solo ocurre UNA vez por vida.
   */
  enterDowned(p, ownerId) {
    const D = TACTICAL.downed;
    p.alive = false;
    p.downed = true;
    p.downedUsed = true;
    p.downedHp = D.hp;
    p.downedUntil = this.time + D.seconds;
    p.reviveProgress = 0;
    p.reviverId = null;
    p.reserveKiller = ownerId ?? null;  // asesino reservado si muere desangrada
    p.hp = 0;
    p.vx *= 0.25;                       // conserva algo de inercia, pero lento
    p.vy *= 0.25;
    p.dashTimer = 0;
    p.dashVx = 0;
    p.dashVy = 0;
    p.pendingDash = null;
    p.dashHeld = false;
    p.dashDir = 0;
    this.clearBuffs(p);
    this.emit({ k: 'downed', id: p.id, x: Math.round(p.x), y: Math.round(p.y), team: p.team, by: ownerId ?? null });
  }

  /**
   * Muerte definitiva (y muerte clásica en FFA/arcade): cuenta baja, programa
   * reaparición y acredita al asesino. Las bajas/marcador SOLO se mueven aquí.
   */
  finalDeath(p, ownerId) {
    if (!p.alive && !p.downed) return false;
    p.downed = false;
    p.downedHp = 0;
    p.downedUntil = 0;
    p.reviveProgress = 0;
    p.reviverId = null;
    p.reserveKiller = null;
    p.hp = 0;
    p.alive = false;
    p.deaths += 1;
    p.vx = 0;
    p.vy = 0;
    p.dashTimer = 0;
    p.dashVx = 0;
    p.dashVy = 0;
    p.pendingDash = null;
    p.dashHeld = false;
    p.dashDir = 0;
    this.clearBuffs(p);
    if (this.mode === 'arcade') this.registerArcadeDeath(p);
    else p.respawnAt = this.time + RESPAWN_SECONDS;
    const killer = ownerId != null ? this.getPlayer(ownerId) : null;
    if (killer && killer.id !== p.id) {
      killer.kills += 1;
      // tdm: el punto es del equipo del autor EN EL MOMENTO DE LA BAJA.
      if ((this.mode === 'tdm' || this.mode === 'asteroids' || this.mode === 'asteroids3' || this.mode === 'stocks') && TEAMS.includes(killer.team)) this.teamKills[killer.team] += 1;
    }
    this.emit({ k: 'death', x: Math.round(p.x), y: Math.round(p.y), team: p.team, id: p.id, by: killer ? killer.id : null });
    return true;
  }

  // ---------------------------------------------------------- coberturas (daño)
  /** Aplica daño a una cobertura. Al caer, desaparece y emite `cover_break`. */
  damageCover(c, amount) {
    c.hp -= amount;
    if (c.hp > 0) return false;
    c.hp = 0;
    const idx = this.covers.indexOf(c);
    if (idx >= 0) this.covers.splice(idx, 1);
    // Sin drops: una cobertura destruida solo desaparece.
    this.emit({ k: 'cover_break', x: Math.round(c.x), y: Math.round(c.y) });
    return true;
  }

  /**
   * Resolución sólida nave <-> cobertura (también con la esquiva o el rebote
   * activos): saca la nave del solape y cancela la velocidad que ENTRA en la
   * cobertura. Usa el contacto exacto (rectángulos incluidos) y funciona en el
   * toro (costura del mundo).
   */
  resolveCoverCollisions(p) {
    if (this.covers.length === 0) return false;
    const world = this.world;
    let hit = false;
    for (const c of this.covers) {
      const contact = this.coverContactAt(p.x, p.y, SHIP.radius, c);
      if (!contact) continue;
      let { nx, ny } = contact;
      let depth = Number.isFinite(contact.depth) ? Math.max(0.5, contact.depth) : 1;
      // La normal debe ALEJAR de la cobertura: si el módulo de geometría
      // devolviera el sentido contrario, se invierte aquí mismo.
      const probeX = wrap(p.x + nx * (depth + 2), world.w);
      const probeY = wrap(p.y + ny * (depth + 2), world.h);
      if (this.coverContactAt(probeX, probeY, SHIP.radius, c)) {
        nx = -nx;
        ny = -ny;
      }
      p.x = wrap(p.x + nx * depth, world.w);
      p.y = wrap(p.y + ny * depth, world.h);
      const vn = p.vx * nx + p.vy * ny;
      if (vn < 0) {
        p.vx -= vn * nx;
        p.vy -= vn * ny;
      }
      if (p.dashTimer > 0) {
        const dn = p.dashVx * nx + p.dashVy * ny;
        if (dn < 0) {
          p.dashVx -= dn * nx;
          p.dashVy -= dn * ny;
        }
      }
      if (p.bounceTimer > 0) {
        const bn = p.bounceVx * nx + p.bounceVy * ny;
        if (bn < 0) {
          p.bounceVx -= bn * nx;
          p.bounceVy -= bn * ny;
        }
      }
      hit = true;
    }
    return hit;
  }

  /** En arcade cada muerte gasta una reaparicion de la reserva común. */
  registerArcadeDeath(p) {
    if (this.lives > 0) {
      this.lives -= 1;
      p.respawnAt = this.time + RESPAWN_SECONDS;
      this.emit({ k: 'lives', n: this.lives });
    } else {
      p.respawnAt = this.time + ELIMINATED_OFFSET; // eliminado: no vuelve en esta partida
      this.emit({ k: 'eliminated', id: p.id });
    }
  }

  // --------------------------------------------------------------------- bots
  botThink(p, dt) {
    const ai = p.ai;
    const world = this.world;
    const hill = this.hill;
    ai.timer -= dt;
    if (ai.timer > 0) {
      p.input = { seq: p.input.seq, ...ai };
      return;
    }
    ai.timer = rand(this.rng, 0.07, 0.16);

    // Objetivos segun modo: enemigos reales (equipo o todos), nunca aliados, y
    // NUNCA a través del humo: lo que una nube tapa, la IA no lo ve ni lo
    // apunta (la autoridad aplica la misma LOS al disparar).
    const enemies = this.list().filter(
      (o) => o.alive && areEnemies(this.mode, p, o) && !this.smokeBlocked(p.x, p.y, o.x, o.y),
    );
    let target = null;
    let best = Infinity;
    for (const e of enemies) {
      const d = torusDistance(p.x, p.y, e.x, e.y, world);
      const bias = this.time < e.protectUntil ? 260 : 0;
      if (d + bias < best) {
        best = d + bias;
        target = e;
      }
    }

    // Powerups cercanos: se desvían a por ellos si les conviene.
    const drop = this.nearestPickup(p.x, p.y, 440);
    const wantsDrop =
      drop && (!target || best > 520 || (drop.pu.type === 'repair' && p.hp < 70) || p.hp < 45);

    // Pads de armas del mapa (v0.2): si no hay combate urgente, el bot se pasa
    // por el pad disponible más cercano y se lleva el arma especial.
    const pad = this.pads.length > 0 ? this.nearestPad(p, 560) : null;
    const wantsPad = !!pad && !wantsDrop && (!target || (best > 560 && pad.dist < best));

    // Rescate táctico: un aliado derribado cerca manda sobre el combate.
    const rescue = this.pickRescueTarget(p);

    let aimX;
    let aimY;
    if (rescue) {
      aimX = rescue.p.x;
      aimY = rescue.p.y;
    } else if (wantsDrop) {
      aimX = drop.pu.x;
      aimY = drop.pu.y;
    } else if (wantsPad) {
      aimX = pad.pad.x;
      aimY = pad.pad.y;
    } else if (target && best < 760) {
      const lead = clamp(best / BULLET.speed, 0, 0.7);
      const deltas = torusDelta(p.x, p.y, target.x + target.vx * lead, target.y + target.vy * lead, world);
      aimX = p.x + deltas.dx;
      aimY = p.y + deltas.dy;
    } else if (this.rules.usesHill) {
      // La IA persigue la colina ACTUAL (puede haber cambiado de sitio).
      const dHill = torusDistance(p.x, p.y, hill.x, hill.y, world) - hill.radius;
      if (dHill < 0) {
        aimX = hill.x + Math.cos(this.time * 0.8 + (p.id.length % 3)) * hill.radius * 0.7;
        aimY = hill.y + Math.sin(this.time * 0.8 + (p.id.length % 3)) * hill.radius * 0.7;
      } else {
        aimX = hill.x;
        aimY = hill.y;
      }
    } else {
      // tdm/ffa sin objetivo cerca: patrulla el centro de la arena.
      aimX = world.w / 2 + Math.cos(this.time * 0.5 + p.id.length) * 320;
      aimY = world.h / 2 + Math.sin(this.time * 0.5 + p.id.length) * 220;
    }

    const deltas = torusDelta(p.x, p.y, aimX, aimY, world);
    const desired = Math.atan2(deltas.dy, deltas.dx);
    const diff = angleDelta(p.angle, desired);
    ai.rot = Math.abs(diff) < 0.12 ? 0 : Math.sign(diff);
    ai.thrust = Math.abs(diff) < 1.15 || torusDistance(p.x, p.y, aimX, aimY, world) < 260;

    // Esquiva asteroides cercanos por delante.
    for (const a of this.asteroids) {
      const d = torusDistance(p.x, p.y, a.x, a.y, world);
      if (d < ASTEROID_SIZES[a.size].r + 90) {
        const toRock = Math.atan2(torusDelta(p.x, p.y, a.x, a.y, world).dy, torusDelta(p.x, p.y, a.x, a.y, world).dx);
        if (Math.abs(angleDelta(p.angle, toRock)) < 0.8) {
          ai.thrust = false;
          ai.rot = p.id.charCodeAt(p.id.length - 1) % 2 === 0 ? 1 : -1;
        }
        break;
      }
    }

    // Coberturas de frente: cambia de rumbo en vez de empotrarse (así los bots
    // no se quedan atascados empujando contra el obstáculo).
    if (this.tacticalActive) {
      const cover = this.coverAhead(p, 80);
      if (cover) {
        ai.thrust = false;
        ai.rot = p.id.charCodeAt(p.id.length - 1) % 2 === 0 ? 1 : -1;
      }
    }

    const aimErr = target
      ? Math.abs(angleDelta(p.angle, Math.atan2(torusDelta(p.x, p.y, target.x, target.y, world).dy, torusDelta(p.x, p.y, target.x, target.y, world).dx)))
      : Math.PI;
    ai.fire =
      !rescue &&
      !wantsDrop &&
      !wantsPad &&
      !!target &&
      best < 620 &&
      aimErr < 0.28 &&
      this.time >= target.protectUntil + 0.05 &&
      !this.smokeBlocked(p.x, p.y, target.x, target.y);
    const dHill = this.rules.usesHill ? torusDistance(p.x, p.y, hill.x, hill.y, world) : 999;
    ai.boost = p.boostCd <= 0 && dHill > 520 && ai.thrust && this.rng() < 0.5;

    // ── decisiones tácticas del bot ──────────────────────────────────────
    if (this.tacticalActive) {
      ai.brake = false;
      // Arma: especiales si hay munición (sniper de lejos, boomer de cerca),
      // escopeta de plasma a bocajarro y automática de lejos.
      if (p.ammoSniper > 0 && best > 420 && best < 1500) ai.weapon = 'sniper';
      else if (p.ammoBoomer > 0 && best < 460) ai.weapon = 'boomer';
      else ai.weapon = target && best < 340 ? 'plasma' : 'auto';
      const R = TACTICAL.downed.reviveRadius;

      if (rescue) {
        // El rescate es la PRIORIDAD ya elegida: mientras se intenta mantener
        // 2.5 s dentro del radio no se esquiva ni se boostea, ni siquiera con
        // un enemigo cerca (la esquiva cada 2.6 s arruinaría el rescate).
        ai.dash = 0;
        ai.boost = false;
        const to = torusDelta(p.x, p.y, rescue.p.x, rescue.p.y, world);
        const len = Math.hypot(to.dx, to.dy) || 1;
        const ux = to.dx / len;
        const uy = to.dy / len;
        const toVictim = Math.atan2(to.dy, to.dx);

        // Si una cobertura corta el camino, el punto de mira pasa a ser un
        // punto de paso tangente por el lado que mira al aliado.
        let aim = toVictim;
        if (len > R) {
          const cov = this.coverAhead(p, 90);
          if (cov) {
            const toC = torusDelta(p.x, p.y, cov.x, cov.y, world);
            const base = Math.atan2(toC.dy, toC.dx);
            const side = Math.sin(angleDelta(base, toVictim)) >= 0 ? 1 : -1;
            const pass = base + side * Math.PI * 0.5;
            const wp = torusDelta(
              p.x,
              p.y,
              cov.x + Math.cos(pass) * (cov.r + 46),
              cov.y + Math.sin(pass) * (cov.r + 46),
              world,
            );
            aim = Math.atan2(wp.dy, wp.dx);
          }
        }

        const err = angleDelta(p.angle, aim);
        ai.rot = Math.abs(err) < 0.15 ? 0 : Math.sign(err);

        // Controlador de velocidad en vez de todo-o-nada: se apunta a un punto
        // de estacionamiento dentro del radio y se ajusta la velocidad de
        // cierre, de modo que el bot LLEGA Y SE QUEDA (nada de oscilar por el
        // borde del radio reiniciando el progreso).
        const speed = Math.hypot(p.vx, p.vy);
        const closing = p.vx * ux + p.vy * uy; // >0 = acercándose
        const standoff = R * 0.5; // 45 px
        const desired = clamp((len - standoff) * 3.2, 0, 300); // rampa px/s
        // interact hasta el radio exacto: entren en 81 o en 90 px, el bot
        // pulsa `interact` (si no, podría quedarse parado entre 81 y 90 px
        // sin llegar a rescatar).
        ai.interact = len <= R;
        if (Math.abs(err) > 1.35) {
          // Aún girando hacia el aliado: ni empuja ni frena.
          ai.thrust = false;
          ai.brake = false;
        } else {
          // Frena si se cierra más rápido de lo deseado o si va demasiado
          // rápido en general (el freno, con el morro al aliado, recorta la
          // velocidad de cierre y amortigua la deriva lateral).
          const braking = closing > desired + 25 || speed > desired + 120;
          ai.brake = braking;
          ai.thrust = !braking && closing < desired;
        }
      } else {
        // Esquiva defensiva: apartarse de una cobertura de frente o zafarse en
        // combate corto. Nunca se queda pegado empujando contra el obstáculo.
        ai.dash = 0;
        const cover = this.coverAhead(p, 70);
        if (p.dashCd <= 0) {
          if (cover) ai.dash = p.id.charCodeAt(p.id.length - 1) % 2 === 0 ? 1 : -1;
          else if (target && best < 240 && this.rng() < 0.18) ai.dash = this.rng() < 0.5 ? -1 : 1;
        }
        ai.interact = false;
      }
    }

    p.input = { seq: p.input.seq, ...ai };
  }

  /**
   * Aliado derribado al que este bot debe ir a rescatar.
   *
   * Regla de designación: de cada aliado caído se hace cargo SOLO el aliado
   * vivo más cercano (alcance total, sin límite artificial: cruzar la arena a
   * rescatar es justamente el objetivo del modo). Así un caído nunca queda
   * huérfano por estar lejos y, a la vez, el resto del equipo sigue peleando
   * en lugar de abandonar el combate entero.
   */
  pickRescueTarget(p) {
    if (!this.tacticalActive) return null;
    let best = null;
    let bestD = Infinity;
    for (const o of this.list()) {
      if (!o.downed || o.id === p.id || o.team !== p.team) continue;
      let nearest = null;
      let nd = Infinity;
      for (const a of this.list()) {
        if (!a.alive || a.downed || a.team !== o.team) continue;
        const da = torusDistance(a.x, a.y, o.x, o.y, this.world);
        if (da < nd) {
          nd = da;
          nearest = a;
        }
      }
      if (nearest !== p) continue;
      const d = torusDistance(p.x, p.y, o.x, o.y, this.world);
      if (d < bestD) {
        bestD = d;
        best = o;
      }
    }
    return best ? { p: best, dist: bestD } : null;
  }

  /** Cobertura que tiene justo delante (para esquivarla o no empotrarse). */
  coverAhead(p, range = 90) {
    for (const c of this.covers) {
      const d = torusDistance(p.x, p.y, c.x, c.y, this.world);
      if (d > c.r + range) continue;
      const to = torusDelta(p.x, p.y, c.x, c.y, this.world);
      if (Math.abs(angleDelta(p.angle, Math.atan2(to.dy, to.dx))) < 0.9) return c;
    }
    return null;
  }

  // ---------------------------------------------------------------- snapshot
  /**
   * Estado serializado compacto para la red.
   * Es la UNICA fuente de verdad: el cliente solo interpola esto.
   * Las entidades estan acotadas (balas, rocas y pickups) para que el payload
   * quede dentro de NET.maxSnapshotBytes.
   */
  snapshot() {
    const ps = [];
    for (const p of this.list()) {
      let flags = 0;
      if (p.alive) flags |= FLAG.ALIVE;
      if (this.time < p.protectUntil) flags |= FLAG.PROTECTED;
      if (p.bot) flags |= FLAG.BOT;
      if (p.boostTimer > 0) flags |= FLAG.BOOSTING;
      if (p.buffs.shield > 0) flags |= FLAG.SHIELD;
      if (p.buffs.rapid > 0) flags |= FLAG.RAPID;
      if (p.buffs.spread > 0) flags |= FLAG.SPREAD;
      if (this.mode === 'arcade' && !p.alive && p.respawnAt - this.time > ELIMINATED_AFTER) {
        flags |= FLAG.ELIMINATED;
      }
      ps.push([
        p.id,
        p.team,
        r2(p.x),
        r2(p.y),
        r2(p.vx),
        r2(p.vy),
        r3(p.angle),
        Math.round(p.hp),
        flags,
        r2(p.boostCd),
        Math.max(0, r2(p.protectUntil - this.time)),
        Math.min(99, Math.max(0, r2(p.respawnAt - this.time))),
        p.kills,
        p.deaths,
        p.ack,
      ]);
    }

    // Buffs activos: solo los jugadores que tienen alguno (compacto).
    const bf = [];
    for (const p of this.list()) {
      if (BUFF_TYPES.some((type) => p.buffs[type] > 0)) {
        bf.push([p.id, r1(p.buffs.shield), r1(p.buffs.rapid), r1(p.buffs.spread), r1(p.buffs.laser), r1(p.buffs.heavy), r1(p.buffs.homing), r1(p.buffs.mine), r1(p.buffs.barrage), r1(p.buffs.overdrive), r1(p.buffs.magnet), r1(p.buffs.leech), r1(p.buffs.jam)]);
      }
    }

    return {
      t: 'snap',
      tk: this.tickCount,
      ph: this.phase,
      gm: this.mode,
      // Contrato con el frontend: la arena, la configuración y la colina de
      // ESTA partida viajan en cada snapshot (nunca se asume la clásica).
      world: { w: this.world.w, h: this.world.h },
      settings: this.settingsPayload(),
      hill: this.hillPayload(),
      tl: r2(this.timeLeft),
      cd: r2(this.countdown),
      et: r2(this.endedTimer),
      sc: [r1(this.score.cyan), r1(this.score.coral)],
      hs: this.hillStatus,
      hc: [this.hillCounts.cyan, this.hillCounts.coral],
      win: this.winner,
      wr: this.winReason,
      wi: this.winnerId,
      rn: this.roundNumber,
      wv: this.wave,
      lv: this.lives,
      ps,
      bs: this.bullets.map((b) => [
        b.id,
        r2(b.x),
        r2(b.y),
        r2(Math.atan2(b.vy, b.vx)),
        b.team === 'cyan' ? 0 : 1,
        b.owner,
        b.kind ?? 'auto',
      ]),
      // Las formas de los asteroides NO viajan por la red: el cliente las
      // regenera de forma determinista a partir de la semilla de la partida.
      as: this.asteroids.map((a) => [a.id, r2(a.x), r2(a.y), r3(a.angle), a.size, Math.round(a.hp), a.superCore === true ? 1 : 0]),
      pu: this.pickups.map((pu) => [pu.id, r2(pu.x), r2(pu.y), POWERUP_TYPES.indexOf(pu.type), r1(Math.max(0, POWERUP.life - pu.age))]),
      bf,
      tac: this.tacticalSnapshot(),
      sd: this.seed,
    };
  }

  /**
   * Bloque táctico del snapshot (ADDITIVE: no toca ningún índice clásico).
   *  - `on`: verdadero SOLO con perfil táctico Y modo koth/tdm
   *  - `ps`: [id, weapon, dashCd, downedRemaining, reviveProgress(0..1), downedHp,
   *          model, aiming, ammoSniper, ammoBoomer, smokeAmmo, bounceCd,
   *          aimCharge(0..1)]                                (v2: 13 campos)
   *  - `cs`: [id, x, y, r, hp, maxHp, w, h, kind]           (v2: 9 campos;
   *          `w>0 && h>0` = rectángulo axis-aligned; `r` = bounding radius.
   *          Las filas de 6 campos de la v0.1 siguen siendo círculos válidos)
   *  - `map`: 'citadel' | 'orbit' (autoridad del campo de batalla)
   *  - `wp` : [[id, x, y, type, remaining]] pads de armas (cooldown restante)
   *  - `sm` : [[id, x, y, r, remaining, team]] nubes de humo
   *  - `dashCooldown`: enfriamiento de esquiva vigente (0 = Zero Dash), siempre numérico
   * `downedRemaining > 0` distingue a un derribado de un muerto.
   *
   * Nota honesta: el snapshot es COMPARTIDO (no hay niebla por jugador). El
   * humo tapa la LOS del combate y de la IA, no esconde estado del cliente.
   */
  tacticalSnapshot() {
    const on = this.tacticalActive || this.barrelRollActive;
    const ps = this.list().map((p) => [
      p.id,
      p.weapon ?? WEAPON_DEFAULT,
      r2(p.dashCd),
      p.downed ? r2(Math.max(0, p.downedUntil - this.time)) : 0,
      p.downed ? r2(Math.min(1, p.reviveProgress / TACTICAL.downed.reviveSeconds)) : 0,
      p.downed ? Math.round(p.downedHp) : 0,
      p.model ?? SHIP_DEFAULT,
      p.aiming === true,
      p.ammoSniper ?? 0,
      p.ammoBoomer ?? 0,
      p.smokeAmmo ?? 0,
      r2(p.bounceCd ?? 0),
      r2(Math.min(1, Math.max(0, p.aimCharge01 ?? 0))),
    ]);
    const cs = on
      ? this.covers.map((c) => [
          c.id,
          r2(c.x),
          r2(c.y),
          c.r,
          Math.round(c.hp),
          c.maxHp,
          c.w ?? 0,
          c.h ?? 0,
          c.kind ?? 'block',
        ])
      : [];
    const wp = on ? this.pads.map((pad) => [pad.id, r2(pad.x), r2(pad.y), pad.type, r1(pad.cd)]) : [];
    const sm = on
      ? this.smokes.map((s) => [s.id, r2(s.x), r2(s.y), s.r, r1(Math.max(0, s.remaining)), s.team])
      : [];
    return { on, ps, cs, map: this.battlefield, wp, sm, dashCooldown: this.dashCooldown };
  }
}

/**
 * Vista LEGACY del input: exactamente los 6 campos clásicos de vuelo. Se usa en
 * los modos donde el perfil táctico no actúa (FFA y arcade) para que ninguna
 * intención nueva (`aim`, `moveX/moveY`, `smoke`, `bounce`, `dash`) tenga efecto
 * aunque un cliente las envíe.
 */
function legacyFlight(input) {
  return {
    seq: Number.isFinite(input?.seq) ? input.seq : 0,
    rot: clamp(input?.rot | 0, -1, 1),
    thrust: input?.thrust === true,
    brake: input?.brake === true,
    fire: input?.fire === true,
    boost: input?.boost === true,
    // Movement profiles are independent of combat mode. Legacy inputs still
    // cannot enable aim/strafe without the explicit, validated flight intent.
    ...(sanitizeFlight(input?.flight) ? {
      flight: sanitizeFlight(input.flight),
      moveX: clamp(Number.isFinite(input.moveX) ? input.moveX : 0, -1, 1),
      moveY: clamp(Number.isFinite(input.moveY) ? input.moveY : 0, -1, 1),
      aim: input.aim === true,
      aimAngle: Number.isFinite(input.aimAngle) ? input.aimAngle : 0,
    } : {}),
  };
}

/**
 * Normaliza una cobertura venida del mapa (agente de geometría) al formato
 * INTERNO de la partida: id propio, posición en el mundo y `w/h/kind` del
 * contrato v2 (`w>0 && h>0` = rectángulo axis-aligned; `r` = bounding radius
 * para minimapa/colina, nunca la colisión).
 */
function normalizeCover(c, id, world) {
  const src = c ?? {};
  const w = Number.isFinite(src.w) ? Math.max(0, src.w) : 0;
  const h = Number.isFinite(src.h) ? Math.max(0, src.h) : 0;
  const rect = w > 0 && h > 0;
  const hp = Number.isFinite(src.hp) && src.hp > 0 ? src.hp : TACTICAL.cover.hp;
  const r = Number.isFinite(src.r) && src.r > 0 ? src.r : rect ? Math.max(w, h) / 2 : TACTICAL.cover.radius;
  return {
    id,
    x: wrap(Number(src.x) || 0, world.w),
    y: wrap(Number(src.y) || 0, world.h),
    r,
    hp,
    maxHp: Number.isFinite(src.maxHp) && src.maxHp > 0 ? src.maxHp : hp,
    w,
    h,
    kind: COVER_KINDS.includes(src.kind) ? src.kind : rect ? 'wall' : 'block',
  };
}

const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;
const r3 = (v) => Math.round(v * 1000) / 1000;
