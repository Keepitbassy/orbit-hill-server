// Orbit Hill - servidor autoritativo.
// Node puro + `ws`. Bind local por defecto (127.0.0.1); para LAN usar
// `npm run start:lan` (ORBIT_HILL_HOST=0.0.0.0).

import { createServer as createHttpServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { WebSocketServer } from 'ws';

import { RoomManager, teamErrorES, settingsErrorES, battlefieldErrorES, listBattlefields } from './room.js';
import { RateLimiter, parseClientFrame, isKnownMessage } from './validate.js';
import { createStaticHandler } from './static.js';
import { sanitizeBattlefield } from '../shared/battlefield.js';
import {
  DT,
  TICK_RATE,
  NET,
  TEAMS,
  TEAM_SIZE,
  MAX_HUMANS_PER_ROOM,
  SCORE_TO_WIN,
  MATCH_SECONDS,
  MODE_DEFAULT,
  MODE_LABEL,
  ARENA_DEFAULT,
  HILL_SECONDS_DEFAULT,
  HILL_SECONDS_OPTIONS,
  BATTLEFIELD_DEFAULT,
} from '../shared/constants.js';
import {
  sanitizeName,
  sanitizeRoomCode,
  sanitizeMode,
  sanitizeArena,
  sanitizeHillSeconds,
  modeInfo,
  listModes,
  listArenas,
} from '../shared/rules.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

let clientSeq = 0;

export function createGameServer(options = {}) {
  const {
    host = '127.0.0.1',
    port = 0,
    rng = Math.random,
    publicDir = join(ROOT, 'public'),
    sharedDir = join(ROOT, 'shared'),
    log = () => {},
    tickRate = TICK_RATE,
    autoTick = true,
    heartbeatMs = 15000,
  } = options;

  const manager = new RoomManager({ rng });
  const staticHandler = createStaticHandler({ publicDir, sharedDir });

  const httpServer = createHttpServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          rooms: manager.rooms.size,
          players: [...manager.rooms.values()].reduce((a, r) => a + r.humanCount(), 0),
          uptime: process.uptime(),
        }),
      );
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('405 Método no permitido');
      return;
    }
    const served = staticHandler(req, res);
    if (!served) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('404 No encontrado');
    }
  });

  const wss = new WebSocketServer({
    server: httpServer,
    maxPayload: NET.maxMessageBytes * 2,
    perMessageDeflate: false,
  });

  /** @type {Map<import('ws').WebSocket, any>} */
  const clients = new Map();

  function makeClient(socket) {
    const id = `p${++clientSeq}`;
    const client = {
      id,
      playerId: id,
      name: 'Piloto',
      socket,
      team: null,
      roomCode: null,
      room: null,
      limiter: new RateLimiter({ rate: NET.msgsPerSecond, burst: NET.msgBurst }),
      strikes: 0,
      isAlive: true,
      rematchVote: false,
      connectedAt: Date.now(),
      send(obj) {
        this.sendRaw(JSON.stringify(obj));
      },
      sendRaw(payload) {
        if (socket.readyState !== 1) return false;
        if (payload.length > NET.maxSnapshotBytes) return false;
        // Backpressure: si el socket acumula demasiado, se descartan los
        // mensajes grandes (snapshots) en vez de encolar sin límite.
        if (payload.length > NET.maxMessageBytes && socket.bufferedAmount > NET.maxBufferedBytes) return false;
        try {
          socket.send(payload);
          return true;
        } catch {
          return false;
        }
      },
      kick(code, reason) {
        try {
          socket.close(code, reason);
        } catch {
          socket.terminate?.();
        }
      },
    };
    return client;
  }

  function handleCreate(client, msg) {
    if (client.room) {
      client.send({ t: 'error', code: 'ya_en_sala', message: 'Ya estás en una sala.' });
      return;
    }
    const name = sanitizeName(msg.name) ?? 'Piloto';
    const team = TEAMS.includes(msg.team) ? msg.team : null;
    const mode = sanitizeMode(msg.mode) ?? MODE_DEFAULT;
    // Arena y ritmo de colina opcionales: si el cliente no los manda se
    // conserva el comportamiento clásico; si los manda mal, error claro.
    const settings = { arena: ARENA_DEFAULT, hillSeconds: HILL_SECONDS_DEFAULT };
    if (msg.arena !== undefined) {
      const arena = sanitizeArena(msg.arena);
      if (!arena) {
        client.send({ t: 'error', code: 'arena_invalida', message: settingsErrorES('arena_invalida') });
        return;
      }
      settings.arena = arena;
    }
    if (msg.hillSeconds !== undefined) {
      const hillSeconds = sanitizeHillSeconds(msg.hillSeconds);
      if (hillSeconds === null) {
        client.send({ t: 'error', code: 'hill_seconds_invalido', message: settingsErrorES('hill_seconds_invalido') });
        return;
      }
      settings.hillSeconds = hillSeconds;
    }
    // Caos Orbital arranca abierto; los demás modos conservan Ciudadela.
    // Viaja APARTE de `settings` para no alterar el contrato existente.
    settings.battlefield = mode === 'chaos' ? 'orbit' : BATTLEFIELD_DEFAULT;
    const teamCyan = Number(msg.teamCyan ?? 4);
    const teamCoral = Number(msg.teamCoral ?? 4);
    if (!Number.isInteger(teamCyan) || !Number.isInteger(teamCoral) || teamCyan < 1 || teamCyan > TEAM_SIZE || teamCoral < 1 || teamCoral > TEAM_SIZE) {
      client.send({ t: 'error', code: 'equipos_invalidos', message: 'Cada equipo debe tener entre 1 y 4 pilotos.' });
      return;
    }
    settings.teamTargets = { cyan: teamCyan, coral: teamCoral };
    if (msg.battlefield !== undefined) {
      const battlefield = sanitizeBattlefield(msg.battlefield);
      if (!battlefield) {
        client.send({ t: 'error', code: 'battlefield_invalido', message: battlefieldErrorES('battlefield_invalido') });
        return;
      }
      settings.battlefield = battlefield;
    }
    const room = manager.createRoom(mode, settings);
    const res = room.addClient(client, { name, team });
    if (!res.ok) {
      manager.deleteRoom(room.code);
      client.send({ t: 'error', code: res.reason, message: teamErrorES(res.reason) });
      return;
    }
    client.name = name;
    client.room = room;
    sendWelcome(client, room, res.team);
    room.broadcastRoster();
    log(`sala ${room.code} creada por ${name} (${mode}, ${settings.arena})`);
  }

  function handleJoin(client, msg) {
    if (client.room) {
      client.send({ t: 'error', code: 'ya_en_sala', message: 'Ya estás en una sala.' });
      return;
    }
    const code = sanitizeRoomCode(msg.code);
    if (!code) {
      client.send({ t: 'error', code: 'codigo_invalido', message: 'Código de sala inválido.' });
      return;
    }
    const room = manager.getRoom(code);
    if (!room) {
      client.send({ t: 'error', code: 'sala_no_existe', message: `No existe la sala ${code}.` });
      return;
    }
    const name = sanitizeName(msg.name) ?? 'Piloto';
    const team = TEAMS.includes(msg.team) ? msg.team : null;
    const res = room.addClient(client, { name, team });
    if (!res.ok) {
      client.send({ t: 'error', code: res.reason, message: teamErrorES(res.reason) });
      return;
    }
    client.name = name;
    client.room = room;
    sendWelcome(client, room, res.team);
    room.broadcastRoster();
    log(`${name} entró a ${code} (${room.humanCount()}/${MAX_HUMANS_PER_ROOM})`);
  }

  function sendWelcome(client, room, team) {
    const mode = room.mode;
    const info = modeInfo(mode);
    client.send({
      t: 'welcome',
      id: client.playerId,
      name: client.name,
      code: room.code,
      team,
      host: room.hostId,
      mode,
      modeLabel: MODE_LABEL[mode],
      objective: info.objective,
      teamBased: info.teamBased,
      modes: listModes(),
      maxPerTeam: info.teamBased ? TEAM_SIZE : 0,
      maxHumans: MAX_HUMANS_PER_ROOM,
      scoreToWin: SCORE_TO_WIN,
      matchSeconds: MATCH_SECONDS,
      target: info.target,
      // Perfil táctico de la sala (aditivo). El estado real por frame viaja en
      // `snap.tac`; esto solo permite a la UI preparar el HUD.
      tactical: room.tacticalActive,
      // Contrato: la arena y la colina son las de ESTA sala/partida.
      settings: room.settingsPayload(),
      world: room.worldPayload(),
      hill: room.match.hillPayload(),
      arenas: listArenas(),
      hillSecondsOptions: [...HILL_SECONDS_OPTIONS],
      hillSecondsDefault: HILL_SECONDS_DEFAULT,
      // Campo de batalla (aditivo, SIEMPRE aparte de `settings`).
      battlefield: room.battlefield,
      battlefieldDefault: BATTLEFIELD_DEFAULT,
      battlefields: listBattlefields(),
      // Pads de armas del mapa vigente (ids/posiciones/tipos): el HUD puede
      // dibujarlos antes del primer snapshot. El estado (cooldown) viene en
      // `snap.tac.wp`.
      pads: room.match.pads.map((p) => ({ id: p.id, x: p.x, y: p.y, type: p.type })),
      tickRate,
    });
  }

  function handleFrame(client, msg) {
    switch (msg.t) {
      case 'create':
        return handleCreate(client, msg);
      case 'join':
        return handleJoin(client, msg);
      case 'ping':
        return client.send({ t: 'pong', ts: msg.ts });
      case 'name': {
        const name = sanitizeName(msg.name);
        if (!name) {
          client.send({ t: 'error', code: 'nombre_invalido', message: 'Nombre inválido.' });
          return;
        }
        client.name = name;
        const player = client.room?.match.getPlayer(client.playerId);
        if (player) player.name = name;
        client.room?.broadcastRoster();
        return;
      }
      default: {
        if (!client.room) {
          client.send({ t: 'error', code: 'sin_sala', message: 'Primero crea o únete a una sala.' });
          return;
        }
        return client.room.handleMessage(client, msg);
      }
    }
  }

  wss.on('connection', (socket, req) => {
    const client = makeClient(socket);
    clients.set(socket, client);
    socket.isAlive = true;
    log(`conexión ${client.id} desde ${req.socket.remoteAddress}`);

    socket.on('message', (data, isBinary) => {
      client.isAlive = true;
      socket.isAlive = true;
      const now = Date.now();

      if (!client.limiter.take(now)) {
        client.strikes += 2;
        if (client.strikes >= NET.strikesBeforeClose) {
          client.kick(1008, 'Demasiados mensajes');
        }
        return;
      }
      // ws entrega también los mensajes de texto como Buffer; isBinary
      // distingue el tipo del frame, no el contenedor de sus bytes.
      if (isBinary) {
        client.strikes += 1;
        if (client.strikes >= NET.strikesBeforeClose) client.kick(1008, 'Mensajes inválidos');
        return;
      }
      const size = typeof data === 'string' ? data.length : data.byteLength;
      if (size > NET.maxMessageBytes) {
        client.strikes += 1;
        return;
      }

      const msg = parseClientFrame(data, isBinary);
      if (!msg || !isKnownMessage(msg)) {
        client.strikes += 1;
        if (client.strikes >= NET.strikesBeforeClose) client.kick(1008, 'Mensajes inválidos');
        return;
      }

      try {
        handleFrame(client, msg);
      } catch (err) {
        log(`error procesando ${msg.t}: ${err.message}`);
        client.send({ t: 'error', code: 'error_servidor', message: 'Error interno del servidor.' });
      }
    });

    socket.on('pong', () => {
      client.isAlive = true;
      socket.isAlive = true;
    });

    socket.on('close', () => {
      if (client.room) client.room.removeClient(client.playerId);
      client.room = null;
      client.roomCode = null;
      clients.delete(socket);
      log(`desconexión ${client.id}`);
    });

    socket.on('error', () => {
      // Los errores de socket no deben tumbar la sala.
    });
  });

  let loopTimer = null;
  let last = Date.now();
  let accumulator = 0;

  function tickOnce(nowMs = Date.now()) {
    const elapsed = Math.max(0, Math.min(0.25, (nowMs - last) / 1000));
    last = nowMs;
    accumulator = Math.min(0.25, accumulator + elapsed);
    const step = 1 / tickRate;
    let safety = 0;
    while (accumulator >= step && safety < 12) {
      manager.tickAll(step, (err, room) => log(`error tick sala ${room.code}: ${err.message}`));
      accumulator -= step;
      safety += 1;
    }
    manager.sweep();
  }

  function startLoop() {
    if (loopTimer || !autoTick) return;
    last = Date.now();
    loopTimer = setInterval(() => tickOnce(), Math.round(1000 / tickRate));
    if (loopTimer.unref) loopTimer.unref();
  }

  function stopLoop() {
    if (loopTimer) clearInterval(loopTimer);
    loopTimer = null;
  }

  const heartbeat = setInterval(() => {
    if (heartbeat.unref) heartbeat.unref();
    for (const [socket, client] of clients) {
      if (socket.isAlive === false) {
        if (client.room) client.room.removeClient(client.playerId);
        clients.delete(socket);
        socket.terminate();
        continue;
      }
      socket.isAlive = false;
      try {
        socket.ping();
      } catch {
        /* ignorado */
      }
    }
  }, heartbeatMs);
  if (heartbeat.unref) heartbeat.unref();

  function listen(portArg = port, hostArg = host) {
    return new Promise((resolvePromise, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(portArg, hostArg, () => {
        last = Date.now();
        startLoop();
        const addr = httpServer.address();
        resolvePromise({ port: addr.port, host: addr.address, family: addr.family });
      });
    });
  }

  function close() {
    stopLoop();
    clearInterval(heartbeat);
    for (const socket of clients.keys()) {
      try {
        socket.terminate();
      } catch {
        /* ignorado */
      }
    }
    clients.clear();
    return new Promise((resolvePromise) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolvePromise();
      };
      // Red de seguridad: nunca dejamos el proceso colgado por un socket.
      const guard = setTimeout(finish, 1500);
      if (guard.unref) guard.unref();

      try {
        wss.close(finish);
      } catch {
        finish();
      }
      if (httpServer.listening) {
        httpServer.close(finish);
        httpServer.closeAllConnections?.();
      } else {
        finish();
      }
    });
  }

  return {
    httpServer,
    wss,
    manager,
    clients,
    tickOnce,
    listen,
    close,
    get address() {
      return httpServer.address();
    },
  };
}

// ------------------------------------------------------------------ arranque
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  // Desarrollo: el prototipo Ciudadela vive en el puerto 8797 y escucha SOLO en
  // la interfaz local. Para jugar desde otro equipo de la LAN:
  //   npm run start:lan   (ORBIT_HILL_HOST=0.0.0.0 ORBIT_HILL_PORT=8797)
  // y abre http://<tu-ip-local>:8797 desde el otro dispositivo.
  // Cloud hosts normally provide PORT and require 0.0.0.0. Local play keeps
  // the safer loopback default unless ORBIT_HILL_HOST is explicitly supplied.
  const host = process.env.ORBIT_HILL_HOST ?? (process.env.PORT ? '0.0.0.0' : '127.0.0.1');
  const port = Number(process.env.PORT ?? process.env.ORBIT_HILL_PORT ?? 8799);
  const server = createGameServer({
    host,
    port,
    log: (m) => console.log(`[orbit-hill] ${m}`),
  });

  server
    .listen()
    .then(({ host: boundHost, port: boundPort }) => {
      const lan = boundHost === '0.0.0.0' || boundHost === '::';
      console.log('');
      console.log('  ╭───────────────────────────────────────────────╮');
      console.log('  │              O R B I T   H I L L              │');
      console.log('  ╰───────────────────────────────────────────────╯');
      console.log(`  Local:  http://127.0.0.1:${boundPort}`);
      if (lan) console.log(`  LAN:    http://<tu-ip-local>:${boundPort}  (escuchando en ${boundHost})`);
      else console.log('  LAN:    desactivada (usa npm run start:lan)');
      console.log(`  Salud:  http://127.0.0.1:${boundPort}/health`);
      console.log('');
    })
    .catch((err) => {
      console.error(`No se pudo arrancar el servidor: ${err.message}`);
      process.exitCode = 1;
    });

  const shutdown = () => {
    console.log('\n[orbit-hill] cerrando…');
    server.close().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
