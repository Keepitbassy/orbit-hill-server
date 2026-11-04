// Orbit Hill — render Canvas 2D con estética arcade vectorial neón.
//
// El mundo y la colina llegan del servidor (fuente de verdad) y se guardan por
// instancia: las constantes compartidas solo se usan como respaldo inicial y
// NUNCA se mutan, así que varias partidas con arenas distintas conviven.
//
// Dos modos de cámara, independientes del input:
//   · 'overview' → toda la arena en pantalla (sin minimapa).
//   · 'follow'   → seguimiento suave con zoom y minimapa (escritorio y móvil).
//
// Capa táctica (prototipo): coberturas estáticas destruibles, naves derribadas
// con rescate y perdigones de plasma. Todo se pinta respetando el pipeline
// toroidal por tiles y se activa únicamente si la vista trae `tactical: true`.

import { WORLD, HILL, TEAM_COLORS, ASTEROID_SIZES, SHIP, powerupInfo, POWERUP } from '/shared/constants.js';
import { TACTICAL } from '/shared/tactical.js';
import { asteroidShape } from '/shared/physics.js';
import { makeStarfield } from './fx.js';
import { DEFAULT_ZOOM } from './camera-options.js';
import { hillTarget, hillTimerText } from './worldview.js';
import { dashState } from './tactical-client.js';
import {
  ZERO_INSET,
  edgePointer,
  followCamera,
  followView,
  nearestTile,
  overviewView,
  screenPoint,
  worldPoint,
  wrappedDelta,
} from './camera.js';
// Capa visual del prototipo táctico (coberturas, derribos, plasma). El perfil
// se activa SOLO con `view.tactical`: el renderer nunca lo deduce del modo.
import {
  TACTICAL_STYLE,
  WEAPON_STYLE,
  collectCovers,
  drawCovers,
  drawCross,
  drawDownedShip,
  drawPlasmaBullet,
  downedBadgeLabel,
  panelPath,
  tacticalOn,
  tacticalPlayer,
  weaponKind,
} from './tactical-render.js';
// Capa visual de la Ciudadela: pisos/plazas, weapon pads, humo con ocultación,
// retícula de apuntado y muros del minimapa. Se activa con `view.battlefield`.
import {
  battlefieldOn,
  collectSmokes,
  layoutCovers,
  layoutPads,
  layoutZones,
  drawAimReticle,
  drawFloorZones,
  drawMinimapPads,
  drawMinimapSmokes,
  drawMinimapWalls,
  drawSmokes,
  drawWeaponPads,
  hiddenBySmoke,
} from './battlefield-render.js';
// Cascos de los modelos cosméticos (catálogo de shared/ships.js): misma física,
// silueta distinta, y un solo sitio para la geometría del casco.
import { drawHullThruster, drawShipHull } from './ship-models.js';

const TAU = Math.PI * 2;
const shapeCache = new Map();

function rockShape(seed, id) {
  if (!shapeCache.has(id)) shapeCache.set(id, asteroidShape((seed + id * 977) >>> 0));
  return shapeCache.get(id);
}

function makeIdleRocks(world, count) {
  const rocks = [];
  for (let i = 0; i < count; i++) {
    rocks.push({
      id: 900 + i,
      x: Math.random() * world.w,
      y: Math.random() * world.h,
      size: Math.floor(Math.random() * 3),
      angle: Math.random() * TAU,
      spin: (Math.random() - 0.5) * 0.9,
      vx: (Math.random() - 0.5) * 40,
      vy: (Math.random() - 0.5) * 40,
    });
  }
  return rocks;
}

export class Renderer {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.dpr = 1;
    this.world = { w: opts.world?.w ?? WORLD.w, h: opts.world?.h ?? WORLD.h };
    this.hill = {
      x: HILL.x,
      y: HILL.y,
      r: HILL.radius,
      remaining: null,
      nextX: null,
      nextY: null,
      ...(opts.hill ?? {}),
    };
    this.cameraMode = opts.cameraMode ?? 'overview';
    this.zoom = opts.zoom ?? DEFAULT_ZOOM;
    this.inset = { ...ZERO_INSET };
    this.camera = null;
    this.cameraCenter = null;
    this.cameraId = null;
    this.cameraAlive = false;
    this.cameraTracking = false;
    // Última posición propia conocida: si el snapshot deja de listar la nave
    // (derribo/muerte), la cámara se queda ahí en vez de pasearse.
    this.lastSelf = null;
    this.scale = 1;
    this.offsetX = 0;
    this.offsetY = 0;
    this.viewWidth = 1;
    this.viewHeight = 1;
    this.tactical = false;
    this.covers = [];
    // Capa Ciudadela (pisos, pads, humo) y nave propia de referencia.
    this.citadel = false;
    this.zones = [];
    this.pads = [];
    this.smokes = [];
    this.selfId = null;
    this.me = null;
    // Cooldown de sala del snapshot (0 = evasión sin espera). El fallback
    // legacy es el 2,6 s del contrato.
    this.dashCooldown = TACTICAL.dash.cooldown;
    this.stars = makeStarfield(this.world, 240);
    this.idleRocks = makeIdleRocks(this.world, 12);
    this.time = 0;
    this.readInsets();
    this.resize();
  }

  /** Área segura (notch/isla dinámica) leída de las variables CSS. */
  readInsets() {
    if (typeof getComputedStyle !== 'function') return;
    try {
      const style = getComputedStyle(document.documentElement);
      const px = (name) => parseFloat(style.getPropertyValue(name)) || 0;
      this.inset = { top: px('--safe-top'), right: px('--safe-right'), bottom: px('--safe-bottom'), left: px('--safe-left') };
    } catch {
      this.inset = { ...ZERO_INSET };
    }
  }

  /**
   * Adopta el mundo/colina del servidor. Si cambia el tamaño se regeneran el
   * fondo y el estado de cámara: nunca se interpola entre mundos distintos.
   */
  setWorld(world, hill) {
    if (world && Number(world.w) > 0 && Number(world.h) > 0 &&
      (Number(world.w) !== this.world.w || Number(world.h) !== this.world.h)) {
      this.world = { w: Number(world.w), h: Number(world.h) };
      this.stars = makeStarfield(this.world, 240);
      this.idleRocks = makeIdleRocks(this.world, 12);
      this.resetCamera();
      this.resize();
    }
    if (hill) this.hill = { ...hill };
  }

  /** Copia del servidor; el renderer jamás la modifica. */
  getHill(view) {
    return view?.hill ?? this.hill;
  }

  resetCamera() {
    this.cameraCenter = null;
    this.cameraId = null;
    this.cameraAlive = false;
    this.cameraTracking = false;
    this.lastSelf = null;
  }

  setCameraMode(mode) {
    if (mode === this.cameraMode) return;
    this.cameraMode = mode;
    this.resetCamera();
    this.resize();
  }

  setZoom(zoom) {
    this.zoom = zoom;
  }

  /** Fondo animado del menú (sin partida activa). */
  drawIdleHome(dt = 0.016) {
    const { ctx } = this;
    this.time += dt;
    const cam = overviewView(this.viewWidth, this.viewHeight, this.world, { inset: this.inset });
    this.camera = cam;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#04060d';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    this.applyTile(ctx, cam, { x: 0, y: 0 }, { x: 0, y: 0 });

    this.drawBackground(ctx);
    for (const r of this.idleRocks) {
      r.x = (r.x + r.vx * dt + this.world.w) % this.world.w;
      r.y = (r.y + r.vy * dt + this.world.h) % this.world.h;
      r.angle += r.spin * dt;
    }
    this.drawAsteroids(ctx, { asteroids: this.idleRocks, seed: 7 });
    this.drawHill(ctx, { hillStatus: 'idle', hill: this.hill });
    for (const team of ['cyan', 'coral']) {
      const t = this.time * (team === 'cyan' ? 0.5 : -0.4);
      const orbit = this.world.w * (team === 'cyan' ? 0.17 : 0.23);
      const ship = {
        id: team,
        team,
        x: this.hill.x + Math.cos(t) * orbit,
        y: this.hill.y + Math.sin(t * 0.9) * (this.world.h * 0.16),
        angle: t + Math.PI / 2,
        hp: SHIP.maxHp,
        alive: true,
        protected: 0,
        name: '',
        thrusting: true,
      };
      this.drawShip(ctx, ship, false);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  resize() {
    const dpr = Math.min(2, typeof devicePixelRatio === 'number' ? devicePixelRatio : 1);
    const cssW = this.canvas.clientWidth || (typeof innerWidth === 'number' ? innerWidth : 1280);
    const cssH = this.canvas.clientHeight || (typeof innerHeight === 'number' ? innerHeight : 720);
    this.dpr = dpr;
    this.canvas.width = Math.floor(cssW * dpr);
    this.canvas.height = Math.floor(cssH * dpr);
    this.viewWidth = cssW;
    this.viewHeight = cssH;
    this.readInsets();
    this.camera = this.cameraMode === 'follow'
      ? followView(cssW, cssH, this.cameraCenter ?? { x: this.world.w / 2, y: this.world.h / 2 }, this.world, { zoom: this.zoom, inset: this.inset })
      : overviewView(cssW, cssH, this.world, { inset: this.inset });
    this.scale = this.camera.scale;
    this.offsetX = this.camera.x;
    this.offsetY = this.camera.y;
  }

  /** Pantalla (CSS px) -> coordenadas del mundo con la cámara activa. */
  toWorld(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    if (this.camera) return worldPoint(this.camera, this.world, clientX - rect.left, clientY - rect.top);
    return {
      x: (clientX - rect.left - this.offsetX) / this.scale,
      y: (clientY - rect.top - this.offsetY) / this.scale,
    };
  }

  applyTile(ctx, camera, tile, shake) {
    const dpr = this.dpr;
    ctx.setTransform(
      camera.scale * dpr,
      0,
      0,
      camera.scale * dpr,
      (camera.x + tile.x * camera.scale + shake.x) * dpr,
      (camera.y + tile.y * camera.scale + shake.y) * dpr,
    );
  }

  computeCamera(view, opts, dt) {
    const width = this.viewWidth;
    const height = this.viewHeight;
    if (this.cameraMode !== 'follow') {
      this.resetCamera();
      return overviewView(width, height, this.world, { inset: this.inset });
    }
    const center = { x: this.world.w / 2, y: this.world.h / 2 };
    const me = view?.players?.find((p) => p.id === opts.selfId) ?? null;
    // La nave derribada sigue siendo un objetivo válido: la cámara acompaña el
    // cuerpo caído (y su rescate) en vez de soltarse al perder `alive`.
    const tracking = !!me && (me.alive || me.downed === true);
    if (tracking) this.lastSelf = { x: me.x, y: me.y };
    const target = me ?? this.lastSelf ?? this.cameraCenter ?? center;
    const snap = this.cameraId !== opts.selfId || (tracking && !this.cameraTracking);
    this.cameraCenter = followCamera(this.cameraCenter, target, this.world, dt, snap);
    this.cameraId = opts.selfId;
    this.cameraAlive = !!me?.alive;
    this.cameraTracking = tracking;
    return followView(width, height, this.cameraCenter, this.world, { zoom: this.zoom, inset: this.inset });
  }

  draw(view, opts = {}) {
    const { ctx } = this;
    const dt = opts.dt ?? 0.016;
    if (opts.camera?.mode) this.cameraMode = opts.camera.mode;
    if (opts.camera?.zoom) this.zoom = opts.camera.zoom;
    this.time += dt;
    if (view?.world) this.setWorld(view.world, view.hill);
    else if (view?.hill) this.setWorld(null, view.hill);
    // Cooldown autoritativo de la sala: el dial NUNCA divide por la constante
    // legacy cuando el servidor anuncia 0; dashState sanea el campo.
    this.dashCooldown = view?.dashCooldown ?? TACTICAL.dash.cooldown;

    const camera = this.computeCamera(view, opts, dt);
    this.camera = camera;
    this.scale = camera.scale;
    this.offsetX = camera.x;
    this.offsetY = camera.y;
    const koth = (view?.mode ?? 'koth') === 'koth';
    const shake = opts.shake ?? { x: 0, y: 0 };
    // Perfil táctico y coberturas: se normalizan UNA vez por frame y se reusan
    // en todas las copias toroidales (mismo pipeline que asteroides y naves).
    this.tactical = tacticalOn(view);
    // La red manda las coberturas vivas (con su hp); si la vista no las trae,
    // el renderer reconstruye el mapa determinista y las pinta enteras.
    const coverSource = Array.isArray(view?.covers) ? view.covers : layoutCovers(view);
    this.covers = this.tactical ? collectCovers({ covers: coverSource }, TACTICAL) : [];
    // Capa Ciudadela: pisos, weapon pads y humo. El snapshot NO trae la
    // geometría del mapa (zonas y pads se derivan y se cachean una vez por
    // arena/semilla); el humo sí es estado vivo. Todo se normaliza una vez por
    // frame y se reusa en cada copia toroidal.
    this.citadel = this.tactical && battlefieldOn(view);
    this.zones = this.citadel ? layoutZones(view) : [];
    this.pads = this.citadel ? layoutPads(view) : [];
    this.smokes = this.citadel ? collectSmokes(view) : [];
    // Nave propia: referencia para la ocultación por humo (niebla visual).
    this.selfId = opts.selfId ?? null;
    this.me = view?.players?.find((p) => p.id === opts.selfId) ?? null;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#04060d';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    for (const tile of camera.tiles) {
      this.applyTile(ctx, camera, tile, shake);
      this.drawBackground(ctx);
      // Suelo de la Ciudadela: por debajo de todo (colina, muros, naves).
      if (this.zones.length) drawFloorZones(ctx, this.zones, { time: this.time, scale: camera.scale });
      if (koth) {
        this.drawHill(ctx, view);
        // Etiquetas por copia: si la colina asoma por un tile vecino, su chip y
        // su fantasma salen en la misma copia (lo que quede fuera lo recorta el canvas).
        this.drawHillLabels(ctx, view);
      }
      if (this.covers.length) drawCovers(ctx, this.covers, { time: this.time, fallback: TACTICAL });
      // Weapon pads sobre el suelo y bajo las naves (las naves pasan por encima).
      if (this.pads.length) drawWeaponPads(ctx, this.pads, { time: this.time, scale: camera.scale });
      this.drawAsteroids(ctx, view);
      this.drawPickups(ctx, view);
      this.drawBullets(ctx, view);
      this.drawShips(ctx, view, opts);
      opts.particles?.draw(ctx);
      // Humo AL FINAL: es niebla que tapa naves, etiquetas y balas de verdad.
      if (this.smokes.length) drawSmokes(ctx, this.smokes, { time: this.time, scale: camera.scale });

      // Marco del campo
      ctx.save();
      ctx.strokeStyle = 'rgba(120, 200, 255, 0.18)';
      ctx.lineWidth = 2 / camera.scale;
      ctx.strokeRect(0, 0, this.world.w, this.world.h);
      ctx.restore();
    }

    // HUD del juego en espacio de pantalla.
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const me = this.me;
    if (camera.mode === 'follow') {
      this.drawMinimap(ctx, view, me, opts);
      if (koth) this.drawHillPointer(ctx, view);
      if (this.tactical) this.drawDownedPointers(ctx, view, me);
    }
    if (view?.phase === 'countdown' && view.countdown > 0) this.drawCountdown(ctx, view);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  drawBackground(ctx) {
    // Rejilla tenue + estrellas con parpadeo (paralaje ligero).
    ctx.save();
    ctx.strokeStyle = 'rgba(63, 242, 255, 0.045)';
    ctx.lineWidth = 1;
    const step = Math.max(40, this.world.w / 15);
    const stepY = Math.max(40, this.world.h / 15);
    ctx.beginPath();
    for (let x = 0; x <= this.world.w; x += step) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, this.world.h);
    }
    for (let y = 0; y <= this.world.h; y += stepY) {
      ctx.moveTo(0, y);
      ctx.lineTo(this.world.w, y);
    }
    ctx.stroke();

    for (const s of this.stars) {
      const tw = 0.55 + 0.45 * Math.sin(this.time * 1.7 + s.tw);
      ctx.globalAlpha = 0.28 + tw * 0.5 * s.depth;
      ctx.fillStyle = s.depth > 0.7 ? '#cfe9ff' : '#7fa8d8';
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }

  drawHill(ctx, view) {
    const hill = this.getHill(view);
    const status = view.hillStatus ?? 'idle';
    const color =
      status === 'cyan' ? TEAM_COLORS.cyan : status === 'coral' ? TEAM_COLORS.coral : status === 'contested' ? '#ffd166' : '#6f86ad';
    const pulse = 1 + Math.sin(this.time * (status === 'contested' ? 7 : 2.4)) * 0.02;

    ctx.save();
    ctx.translate(hill.x, hill.y);

    // Relleno suave
    const grad = ctx.createRadialGradient(0, 0, hill.r * 0.15, 0, 0, hill.r);
    grad.addColorStop(0, hexA(color, status === 'idle' ? 0.05 : 0.16));
    grad.addColorStop(0.75, hexA(color, status === 'idle' ? 0.02 : 0.07));
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(0, 0, hill.r * pulse, 0, TAU);
    ctx.fill();

    // Anillos
    ctx.strokeStyle = hexA(color, 0.75);
    ctx.lineWidth = 2.4;
    ctx.shadowColor = color;
    ctx.shadowBlur = 18;
    ctx.beginPath();
    ctx.arc(0, 0, hill.r * pulse, 0, TAU);
    ctx.stroke();

    ctx.shadowBlur = 8;
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = hexA(color, 0.32);
    for (let i = 1; i <= 3; i++) {
      const r = (hill.r / 4) * i;
      ctx.beginPath();
      ctx.arc(0, 0, r * (i === 3 ? pulse : 1), 0, TAU);
      ctx.stroke();
    }

    // Marcas giratorias
    ctx.shadowBlur = 12;
    ctx.lineWidth = 3;
    ctx.strokeStyle = hexA(color, 0.85);
    const spin = this.time * 0.35;
    for (let i = 0; i < 4; i++) {
      const a = spin + (i * TAU) / 4;
      ctx.beginPath();
      ctx.arc(0, 0, hill.r + 10, a, a + 0.22);
      ctx.stroke();
    }
    ctx.restore();
  }

  /**
   * Temporizador de la colina sobre la propia colina y aviso de transición:
   * en los últimos 5 s se dibuja la próxima ubicación con un anillo fantasma y
   * un puente punteado por el camino corto del torus.
   * El radio visible es hill.r (unidades de mundo del servidor); HILL.radius
   * solo actúa como respaldo cuando el mensaje no lo trae.
   */
  drawHillLabels(ctx, view) {
    const hill = this.getHill(view);
    const target = hillTarget(hill);
    const warning = target.next;
    // Tamaño en unidades de mundo equivalente a ~12 px CSS a cualquier escala:
    // el chip es legible en arena completa y en zoom "Muy cerca".
    const scale = Math.max(this.scale || 1, 0.05);
    const world = this.world;
    const fontSize = 12 / scale;
    const chipW = fontSize * 11;
    const chipH = fontSize * 1.9;
    const accent = warning ? '#ffd166' : '#9fd8ff';
    const alpha = warning ? 0.55 + 0.45 * Math.abs(Math.sin(this.time * 7)) : 0.9;
    // Copia corta del destino: en el torus el salto puede cruzar el borde.
    const ghostX = hill.x + wrappedDelta(hill.x, target.x, world.w);
    const ghostY = hill.y + wrappedDelta(hill.y, target.y, world.h);

    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    if (warning) {
      ctx.setLineDash([fontSize * 0.6, fontSize * 0.5]);
      ctx.strokeStyle = hexA('#ffd166', 0.85);
      ctx.lineWidth = 2.5 / scale;
      ctx.beginPath();
      ctx.moveTo(hill.x, hill.y);
      ctx.lineTo(ghostX, ghostY);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(ghostX, ghostY, hill.r, 0, TAU);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = hexA('#ffd166', 0.06);
      ctx.beginPath();
      ctx.arc(ghostX, ghostY, hill.r, 0, TAU);
      ctx.fill();

      ctx.font = `700 ${fontSize * 0.9}px ui-monospace, Menlo, monospace`;
      ctx.fillStyle = hexA('#ffe6a8', alpha);
      ctx.fillText('PRÓXIMA COLINA', ghostX, ghostY - hill.r - fontSize);
    }

    // Chip con el nombre y el temporizador, encima de la colina actual.
    const label = hillTimerText(hill);
    const x = hill.x;
    const y = hill.y - hill.r - chipH - (warning ? fontSize * 1.6 : 0);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = 'rgba(4, 8, 18, 0.72)';
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x - chipW / 2, y - chipH / 2, chipW, chipH, chipH / 2);
    else ctx.rect(x - chipW / 2, y - chipH / 2, chipW, chipH);
    ctx.fill();
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1.5 / scale;
    ctx.stroke();
    ctx.fillStyle = accent;
    ctx.font = `700 ${fontSize}px ui-monospace, Menlo, monospace`;
    ctx.fillText(label === 'COLINA FIJA' ? 'COLINA · FIJA' : label, x, y + 1);
    ctx.restore();
  }

  /** Puntero al borde cuando la colina (o su próxima ubicación) queda fuera. */
  drawHillPointer(ctx, view) {
    const hill = this.getHill(view);
    const target = hillTarget(hill);
    const pointer = edgePointer(this.camera, this.world, target.x, target.y, 46, this.inset);
    if (!pointer.beyond) return;
    const warning = target.next;
    const color = warning ? '#ffd166' : '#3ff2ff';
    ctx.save();
    ctx.translate(pointer.x, pointer.y);
    ctx.rotate(pointer.angle);
    ctx.strokeStyle = color;
    ctx.fillStyle = hexA(color, 0.22);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(9, 0);
    ctx.lineTo(-7, -7);
    ctx.lineTo(-7, 7);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    ctx.save();
    ctx.textAlign = 'center';
    ctx.font = '700 10px ui-monospace, Menlo, monospace';
    ctx.fillStyle = warning ? '#ffe6a8' : '#b8f9ff';
    ctx.fillText(warning ? 'NUEVA COLINA' : 'COLINA', pointer.x, pointer.y + 20);
    if (hill.remaining !== null && hill.remaining !== undefined) {
      ctx.fillStyle = hexA(warning ? '#ffd166' : '#3ff2ff', 0.9);
      ctx.font = '600 9px ui-monospace, Menlo, monospace';
      ctx.fillText(hillTimerText(hill), pointer.x, pointer.y + 32);
    }
    ctx.restore();
  }

  /**
   * Minimapa. En móvil va arriba a la izquierda (nunca bajo el joystick); en
   * escritorio, abajo a la derecha, con el panel de jugadores colapsado desde
   * CSS para no taparlo. Marca la próxima colina en los últimos 5 s.
   */
  drawMinimap(ctx, view, me, opts = {}) {
    const world = this.world;
    const inset = this.inset;
    const touch = opts.chrome?.touch === true;
    const portrait = this.viewHeight >= this.viewWidth;
    const mw = Math.round(Math.max(84, Math.min(132, Math.min(this.viewWidth, this.viewHeight) * 0.34)));
    const mh = Math.round(Math.max(56, mw * (world.h / world.w)));
    const x = touch ? 12 + inset.left : Math.max(12, this.viewWidth - mw - 18 - inset.right);
    const y = touch
      ? (portrait ? 132 : 74) + inset.top
      : Math.max(12, this.viewHeight - mh - 18 - inset.bottom);

    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = 'rgba(4, 8, 18, 0.34)';
    ctx.fillRect(0, 0, mw, mh);
    ctx.strokeStyle = 'rgba(180, 220, 255, 0.35)';
    ctx.lineWidth = 1;
    ctx.strokeRect(0, 0, mw, mh);

    const sx = mw / world.w;
    const sy = mh / world.h;
    const koth = (view?.mode ?? 'koth') === 'koth';

    // Todo el interior se recorta al recuadro: nada se sale del minimapa.
    ctx.beginPath();
    ctx.rect(0, 0, mw, mh);
    ctx.clip();

    if (koth) {
      const hill = this.getHill(view);
      const target = hillTarget(hill);
      const hx = hill.x * sx;
      const hy = hill.y * sy;
      ctx.strokeStyle = '#3ff2ff';
      ctx.beginPath();
      ctx.arc(hx, hy, Math.max(3, hill.r * sx), 0, TAU);
      ctx.stroke();
      ctx.fillStyle = 'rgba(63, 242, 255, 0.14)';
      ctx.fill();
      if (target.next) {
        // Destino anunciado: punteado + flecha desde la colina actual.
        const tx = target.x * sx;
        const ty = target.y * sy;
        ctx.strokeStyle = '#ffd166';
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.arc(tx, ty, Math.max(3, hill.r * sx), 0, TAU);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(hx, hy);
        ctx.lineTo(tx, ty);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = '#ffd166';
        ctx.beginPath();
        ctx.arc(tx, ty, 2.6, 0, TAU);
        ctx.fill();
      }
    }

    // Coberturas del prototipo táctico: muros rectangulares de la Ciudadela y
    // puntos gris azulado para las placas hexagonales legacy.
    const tactical = tacticalOn(view);
    if (tactical) {
      const covers = this.covers?.length ? this.covers : collectCovers(view, TACTICAL);
      drawMinimapWalls(ctx, covers, { sx, sy, color: TACTICAL_STYLE.minimapCover });
    }
    // Weapon pads y humo: marcadores pequeños, nunca por encima de las naves.
    if (this.pads?.length) drawMinimapPads(ctx, this.pads, { sx, sy });
    if (this.smokes?.length) drawMinimapSmokes(ctx, this.smokes, { sx, sy });

    // Rectángulo de la vista (orienta en arena grande). Siempre cabe en el
    // recuadro (el seguimiento nunca muestra más que el mundo), pero puede
    // quedar descentrado: se dibuja también en las copias envolventes.
    if (this.camera && this.viewWidth > 0) {
      const vw = (this.viewWidth / this.camera.scale) * sx;
      const vh = (this.viewHeight / this.camera.scale) * sy;
      const cx = this.cameraCenter ? this.cameraCenter.x * sx : mw / 2;
      const cy = this.cameraCenter ? this.cameraCenter.y * sy : mh / 2;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.28)';
      ctx.setLineDash([2, 2]);
      for (const dx of [-mw, 0, mw]) {
        for (const dy of [-mh, 0, mh]) {
          ctx.strokeRect(cx - vw / 2 + dx, cy - vh / 2 + dy, vw, vh);
        }
      }
      ctx.setLineDash([]);
    }

    for (const player of view?.players ?? []) {
      const self = player.id === me?.id;
      // PRIMERA marca: el humo tapa al enemigo antes de cualquier indicador
      // (cruz de derribo, punto, insignia). Los aliados derribados NO se
      // ocultan: su cruz es el aviso de rescate.
      if (this.smokeHides(player, self)) continue;
      // Derribado: cruz (aliado y propia) para distinguirlo de un muerto, que
      // no se pinta.
      if (player.downed === true) {
        const color = self ? '#ffffff' : player.color ?? TEAM_COLORS[player.team] ?? '#9fc4ff';
        drawCross(ctx, player.x * sx, player.y * sy, self ? 3.4 : 2.8, hexA(color, 0.95), self ? 1.7 : 1.4);
        continue;
      }
      if (!player.alive) continue;
      ctx.fillStyle = self ? '#ffffff' : player.color ?? TEAM_COLORS[player.team] ?? '#9fc4ff';
      ctx.beginPath();
      ctx.arc(player.x * sx, player.y * sy, self ? 3 : 1.8, 0, TAU);
      ctx.fill();
    }
    ctx.restore(); // cierra el save() del minimapa (la pila queda equilibrada)
  }

  /**
   * Punteros de borde para aliados derribados fuera de pantalla: la cruz marca
   * un rescate pendiente. Solo en seguimiento y con perfil táctico real.
   */
  drawDownedPointers(ctx, view, me) {
    if (!me || (!me.alive && me.downed !== true)) return;
    let drawn = 0;
    for (const p of view?.players ?? []) {
      if (drawn >= 4) break;
      if (p.id === me.id || p.downed !== true) continue;
      if (me.team && p.team !== me.team) continue;
      // El humo tapa también el puntero de borde de un enemigo derribado; el de
      // un aliado se mantiene (es el aviso de rescate).
      if (this.smokeHides(p, false)) continue;
      const pointer = edgePointer(this.camera, this.world, p.x, p.y, 34, this.inset);
      if (!pointer.beyond) continue;
      drawn += 1;
      const color = p.color ?? TEAM_COLORS[p.team] ?? '#9fc4ff';
      ctx.save();
      ctx.globalAlpha = 0.55 + 0.35 * Math.abs(Math.sin(this.time * 4));
      drawCross(ctx, pointer.x, pointer.y, 5, hexA(color, 1), 2);
      ctx.restore();
      ctx.save();
      ctx.textAlign = 'center';
      ctx.font = '700 9px ui-monospace, Menlo, monospace';
      ctx.fillStyle = TACTICAL_STYLE.sos;
      ctx.fillText('RESCATE', pointer.x, pointer.y + 15);
      ctx.restore();
    }
  }

  drawCountdown(ctx, view) {
    const width = this.viewWidth;
    const height = this.viewHeight;
    const x = width / 2;
    const y = height / 2;
    const n = Math.ceil(view.countdown);
    const frac = view.countdown - Math.floor(view.countdown);
    ctx.save();
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(4, 8, 18, 0.3)';
    ctx.fillRect(0, 0, width, height);
    ctx.font = `700 ${Math.min(160, height * 0.3)}px ui-monospace, Menlo, monospace`;
    ctx.fillStyle = '#3ff2ff';
    ctx.shadowColor = '#3ff2ff';
    ctx.shadowBlur = 40;
    ctx.globalAlpha = 0.55 + 0.45 * (1 - frac);
    ctx.fillText(String(n), x, y + height * 0.05);
    ctx.font = '600 14px ui-monospace, Menlo, monospace';
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#d8ecff';
    ctx.fillText('PREPARADO', x, y + height * 0.13);
    ctx.restore();
  }

  drawAsteroids(ctx, view) {
    const seed = view.seed ?? 1;
    for (const a of view.asteroids ?? []) {
      const def = ASTEROID_SIZES[a.size] ?? ASTEROID_SIZES[2];
      const verts = rockShape(seed, a.id);
      const dmg = a.hp / def.hp;
      ctx.save();
      ctx.translate(a.x, a.y);
      ctx.rotate(a.angle);

      if (a.superCore) {
        ctx.fillStyle = 'rgba(255, 70, 220, 0.78)';
        ctx.strokeStyle = '#fff0ff';
        ctx.lineWidth = 3;
        ctx.shadowColor = '#ff46dc';
        ctx.shadowBlur = 28;
        ctx.beginPath();
        ctx.arc(0, 0, def.r * 0.82, 0, TAU);
        ctx.fill();
        ctx.stroke();
        ctx.shadowBlur = 0;
        ctx.fillStyle = '#ffffff';
        ctx.font = '700 12px ui-monospace, Menlo, monospace';
        ctx.textAlign = 'center';
        ctx.fillText('SUPER', 0, 4);
        ctx.restore();
        continue;
      }

      ctx.beginPath();
      for (let i = 0; i < verts.length; i++) {
        const ang = (i / verts.length) * TAU;
        const r = def.r * verts[i];
        const px = Math.cos(ang) * r;
        const py = Math.sin(ang) * r;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();

      ctx.fillStyle = `rgba(30, 48, 82, ${0.32 + 0.22 * (1 - dmg)})`;
      ctx.fill();
      const tint = dmg > 0.6 ? '#9fc4ff' : dmg > 0.3 ? '#ffd166' : '#ff8f6b';
      ctx.strokeStyle = tint;
      ctx.lineWidth = 1.8;
      ctx.shadowColor = tint;
      ctx.shadowBlur = 12;
      ctx.stroke();

      // Grietas cuando está dañado
      if (dmg < 0.85) {
        ctx.shadowBlur = 0;
        ctx.strokeStyle = `rgba(255, 209, 102, ${0.5 * (1 - dmg)})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let i = 0; i < 3; i++) {
          const ang = (i / 3) * TAU + a.id;
          ctx.moveTo(0, 0);
          ctx.lineTo(Math.cos(ang) * def.r * 0.8, Math.sin(ang) * def.r * 0.8);
        }
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  /** Powerups: icono, color y aro que se estrecha cuando van a caducar. */
  drawPickups(ctx, view) {
    for (const pu of view.pickups ?? []) {
      const info = powerupInfo(pu.type);
      const fade = pu.remaining <= POWERUP.warnSeconds;
      const pulse = 1 + Math.sin(this.time * (fade ? 9 : 3.2)) * 0.12;
      const r = POWERUP.radius * pulse;
      ctx.save();
      ctx.translate(pu.x, pu.y);
      ctx.globalAlpha = fade ? 0.55 + 0.4 * Math.abs(Math.sin(this.time * 6)) : 1;

      ctx.beginPath();
      ctx.arc(0, 0, r, 0, TAU);
      ctx.fillStyle = hexA(info.color, 0.18);
      ctx.fill();
      ctx.strokeStyle = info.color;
      ctx.shadowColor = info.color;
      ctx.shadowBlur = 16;
      ctx.lineWidth = 2;
      ctx.stroke();

      // Aro de caducidad proporcional al tiempo restante.
      const frac = Math.max(0, Math.min(1, pu.remaining / POWERUP.life));
      ctx.shadowBlur = 0;
      ctx.strokeStyle = hexA(info.color, 0.85);
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(0, 0, r + 4, -Math.PI / 2, -Math.PI / 2 + TAU * frac);
      ctx.stroke();

      ctx.fillStyle = info.color;
      ctx.font = '700 15px ui-monospace, Menlo, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(info.icon, 0, 1);
      ctx.restore();
    }
  }

  /**
   * Balas: los perdigones de plasma (índice 6 del contrato, `kind`) llevan
   * brillo naranja tenue y rastro corto; el resto conserva el trazo clásico.
   */
  drawBullets(ctx, view) {
    ctx.save();
    ctx.lineCap = 'round';
    for (const b of view.bullets ?? []) {
      if (view.mode === 'asteroids' || view.mode === 'asteroids3' || view.mode === 'stocks') {
        const pointColor = b.color ?? (b.team === 'cyan' ? TEAM_COLORS.cyan : TEAM_COLORS.coral);
        ctx.fillStyle = pointColor;
        ctx.shadowColor = pointColor;
        ctx.shadowBlur = 10;
        ctx.beginPath();
        ctx.arc(b.x, b.y, 3.2, 0, TAU);
        ctx.fill();
        continue;
      }
      if (b.kind === 'plasma') {
        drawPlasmaBullet(ctx, b, { radius: 3, trail: 11 });
        continue;
      }
      // El color sale del dueño de la bala (en ffa cada piloto tiene el suyo).
      const color = b.color ?? (b.team === 'cyan' ? TEAM_COLORS.cyan : TEAM_COLORS.coral);
      const len = 16;
      ctx.strokeStyle = color;
      ctx.shadowColor = color;
      ctx.shadowBlur = 14;
      ctx.lineWidth = 3.2;
      ctx.beginPath();
      ctx.moveTo(b.x, b.y);
      ctx.lineTo(b.x - Math.cos(b.angle) * len, b.y - Math.sin(b.angle) * len);
      ctx.stroke();
    }
    ctx.restore();
  }

  drawShips(ctx, view, opts = {}) {
    const tactical = opts.tactical ?? tacticalOn(view);
    const players = view.players ?? [];
    const me = opts.selfId === undefined ? null : players.find((p) => p.id === opts.selfId) ?? null;
    // Humo (niebla visual): un enemigo tapado por una nube no se dibuja en el
    // mundo. Aliados derribados y la nave propia NUNCA se ocultan.
    const smokes = this.smokes?.length ? this.smokes : [];
    for (const p of players) {
      // Una nave derribada sigue en pie: se dibuja aunque `alive` esté apagado.
      if (!p.alive && p.downed !== true) continue;
      const isSelf = p.id === opts.selfId;
      let helpInRange = false;
      if (tactical && !isSelf && p.downed === true && me && me.alive && me.downed !== true && me.team === p.team) {
        const reach = TACTICAL.downed.reviveRadius;
        const dx = wrappedDelta(me.x, p.x, this.world.w);
        const dy = wrappedDelta(me.y, p.y, this.world.h);
        helpInRange = dx * dx + dy * dy <= reach * reach;
      }
      const hidden = this.smokeHides(p, isSelf);
      if (hidden) continue; // oculto por humo: ni casco, ni nombre, ni minimapa
      this.drawShip(ctx, p, isSelf, { tactical, helpInRange });
    }
  }

  /**
   * ¿El humo oculta a `p` desde la nave propia? Usa la misma geometría que el
   * servidor (segmentBlocked sobre las nubes). La propia nave y los aliados
   * derribados (aviso de rescate) siempre se ven.
   */
  smokeHides(p, isSelf = false) {
    if (!this.smokes?.length || isSelf) return false;
    const me = this.me;
    if (!me || !Number.isFinite(me.x) || !Number.isFinite(me.y)) return false;
    return hiddenBySmoke(me.x, me.y, p, this.smokes, this.world, { self: isSelf, ally: me.team === p.team });
  }

  drawShip(ctx, p, isSelf, opts = {}) {
    const color = p.color ?? TEAM_COLORS[p.team] ?? '#9fc4ff';

    // Nave derribada: casco averiado, SOS, temporizador y progreso de rescate.
    if (p.downed === true) {
      const info = tacticalPlayer(p, TACTICAL);
      drawDownedShip(ctx, p, {
        time: this.time,
        radius: SHIP.radius,
        color,
        scale: this.scale,
        isSelf,
        info,
        label: downedBadgeLabel(p, isSelf),
        seconds: TACTICAL.downed.seconds,
        downedMaxHp: TACTICAL.downed.hp,
        helpInRange: opts.helpInRange === true,
      });
      return;
    }

    const protectedNow = p.protected > 0;
    const blink = protectedNow && Math.floor(this.time * 8) % 2 === 0;

    // Referencia visual de la propia nave cuando la escala es pequeña (arena
    // enorme vista completa o zoom "Lejos"): el casco no cambia de tamaño.
    if (isSelf && this.scale < 0.55) {
      ctx.save();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.72)';
      ctx.lineWidth = 1.2 / this.scale;
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(SHIP.radius + 11, 9 / this.scale), 0, TAU);
      ctx.stroke();
      ctx.restore();
    }

    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(p.angle);
    ctx.globalAlpha = protectedNow && blink ? 0.55 : 1;

    // Estela de propulsión y casco del modelo cosmético elegido:
    // misma física y mismo radio, silueta distinta.
    if (p.thrusting) {
      drawHullThruster(ctx, p.model, { color, boosting: p.boosting, radius: SHIP.radius });
    }
    drawShipHull(ctx, p.model, { color, isSelf, radius: SHIP.radius, time: this.time });

    // Marca de buffs activos sobre el casco (rápido / triple).
    if (p.rapid) {
      ctx.beginPath();
      ctx.moveTo(-SHIP.radius * 1.05, -6);
      ctx.lineTo(-SHIP.radius * 1.6, 0);
      ctx.lineTo(-SHIP.radius * 1.05, 6);
      ctx.strokeStyle = powerupInfo('rapid').color;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    if (p.spread) {
      ctx.strokeStyle = powerupInfo('spread').color;
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.moveTo(SHIP.radius + 2, -5);
      ctx.lineTo(SHIP.radius + 11, -9);
      ctx.moveTo(SHIP.radius + 2, 5);
      ctx.lineTo(SHIP.radius + 11, 9);
      ctx.stroke();
    }
    ctx.restore();

    // Halo de protección
    if (protectedNow) {
      ctx.save();
      ctx.globalAlpha = 0.42 + 0.22 * Math.sin(this.time * 9);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.6;
      ctx.setLineDash([5, 5]);
      ctx.beginPath();
      ctx.arc(p.x, p.y, SHIP.radius + 9, 0, TAU);
      ctx.stroke();
      ctx.restore();
    }

    // Escudo de powerup: burbuja sólida y giratoria.
    if (p.shield) {
      ctx.save();
      const shieldColor = powerupInfo('shield').color;
      ctx.globalAlpha = 0.75;
      ctx.strokeStyle = shieldColor;
      ctx.shadowColor = shieldColor;
      ctx.shadowBlur = 16;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(p.x, p.y, SHIP.radius + 13, this.time * 1.4, this.time * 1.4 + TAU * 0.82);
      ctx.stroke();
      ctx.globalAlpha = 0.16;
      ctx.fillStyle = shieldColor;
      ctx.beginPath();
      ctx.arc(p.x, p.y, SHIP.radius + 13, 0, TAU);
      ctx.fill();
      ctx.restore();
    }

    // Nombre + barra de vida (legibles a cualquier escala).
    const labelScale = Math.min(1, 1 / Math.max(this.scale, 0.25));
    const lift = Math.max(SHIP.radius + 16, 26 / this.scale) * (this.scale < 1 ? 1 : 1);
    ctx.save();
    ctx.font = `600 ${Math.max(11, 12 * labelScale)}px ui-monospace, Menlo, monospace`;
    ctx.textAlign = 'center';
    ctx.fillStyle = hexA(color, 0.9);
    ctx.fillText(p.name ?? '', p.x, p.y - lift);

    const w = Math.max(34, 30 * labelScale);
    const barY = p.y - lift + 5;
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(p.x - w / 2, barY, w, 3.5);
    const hpFrac = Math.max(0, Math.min(1, p.hp / SHIP.maxHp));
    ctx.fillStyle = hpFrac > 0.55 ? '#6ef7a8' : hpFrac > 0.28 ? '#ffd166' : '#ff6b5e';
    ctx.fillRect(p.x - w / 2, barY, w * hpFrac, 3.5);
    ctx.restore();

    // Insignia intermitente de reaparición (1P, 2P … / 1P · TÚ).
    if (p.badge) this.drawBadge(ctx, p, color, isSelf);

    // Indicadores propios del prototipo táctico (solo la propia nave).
    if (opts.tactical && isSelf) this.drawTacticalSelf(ctx, p);
  }

  /**
   * Dial de esquiva (recarga del dash) alrededor del casco y chip del arma
   * activa bajo la nave. Solo para la nave propia: el estado táctico real del
   * snapshot decide cuándo está lista la esquiva.
   */
  drawTacticalSelf(ctx, p) {
    const info = tacticalPlayer(p, TACTICAL);
    const dash = dashState(info, this.dashCooldown);
    const ready = dash.ready;
    const frac = dash.fraction;
    const ringR = SHIP.radius + 19;

    ctx.save();
    ctx.strokeStyle = 'rgba(150, 175, 205, 0.16)';
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    ctx.arc(p.x, p.y, ringR, 0, TAU);
    ctx.stroke();
    ctx.strokeStyle = ready ? '#7ef7c8' : 'rgba(143, 176, 208, 0.75)';
    ctx.lineWidth = 2.6;
    if (ready) {
      ctx.shadowColor = '#7ef7c8';
      ctx.shadowBlur = 10;
    }
    ctx.beginPath();
    ctx.arc(p.x, p.y, ringR, -Math.PI / 2, -Math.PI / 2 + TAU * frac);
    ctx.stroke();
    ctx.restore();

    // Retícula de apuntado (botón derecho / LT-L2): pequeña, con la carga
    // estable del disparo. Nunca cambia el zoom: se dibuja en unidades de mundo.
    // Va ANTES del corte por insignia: el apuntado no se pierde al reaparecer.
    if (info.aiming) {
      drawAimReticle(ctx, p, {
        time: this.time,
        scale: Math.max(0.08, this.scale),
        charge01: info.aimCharge,
        aimAngle: Number.isFinite(p.aimAngle) ? p.aimAngle : p.angle,
      });
    }

    if (p.badge) return; // la insignia de reaparición ya ocupa esa franja

    const kind = weaponKind(p);
    const plasma = kind === 'plasma';
    const style = WEAPON_STYLE[kind] ?? WEAPON_STYLE.auto;
    const scale = Math.max(0.08, this.scale);
    const k = Math.max(0.6, Math.min(2.6, 1 / scale));
    const fontPx = Math.max(9, 10 * Math.min(k, 1.4));
    // Munición del arma especial: el sniper y el boomer sólo se pueden pedir si
    // quedan balas, así que el contador forma parte de la lectura de estado.
    const ammo = kind === 'sniper' ? info.ammoSniper : kind === 'boomer' ? info.ammoBoomer : 0;
    const chip = kind === 'sniper' || kind === 'boomer' ? `${style.label} ${ammo}` : style.label;
    const accent = style.accent;
    const cy = p.y + Math.max(SHIP.radius + 14, 19 / scale);

    ctx.save();
    ctx.font = `700 ${fontPx}px ui-monospace, Menlo, monospace`;
    const textW = ctx.measureText(chip).width;
    const h = fontPx * 1.5;
    const dots = plasma ? 3 : kind === 'sniper' || kind === 'boomer' ? Math.min(4, ammo) : 0;
    const dotsW = dots > 0 ? dots * h * 0.34 + h * 0.36 : 0;
    const w = Math.max(30, textW + dotsW + fontPx * 1.2);
    const left = p.x - w / 2;
    ctx.globalAlpha = 0.92;
    panelPath(ctx, left, cy - h / 2, w, h, h / 2);
    ctx.fillStyle = 'rgba(4, 8, 18, 0.72)';
    ctx.fill();
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1.2;
    ctx.stroke();
    if (dots > 0) {
      ctx.fillStyle = accent;
      for (let i = 0; i < dots; i++) {
        ctx.beginPath();
        ctx.arc(left + h * 0.34 + i * h * 0.34, cy, Math.max(0.9, fontPx * 0.13), 0, TAU);
        ctx.fill();
      }
    }
    ctx.fillStyle = hexA(accent, 0.95);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(chip, left + dotsW + fontPx * 0.6 + textW / 2, cy + 0.5);
    ctx.restore();
  }

  /**
   * Indicador sobre la nave al reaparecer: número de plaza estable (1P, 2P…),
   * con "TÚ" añadido en la propia. Grande y legible al escalar la arena,
   * parpadea y se desvanece al agotarse.
   */
  drawBadge(ctx, p, color, isSelf) {
    const { label, progress } = p.badge;
    if (!label) return;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // Las etiquetas conservan un mínimo de 12 px CSS aunque la escala del mundo
    // sea pequeña (arena enorme o zoom "Lejos").
    const size = Math.max(isSelf ? 22 : 20, 12 / this.scale);
    ctx.font = `700 ${size}px ui-monospace, Menlo, monospace`;

    const w = Math.max(64, ctx.measureText(label).width + Math.max(26, 12 / this.scale));
    const h = Math.max(28, 20 / this.scale);
    const margin = Math.max(12, 3 / this.scale);
    const gap = Math.max(56, h / 2 + 12 / this.scale);
    const above = p.y - SHIP.radius - gap;
    const belowGap = Math.max(30, h / 2 + 12 / this.scale);
    const preferredY = above - h / 2 < margin ? p.y + SHIP.radius + belowGap : above;
    const x = clampRange(p.x, margin + w / 2, this.world.w - margin - w / 2);
    const y = clampRange(preferredY, margin + h / 2, this.world.h - margin - h / 2);
    const radius = Math.max(8, 5 / this.scale);
    ctx.globalAlpha = 0.45 + 0.55 * Math.abs(Math.sin(this.time * 6)) * (1 - progress * 0.7);
    ctx.fillStyle = 'rgba(4, 8, 18, 0.78)';
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x - w / 2, y - h / 2, w, h, radius);
    else ctx.rect(x - w / 2, y - h / 2, w, h);
    ctx.fill();
    ctx.strokeStyle = isSelf ? '#ffffff' : color;
    ctx.lineWidth = Math.max(isSelf ? 2.4 : 1.8, 1 / this.scale);
    ctx.stroke();

    ctx.fillStyle = isSelf ? '#ffffff' : hexA(color, 0.95);
    ctx.fillText(label, x, y + 1);
    ctx.restore();
  }

  /** Posición en pantalla de un punto del mundo con la cámara activa. */
  screenOf(x, y) {
    return screenPoint(this.camera, this.world, x, y);
  }
}

function clampRange(value, min, max) {
  if (max < min) return min;
  return Math.max(min, Math.min(max, value));
}

function hexA(hex, alpha) {
  if (hex.startsWith('rgba') || hex.startsWith('rgb')) return hex;
  const v = hex.replace('#', '');
  const bigint = parseInt(v.length === 3 ? v.split('').map((c) => c + c).join('') : v, 16);
  const r = (bigint >> 16) & 255;
  const g = (bigint >> 8) & 255;
  const b = bigint & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
