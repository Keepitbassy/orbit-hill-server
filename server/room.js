// Orbit Hill - salas por codigo.
// Una sala agrupa hasta 8 humanos y ajusta su plantilla segun el modo:
//  - koth/tdm: 4 humanos por equipo y bots reemplazables hasta 4v4.
//  - ffa:      cada humano es su propia faccion; bots hasta 8 jugadores.
//  - arcade:   cooperativo sin bots, solo humanos (1 a 8).
// Cada sala tiene su propia simulacion: nada de una sala puede filtrarse a otra.

import { Match } from './match.js';
import {
  TEAMS,
  TEAM_SIZE,
  MAX_HUMANS_PER_ROOM,
  TICKS_PER_SNAPSHOT,
  TEAM_COLORS,
  MODE_DEFAULT,
  MODE_LABEL,
  ARCADE,
  NET,
  HILL_SECONDS_DEFAULT,
  HILL_SECONDS_OPTIONS,
  BATTLEFIELD_DEFAULT,
} from '../shared/constants.js';
import {
  sanitizeInput,
  sanitizeChat,
  sanitizeMode,
  sanitizeArenaSettings,
  canChooseTeam,
  suggestedTeam,
  teamCounts,
  modeInfo,
  listModes,
  listArenas,
  ffaTeamForIndex,
  freeHumanSlot,
} from '../shared/rules.js';
import { BATTLEFIELDS, sanitizeBattlefield } from '../shared/battlefield.js';

/** Catálogo de campos de batalla para la UI (nunca inventa ids). */
export function listBattlefields() {
  return BATTLEFIELDS.map((b) => ({ id: b.id, label: b.label }));
}

let roomSeq = 0;

export class Room {
  constructor(code, { rng = Math.random, mode = MODE_DEFAULT, settings = null } = {}) {
    this.code = code;
    this.id = `room-${++roomSeq}`;
    this.clients = new Map();   // id de jugador humano -> cliente
    // `settings` es opcional: sin él la sala conserva el comportamiento
    // histórico (arena clásica 1800×1200 y colina cada 45 s).
    // En este PROTOTIPO la sala activa el perfil táctico por defecto: el
    // combate táctico entra en koth/tdm y FFA/arcade conservan sus reglas.
    this.match = new Match({
      rng,
      seed: hashCode(code),
      mode,
      arena: settings?.arena,
      hillSeconds: settings?.hillSeconds,
      stocks: settings?.stocks,
      teamTargets: settings?.teamTargets,
      // Ciudadela es el campo de batalla por defecto de las SALAS nuevas; la
      // API directa de Match sigue arrancando en `orbit`.
      battlefield: settings?.battlefield ?? BATTLEFIELD_DEFAULT,
      tactical: true,
      // Este prototipo es Zero Dash: las salas nuevas nacen con esquiva SIN
      // enfriamiento (0 s). No viaja por `settings`: es autoridad de la sala y
      // el cliente no puede alterarlo. La API de Match conserva su default 2.6.
      dashCooldown: 0,
      dashSpeed: 416, // ensayo: 20% menos impulso
    });
    this.hostId = null;
    this.tickAcc = 0;
    this.createdAt = Date.now();
    this.roundStartedAt = null;
    this.chat = [];
  }

  get mode() {
    return this.match.mode;
  }

  get rules() {
    return this.match.rules;
  }

  teamTarget(team) { return this.match.teamTargets?.[team] ?? TEAM_SIZE; }

  get arena() {
    return this.match.arena;
  }

  get hillSeconds() {
    return this.match.hillSeconds;
  }

  /** Campo de batalla vigente (geometría elegida por el anfitrión). */
  get battlefield() {
    return this.match.battlefield;
  }

  /**
   * Combate táctico efectivo de la sala AHORA MISMO (perfil + modo koth/tdm).
   * El cliente lo usa para saber si debe pintar HUD táctico, pero la verdad
   * viaja igualmente en `snapshot().tac.on`.
   */
  get tacticalActive() {
    return this.match.tacticalActive;
  }

  /** Configuración vigente de la sala (arena + rotación de la colina). */
  settingsPayload() {
    return this.match.settingsPayload();
  }

  worldPayload() {
    return { w: this.match.world.w, h: this.match.world.h };
  }

  // -------------------------------------------------------------- jugadores
  get humanPlayers() {
    return [...this.clients.values()].map((c) => c.playerId);
  }

  humanCount() {
    return this.clients.size;
  }

  isEmpty() {
    return this.clients.size === 0;
  }

  /**
   * Intenta meter un cliente humano en la sala.
   * Devuelve {ok:true, player, team} o {ok:false, reason}.
   * En arcade y ffa se ignora la preferencia de equipo: no hay equipos aliados.
   */
  addClient(client, { name, team }) {
    if (this.clients.has(client.playerId)) return { ok: false, reason: 'ya_en_sala' };
    if (this.clients.size >= MAX_HUMANS_PER_ROOM) return { ok: false, reason: 'sala_llena' };

    const mode = this.match.mode;
    const slot = this.freeSlot();
    let chosen = null;
    if (mode === 'arcade') {
      chosen = 'cyan';
    } else if (mode === 'ffa') {
      // Cada piloto ocupa su propia faccion; si la sala esta llena de bots,
      // el recien llegado toma el puesto de uno de ellos.
      if (this.match.list().length >= MAX_HUMANS_PER_ROOM) this.match.removeAnyBot();
      chosen = this.match.freeFfaTeam();
    } else {
      const players = this.match.list();
      if (team && TEAMS.includes(team)) {
        if (teamCounts(players).humans[team] >= this.teamTarget(team)) return { ok: false, reason: 'equipo_lleno' };
        chosen = team;
      } else {
        chosen = TEAMS.find((candidate) => teamCounts(players).humans[candidate] < this.teamTarget(candidate)) ?? null;
      }
      if (!chosen) return { ok: false, reason: 'equipo_lleno' };
      if (this.match.listTeam(chosen).length >= this.teamTarget(chosen)) this.match.removeBotFrom(chosen);
    }

    const player = this.match.addPlayer(client.playerId, { name, bot: false, team: chosen, slot });
    client.roomCode = this.code;
    client.team = chosen;
    client.slot = slot;
    this.clients.set(client.playerId, client);
    if (!this.hostId) this.hostId = client.playerId;

    this.refillBots();
    // El roster se avisa al resto sin el recien llegado: el servidor le manda
    // su `welcome` antes de cualquier roster.
    this.broadcast(this.rosterPayload(), client.playerId);
    return { ok: true, player, team: chosen };
  }

  /** Completa la plantilla del modo con bots (arcade nunca añade bots). */
  refillBots() {
    this.match.fillWithBots();
    this.syncClientTeams();
  }

  /** Plaza humana libre 1-8 (estable mientras el jugador siga conectado). */
  freeSlot() {
    return freeHumanSlot([...this.clients.values()].map((c) => c.slot));
  }

  /** Mantiene `client.team` en sincronia tras recomponer la plantilla. */
  syncClientTeams() {
    for (const client of this.clients.values()) {
      const p = this.match.getPlayer(client.playerId);
      if (p) client.team = p.team;
    }
  }

  removeClient(playerId) {
    const client = this.clients.get(playerId);
    if (!client) return false;
    this.clients.delete(playerId);
    this.match.removePlayer(playerId);
    client.roomCode = null;
    client.slot = null;

    if (this.hostId === playerId) {
      this.hostId = this.clients.keys().next().value ?? null;
    }
    this.refillBots();
    this.broadcastRoster();
    return true;
  }

  /** Cambia de equipo a un humano (solo en modos por equipos, en lobby/ended). */
  changeTeam(client, team) {
    if (!this.rules.teamBased) return { ok: false, reason: 'sin_equipos' };
    // Bloqueado en partida: cambiar después de disparar no debe mover crédito
    // de bajas entre equipos.
    const phase = this.match.phase;
    if (phase !== 'lobby' && phase !== 'ended') return { ok: false, reason: 'en_partida' };
    if (!TEAMS.includes(team)) return { ok: false, reason: 'equipo_invalido' };
    if (client.team === team) return { ok: true, team };
    const others = this.match.list().filter((p) => p.id !== client.playerId);
    if (teamCounts(others).humans[team] >= this.teamTarget(team)) return { ok: false, reason: 'equipo_lleno' };

    if (this.match.listTeam(team).length >= this.teamTarget(team)) this.match.removeBotFrom(team);
    this.match.setTeam(client.playerId, team);
    client.team = team;
    this.refillBots();
    this.broadcastRoster();
    return { ok: true, team };
  }

  /**
   * Recompone equipos/facciones segun el modo actual sin tocar las conexiones.
   * Nunca deja mas de 8 naves: quita bots y reasigna humanos.
   */
  rebalanceTeams() {
    const mode = this.match.mode;
    const humans = this.match.list().filter((p) => !p.bot);
    for (const bot of this.match.list()) {
      if (bot.bot) this.match.removePlayer(bot.id);
    }

    if (mode === 'arcade') {
      for (const h of humans) this.match.setTeam(h.id, 'cyan');
    } else if (mode === 'ffa') {
      const used = new Set();
      for (const h of humans) {
        let idx = 0;
        while (used.has(ffaTeamForIndex(idx))) idx += 1;
        const team = ffaTeamForIndex(idx);
        used.add(team);
        this.match.setTeam(h.id, team);
      }
    } else {
      const counts = { cyan: 0, coral: 0 };
      for (const h of humans) {
        const preferred = TEAMS.includes(h.team) ? h.team : null;
        let team = preferred && counts[preferred] < this.teamTarget(preferred) ? preferred : null;
        if (!team) {
          team = counts.cyan < this.teamTarget('cyan') && counts.cyan <= counts.coral ? 'cyan'
            : counts.coral < this.teamTarget('coral') ? 'coral' : 'cyan';
        }
        counts[team] += 1;
        this.match.setTeam(h.id, team);
      }
    }
    this.syncClientTeams();
  }

  /**
   * Cambio de modo: SOLO el anfitrion y SOLO en lobby o pausa final.
   * Resetea rondas, equipos, marcador y buffs de forma consistente.
   */
  setMode(client, rawMode) {
    if (client.playerId !== this.hostId) return { ok: false, reason: 'no_eres_host' };
    const phase = this.match.phase;
    if (phase !== 'lobby' && phase !== 'ended') return { ok: false, reason: 'en_partida' };
    const mode = sanitizeMode(rawMode);
    if (!mode) return { ok: false, reason: 'modo_invalido' };

    this.match.setMode(mode);
    this.rebalanceTeams();
    this.refillBots();
    for (const c of this.clients.values()) c.rematchVote = false;
    this.broadcastRoster();
    return { ok: true, mode };
  }

  /**
   * Cambio de arena y/o rotación de la colina: SOLO el anfitrión y SOLO en
   * lobby o pausa final. La validación es atómica: si un campo viene mal, se
   * rechaza el mensaje entero y la partida no cambia en absoluto.
   */
  setSettings(client, msg) {
    if (client.playerId !== this.hostId) return { ok: false, reason: 'no_eres_host' };
    const phase = this.match.phase;
    if (phase !== 'lobby' && phase !== 'ended') return { ok: false, reason: 'en_partida' };

    // La arena no se puede cambiar a mitad de una partida de arcade en curso
    // (sus oleadas ya están generadas), pero sí al terminar: `ended` pasa.
    const parsed = sanitizeArenaSettings(msg);
    if (!parsed.ok) return parsed;

    const arena = parsed.arena ?? this.match.arena;
    const hillSeconds = parsed.hillSeconds ?? this.match.hillSeconds;
    const stocks = parsed.stocks ?? this.match.stocks;
    if (arena === this.match.arena && hillSeconds === this.match.hillSeconds && stocks === this.match.stocks) {
      return { ok: true, arena, hillSeconds, stocks, unchanged: true };
    }
    this.match.applySettings({ arena, hillSeconds, stocks });
    // Todas las conexiones (invitados incluidos) ven la misma configuración.
    this.broadcastRoster();
    return { ok: true, arena: this.match.arena, hillSeconds: this.match.hillSeconds, stocks: this.match.stocks };
  }

  /**
   * Cambio de CAMPO DE BATALLA: SOLO el anfitrión y SOLO en lobby o pausa
   * final. Validación atómica: un id inválido no cambia absolutamente nada.
   * El campo elegido viaja SIEMPRE aparte de `settings` (que solo lleva arena y
   * rotación de colina) para no romper el contrato existente.
   */
  setBattlefield(client, raw) {
    if (client.playerId !== this.hostId) return { ok: false, reason: 'no_eres_host' };
    const phase = this.match.phase;
    if (phase !== 'lobby' && phase !== 'ended') return { ok: false, reason: 'en_partida' };
    const battlefield = sanitizeBattlefield(raw);
    if (!battlefield) return { ok: false, reason: 'battlefield_invalido' };
    if (battlefield === this.match.battlefield) {
      return { ok: true, battlefield, unchanged: true };
    }
    this.match.setBattlefield(battlefield);
    this.broadcastRoster();
    return { ok: true, battlefield: this.match.battlefield };
  }

  // ------------------------------------------------------------------ partida
  canStart() {
    const p = this.match.phase;
    return (p === 'lobby' || p === 'ended') && this.clients.size >= 1;
  }

  startMatch() {
    const wasEnded = this.match.phase === 'ended';
    this.match.roundNumber = (this.match.roundNumber ?? 1) + (wasEnded ? 1 : 0);
    this.rebalanceTeams();
    this.refillBots();
    this.match.startMatch();
    for (const c of this.clients.values()) c.rematchVote = false;
    this.roundStartedAt = Date.now();
    this.broadcastRoster();
    return true;
  }

  /** Voto de revancha: cuando votan todos los humanos (o el host fuerza), arranca. */
  voteRematch(client, force = false) {
    if (this.match.phase !== 'ended' && this.match.phase !== 'lobby') return false;
    client.rematchVote = true;
    const humans = [...this.clients.values()];
    const votes = humans.filter((c) => c.rematchVote).length;
    if (force || (humans.length > 0 && votes === humans.length)) {
      this.startMatch();
      return true;
    }
    this.broadcast({ t: 'votes', votes, total: humans.length });
    return false;
  }

  // -------------------------------------------------------------------- red
  send(client, obj) {
    client.send(obj);
  }

  broadcast(obj, exceptId = null) {
    const payload = typeof obj === 'string' ? obj : JSON.stringify(obj);
    for (const client of this.clients.values()) {
      if (exceptId && client.playerId === exceptId) continue;
      client.sendRaw(payload);
    }
  }

  rosterPayload() {
    const players = this.match.list().sort((a, b) => a.id.localeCompare(b.id));
    const mode = this.match.mode;
    const info = modeInfo(mode);
    return {
      t: 'roster',
      code: this.code,
      host: this.hostId,
      phase: this.match.phase,
      round: this.match.roundNumber,
      mode,
      modeLabel: MODE_LABEL[mode],
      objective: info.objective,
      teamBased: info.teamBased,
      modes: listModes(),
      players: players.map((p) => ({
        id: p.id,
        name: p.name,
        team: p.team,
        bot: p.bot,
        slot: p.slot ?? null,
        kills: p.kills,
        deaths: p.deaths,
        color: TEAM_COLORS[p.team] ?? '#9fc4ff',
      })),
      teams: teamCounts(players),
      maxPerTeam: info.teamBased ? Math.max(this.teamTarget('cyan'), this.teamTarget('coral')) : 0,
      teamTargets: info.teamBased ? this.match.teamTargets : null,
      maxHumans: MAX_HUMANS_PER_ROOM,
      target: info.target,
      timeLimit: info.timeLimit,
      arcadeLives: ARCADE.sharedLives,
      arcadeWaves: ARCADE.wavesToWin,
      // Indicador de perfil táctico (aditivo): la verdad del combate táctico
      // viaja igualmente en cada `snap.tac.on`.
      tactical: this.tacticalActive,
      // Configuración vigente: la ven por igual anfitrión, invitados y el
      // nuevo anfitrión tras una transferencia de host.
      settings: this.settingsPayload(),
      world: this.worldPayload(),
      hill: this.match.hillPayload(),
      arenas: listArenas(),
      hillSecondsOptions: [...HILL_SECONDS_OPTIONS],
      hillSecondsDefault: HILL_SECONDS_DEFAULT,
      // Campo de batalla: SIEMPRE aparte de `settings` (contrato v2).
      battlefield: this.match.battlefield,
      battlefields: listBattlefields(),
    };
  }

  broadcastRoster() {
    this.broadcast(this.rosterPayload());
  }

  handleMessage(client, msg) {
    switch (msg.t) {
      case 'input': {
        const input = sanitizeInput(msg);
        if (!input) return;
        // El servidor decide cadencia de disparo; el cliente solo pide.
        this.match.setInput(client.playerId, input);
        return;
      }
      case 'team': {
        const res = this.changeTeam(client, msg.team);
        if (!res.ok) client.send({ t: 'error', code: res.reason, message: teamErrorES(res.reason) });
        return;
      }
      case 'mode': {
        const res = this.setMode(client, msg.mode);
        if (!res.ok) client.send({ t: 'error', code: res.reason, message: modeErrorES(res.reason) });
        return;
      }
      case 'settings': {
        const res = this.setSettings(client, msg);
        if (!res.ok) client.send({ t: 'error', code: res.reason, message: settingsErrorES(res.reason) });
        return;
      }
      case 'battlefield': {
        const res = this.setBattlefield(client, msg.battlefield);
        if (!res.ok) client.send({ t: 'error', code: res.reason, message: battlefieldErrorES(res.reason) });
        return;
      }
      case 'start': {
        if (client.playerId !== this.hostId) {
          client.send({ t: 'error', code: 'no_eres_host', message: 'Solo el anfitrión puede iniciar.' });
          return;
        }
        if (!this.canStart()) {
          client.send({ t: 'error', code: 'no_se_puede', message: 'La partida ya está en curso.' });
          return;
        }
        this.startMatch();
        return;
      }
      case 'chaos_armory': {
        const player = this.match.getPlayer(client.playerId);
        if (this.match.mode === 'chaos' && this.match.phase === 'playing' && player) {
          this.match.activateChaosWeapon(player);
        }
        return;
      }
      case 'end_game': {
        if (client.playerId !== this.hostId) {
          client.send({ t: 'error', code: 'no_eres_host', message: 'Solo el anfitrión puede terminar la partida.' });
          return;
        }
        if (this.match.phase !== 'playing' && this.match.phase !== 'countdown') {
          client.send({ t: 'error', code: 'no_en_partida', message: 'No hay una partida en curso.' });
          return;
        }
        this.match.endMatch('draw', 'host');
        return;
      }
      case 'rematch': {
        const force = client.playerId === this.hostId && msg.force === true;
        this.voteRematch(client, force);
        return;
      }
      case 'chat': {
        const text = sanitizeChat(msg.text);
        if (!text) return;
        const player = this.match.getPlayer(client.playerId);
        const entry = {
          t: 'chat',
          from: player?.name ?? '???',
          team: client.team,
          text,
        };
        this.chat.push(entry);
        if (this.chat.length > 40) this.chat.shift();
        this.broadcast(entry);
        return;
      }
      default:
        client.send({ t: 'error', code: 'mensaje_desconocido', message: 'Mensaje no reconocido.' });
    }
  }

  // ------------------------------------------------------------------- loop
  tick(dt) {
    this.match.tick(dt);
    this.tickAcc += 1;
    // En lobby no hace falta estado a 20 Hz: bajamos a ~2 Hz para no inundar.
    const period = this.match.phase === 'lobby' ? TICKS_PER_SNAPSHOT * 10 : TICKS_PER_SNAPSHOT;
    if (this.tickAcc >= period) {
      this.tickAcc = 0;
      const snap = this.match.snapshot();
      const events = this.match.drainEvents();
      const payload = { ...snap, ev: events };
      this.broadcast(payload);
      if (this.match.phase === 'ended' && this.match.endedTimer <= 0) {
        // Fin de la pausa final: la sala se queda en lobby esperando revancha.
        this.match.phase = 'lobby';
        this.refillBots();
        this.broadcastRoster();
      }
    }
  }
}

export class RoomManager {
  constructor({ rng = Math.random, codeGen = defaultCodeGen } = {}) {
    this.rooms = new Map();
    this.rng = rng;
    this.codeGen = codeGen;
    this.lastTick = Date.now();
  }

  /**
   * Crea una sala. `settings` ({ arena, hillSeconds }) es opcional: sin él la
   * sala arranca en la arena clásica y la colina por defecto (API antigua).
   */
  createRoom(mode = MODE_DEFAULT, settings = null) {
    let code = null;
    for (let i = 0; i < 40; i++) {
      const candidate = this.codeGen();
      if (!this.rooms.has(candidate)) {
        code = candidate;
        break;
      }
    }
    if (!code) throw new Error('sin_codigos_libres');
    const room = new Room(code, { rng: this.rng, mode, settings });
    this.rooms.set(code, room);
    return room;
  }

  getRoom(code) {
    return this.rooms.get(code) ?? null;
  }

  deleteRoom(code) {
    return this.rooms.delete(code);
  }

  sweep() {
    for (const [code, room] of this.rooms) {
      if (room.isEmpty()) this.rooms.delete(code);
    }
  }

  /** Tick global de todas las salas a 60 Hz. */
  tickAll(dt, onError) {
    for (const room of this.rooms.values()) {
      try {
        room.tick(dt);
      } catch (err) {
        if (onError) onError(err, room);
        else throw err;
      }
    }
  }
}

export function teamErrorES(reason) {
  switch (reason) {
    case 'equipo_lleno': return 'Ese equipo ya tiene 4 jugadores.';
    case 'equipo_invalido': return 'Equipo inválido.';
    case 'sin_equipos': return 'Este modo no usa equipos.';
    case 'en_partida': return 'Solo puedes cambiar de equipo en la sala o al terminar la partida.';
    case 'sala_llena': return 'La sala está llena (8 jugadores).';
    default: return 'No se pudo completar la acción.';
  }
}

export function modeErrorES(reason) {
  switch (reason) {
    case 'no_eres_host': return 'Solo el anfitrión puede cambiar el modo.';
    case 'en_partida': return 'Cambia el modo en la sala o al terminar la partida.';
    case 'modo_invalido': return 'Modo de juego desconocido.';
    default: return 'No se pudo cambiar el modo.';
  }
}

export function settingsErrorES(reason) {
  switch (reason) {
    case 'no_eres_host': return 'Solo el anfitrión puede cambiar la arena.';
    case 'en_partida': return 'Cambia la arena en la sala o al terminar la partida.';
    case 'arena_invalida': return 'Tamaño de arena desconocido.';
    case 'hill_seconds_invalido': return 'Ritmo de colina inválido (0, 30, 45, 60 o 90 s).';
    case 'sin_cambios': return 'No hay nada que cambiar.';
    case 'settings_invalidos': return 'Configuración inválida.';
    default: return 'No se pudo aplicar la configuración.';
  }
}

/** Mensajes de error del campo de batalla (lobby del anfitrión). */
export function battlefieldErrorES(reason) {
  switch (reason) {
    case 'no_eres_host': return 'Solo el anfitrión puede cambiar el mapa.';
    case 'en_partida': return 'Cambia el mapa en la sala o al terminar la partida.';
    case 'battlefield_invalido': return 'Mapa desconocido.';
    case 'sin_cambios': return 'Ese mapa ya está activo.';
    default: return 'No se pudo aplicar el mapa.';
  }
}

export function defaultCodeGen() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 4; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

function hashCode(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export { NET };
