// Orbit Hill — cliente.
// Autoridad total del servidor: este archivo solo envía intenciones, interpola
// el estado autoritativo y predice localmente SU PROPIA nave para que se sienta
// fluida (la corrección se hace suave, jamás hacia atrás).

import {
  WORLD,
  HILL,
  SHIP,
  BULLET,
  TEAM_COLORS,
  TEAM_LABEL,
  SCORE_TO_WIN,
  NET,
  MODE_LABEL,
  MODE_OBJECTIVE,
  MODE_DEFAULT,
  POWERUP_TYPES,
  powerupInfo,
  ARCADE,
  FLAG,
  STOCK_OPTIONS,
  STOCKS_DEFAULT,
} from '/shared/constants.js';
import { angleDelta, clamp, wrap } from '/shared/physics.js';
import { TACTICAL } from '/shared/tactical.js';
import { SHIP_MODELS } from '/shared/ships.js';
import { BATTLEFIELDS, coverContact } from '/shared/battlefield.js';
import { sanitizeName, sanitizeRoomCode, modeInfo, listModes } from '/shared/rules.js';
import { SpawnBadges } from '/shared/indicators.js';
import { Net } from './net.js';
import { Sfx } from './audio.js';
import { Particles, Shake } from './fx.js';
import { Renderer } from './render.js';
import { Controller } from './gamepad.js';
import { GAMEPAD_PROFILES, loadGamepadProfile, saveGamepadProfile, gamepadProfile, profileControls } from './gamepad-profiles.js';
import { TouchController } from './touch.js';
import {
  ARENAS,
  CAMERA_MODE_HINT,
  CAMERA_MODE_ICON,
  CAMERA_MODE_LABEL,
  DEFAULT_HILL_SECONDS,
  HILL_SECONDS_OPTIONS,
  ZOOM_PRESETS,
  arenaDims,
  arenaText,
  cameraModeLabel,
  createRoomOptions,
  defaultCameraPrefs,
  hillSecondsLabel,
  hillSecondsText,
  loadArenaChoice,
  loadCameraPrefs,
  loadHillChoice,
  normalizeArena,
  normalizeCameraMode,
  normalizeHillSeconds,
  normalizeZoom,
  saveArenaChoice,
  saveCameraPrefs,
  saveHillChoice,
  zoomLabel,
} from './camera-options.js';
import { hillTarget, hillTimerText, sameWorld, viewConfig } from './worldview.js';
import {
  aimState,
  battlefieldChip,
  bounceState,
  cycleAvailableWeapon,
  dashState,
  downedStatusText,
  emptyTactical,
  inputWireIntent,
  nearestPad,
  nearestReviveTarget,
  padPromptText,
  parseBulletKind,
  parseTactical,
  reviveStatusText,
  sanitizeInputIntent,
  smokeRail,
  tacticalOf,
  weaponAvailable,
  weaponHudRows,
  weaponInfo,
} from './tactical-client.js';
import {
  ACTION_FIELDS,
  FLANK_KEYS,
  aimAngleFromPoint,
  battlefieldHint,
  battlefieldMeta,
  createActionLatch,
  createDashLatch,
  createInputSender,
  edgeTracker,
  flightHint,
  intentDigest,
  keyFlankAction,
  modelMeta,
  modelPreviewSvg,
  resolveFlightIntent,
  sanitizeBattlefieldChoice,
  sanitizeModelChoice,
} from './citadel-client.js';
import {
  advancePrediction,
  correctPrediction,
  interpolationFactor,
  lerpAngle,
  lerpPos,
  muzzlePoint,
  torusDistance,
} from './motion.js';

const $ = (id) => document.getElementById(id);
const TAU = Math.PI * 2;
const INTERP_DELAY = 95; // ms de colchón de interpolación (~2 snapshots)

const el = {
  screen: $('screen'),
  hud: $('hud'),
  menu: $('menu'),
  lobby: $('lobby'),
  endgame: $('endgame'),
  help: $('help'),
  scoreboard: $('scoreboard'),
  rosterPanel: $('roster-panel'),
  rosterList: $('roster-list'),
  selfPanel: $('self-panel'),
  chatBox: $('chat-box'),
  chatLog: $('chat-log'),
  chatInput: $('chat-input'),
  killFeed: $('kill-feed'),
  toast: $('toast'),
  banner: $('connection-banner'),
  nameInput: $('name-input'),
  codeInput: $('code-input'),
  menuError: $('menu-error'),
  lobbyError: $('lobby-error'),
  lobbyCode: $('lobby-code'),
  scoreCyan: $('score-cyan'),
  scoreCoral: $('score-coral'),
  barCyan: $('bar-cyan'),
  barCoral: $('bar-coral'),
  timer: $('timer'),
  hillState: $('hill-state'),
  hpBar: $('hp-bar'),
  hpNum: $('hp-num'),
  boostBar: $('boost-bar'),
  boostNum: $('boost-num'),
  weaponVital: $('weapon-vital'),
  weaponStrip: $('weapon-strip'),
  weaponSeg: $('weapon-seg'),
  chaosArmoryBtn: $('chaos-armory-btn'),
  chaosArmoryTop: $('chaos-armory-top'),
  dashVital: $('dash-vital'),
  dashBar: $('dash-bar'),
  dashNum: $('dash-num'),
  smokeVital: $('smoke-vital'),
  smokeNum: $('smoke-num'),
  bounceVital: $('bounce-vital'),
  bounceBar: $('bounce-bar'),
  bounceNum: $('bounce-num'),
  aimVital: $('aim-vital'),
  aimNum: $('aim-num'),
  padPrompt: $('pad-prompt'),
  mapChip: $('map-chip'),
  modelPicker: $('model-picker'),
  modelNote: $('model-note'),
  battlefieldSelect: $('battlefield-select'),
  battlefieldNote: $('battlefield-note'),
  padHint: $('menu-pad-hint'),
  tacStatus: $('tac-status'),
  tacHint: $('tac-hint'),
  muteBtn: $('mute-btn'),
  netStats: $('net-stats'),
  selfName: $('self-name'),
  selfTeam: $('self-team'),
  selfStats: $('self-stats'),
  roomMini: $('room-code-mini'),
  modeChip: $('mode-chip'),
  objectiveText: $('objective-text'),
  waveInfo: $('wave-info'),
  ffaBoard: $('ffa-board'),
  buffBar: $('buff-bar'),
  sbMode: $('sb-mode'),
  sbCyanLabel: $('sb-cyan-label'),
  sbCoralLabel: $('sb-coral-label'),
  scoreCyanLabel: $('score-cyan-label'),
  scoreCoralLabel: $('score-coral-label'),
  sbTeams: $('sb-teams'),
  sbFlat: $('sb-flat'),
  endMode: $('end-mode'),
  endTeams: $('end-teams'),
  endFlat: $('end-flat'),
  helpMode: $('help-mode'),
  modeButtons: $('mode-buttons'),
  modeNote: $('mode-note'),
  teamNote: $('team-note'),
  teamPicker: $('team-picker'),
  lobbyMode: $('lobby-mode'),
  lobbyObjective: $('lobby-objective'),
  lobbyRules: $('lobby-rules'),
  lobbyModes: $('lobby-modes'),
  lobbyTeamsGrid: $('lobby-teams-grid'),
  lobbyFlat: $('lobby-flat'),
  camBtn: $('cam-btn'),
  zoomSelect: $('zoom-select'),
  helpZoom: $('help-zoom'),
  cameraModes: $('camera-mode-buttons'),
  cameraNote: $('camera-note'),
  arenaSelect: $('arena-select'),
  hillCreate: $('hill-seconds-create'),
  stocksCreate: $('stocks-create'),
  lobbySettings: $('lobby-settings'),
  endSettings: $('end-settings'),
  helpSettings: $('help-settings'),
};

const renderer = new Renderer(el.screen, { world: WORLD, hill: HILL, cameraMode: 'overview' });
const sfx = new Sfx();
const particles = new Particles();
const shake = new Shake();
const net = new Net({});
const controller = new Controller();
let controllerProfileChoice = 'citadel';
const badges = new SpawnBadges();

// ────────────────────────────────── LAB CIUDADELA: flancos y ritmo de envío
// Instancias declaradas ANTES de cualquier setScreen(): `resetMatchState` y
// `releaseFlight` las usan ya en el arranque (un `const` sin inicializar aquí
// sería un ReferenceError en el primer frame, no un error de sintaxis).
//   · `inputSender`: planifica el envío del input (30 Hz, tope 60/s).
//   · `edges`: detecta flancos de humo/rebote (mantener no repite).
//   · `actions`: retiene un flanco hasta que viaja de verdad en un mensaje.
//   · `arenaEdges`: flancos de cambios de arena/mapa.
const inputSender = createInputSender({});
const edges = edgeTracker();
const actions = createActionLatch();
const dashActions = createDashLatch();
const arenaEdges = edgeTracker();
// Ratón en espacio de PANTALLA; el ángulo se calcula contra el mundo real.
const mouse = { x: 0, y: 0, inside: false, aiming: false, fire: false };

// ───────────────────────────────────── preferencias individuales de vista
// Cámara independiente de los controles: se guarda por jugador y se aplica
// EN VIVO (botón del HUD, ayuda, tecla C y selector de zoom).
const storage = (() => {
  try {
    return window.localStorage;
  } catch {
    return null; // modo privado: se juega con los valores por defecto
  }
})();
const defaultPrefs = defaultCameraPrefs(navigator, {
  coarsePointer: matchMedia('(pointer: coarse)').matches,
});
const cameraPrefs = loadCameraPrefs(storage, defaultPrefs);
renderer.setCameraMode(cameraPrefs.mode);
renderer.setZoom(cameraPrefs.zoom);
let padInput = { rot: 0 };
let padTactical = { dash: 0, interact: false };
let padStatus = '';
let touchTable = false;
let touchMode = navigator.maxTouchPoints > 0 || matchMedia('(pointer: coarse)').matches;
try { const savedTouch = localStorage.getItem('orbit-hill-touch'); if (savedTouch !== null) touchMode = savedTouch === '1'; } catch { /* private mode */ }
const touch = new TouchController({
  root: $('touch-controls'), stick: $('touch-stick'), knob: $('touch-knob'),
  buttons: { fire: $('touch-fire'), boost: $('touch-boost'), brake: $('touch-brake') },
  onGesture: () => sfx.unlock(),
});
$('touch-toggle').checked = touchMode;
function updateTouchLayout() {
  document.documentElement.classList.toggle('touch-mode', touchMode);
  document.documentElement.classList.toggle('in-game', state.screen === 'playing');
  show($('touch-controls'), touchMode && state.screen === 'playing');
  renderer.resize();
}
function flightBlocked() {
  return state.screen !== 'playing' || document.hidden || !document.hasFocus() || !net.connected ||
    !el.help.classList.contains('hidden') || !el.scoreboard.classList.contains('hidden') ||
    isTypingTarget(document.activeElement);
}

function updateTouch() {
  touch.setEnabled(touchMode && !flightBlocked());
}
$('touch-toggle').addEventListener('change', () => {
  touchMode = $('touch-toggle').checked;
  try { localStorage.setItem('orbit-hill-touch', touchMode ? '1' : '0'); } catch { /* private mode */ }
  touch.clear(); updateTouchLayout();
});
$('touch-table').addEventListener('click', () => {
  touchTable = !touchTable; touch.clear();
  if (touchTable) renderScoreboard();
  show(el.scoreboard, touchTable); updateTouch();
});
$('table-close').addEventListener('click', () => {
  touchTable = false; keys.delete('Tab'); show(el.scoreboard, false); touch.clear();
});

// ───────────────────────────────────────────────────── cámara (en vivo)
/** Cancela cualquier acción de vuelo pendiente al tocar formularios/selectores. */
function clearFlightInput() {
  releaseFlight();
  touch.clear();
  padInput = { rot: 0, thrust: false, brake: false, fire: false, boost: false };
  padTactical = { dash: 0, interact: false };
}

function setCameraMode(mode, { announce = true } = {}) {
  const next = normalizeCameraMode(mode, cameraPrefs.mode);
  if (next === cameraPrefs.mode) return;
  cameraPrefs.mode = next;
  saveCameraPrefs(storage, cameraPrefs);
  renderer.setCameraMode(next);
  if (announce) toast(`Cámara: ${CAMERA_MODE_LABEL[next]}${next === 'follow' ? ` · ${zoomLabel(cameraPrefs.zoom)}` : ''}`, 1700);
  syncCameraUi();
}

function setCameraZoom(value, { announce = true } = {}) {
  const next = normalizeZoom(value, cameraPrefs.zoom);
  if (next === cameraPrefs.zoom) return;
  cameraPrefs.zoom = next;
  saveCameraPrefs(storage, cameraPrefs);
  renderer.setZoom(next);
  if (announce) {
    const extra = cameraPrefs.mode === 'follow' ? '' : ' (se aplica en seguimiento)';
    toast(`Zoom: ${zoomLabel(next)}${extra}`, 1700);
  }
  syncCameraUi();
}

function syncCameraUi() {
  const follow = cameraPrefs.mode === 'follow';
  document.documentElement.classList.toggle('cam-follow', follow);
  el.camBtn.textContent = CAMERA_MODE_ICON[cameraPrefs.mode];
  el.camBtn.title = `Cámara: ${CAMERA_MODE_LABEL[cameraPrefs.mode]} (C)`;
  el.camBtn.setAttribute('aria-label', `Cambiar cámara (ahora ${CAMERA_MODE_LABEL[cameraPrefs.mode]})`);
  el.camBtn.classList.toggle('follow', follow);
  for (const btn of el.cameraModes.querySelectorAll('button')) {
    btn.classList.toggle('selected', btn.dataset.mode === cameraPrefs.mode);
    btn.setAttribute('aria-pressed', String(btn.dataset.mode === cameraPrefs.mode));
  }
  const zoomText = `${zoomLabel(cameraPrefs.zoom)} (${cameraPrefs.zoom}×)`;
  el.zoomSelect.value = String(cameraPrefs.zoom);
  el.helpZoom.value = String(cameraPrefs.zoom);
  el.cameraNote.textContent =
    `${CAMERA_MODE_LABEL[cameraPrefs.mode]} · zoom ${zoomText}. ${CAMERA_MODE_HINT[cameraPrefs.mode]}` +
    (follow ? ' Atajos: C alterna; el zoom se guarda para tu cuenta.' : ' El zoom elegido se guarda y se aplica en seguimiento.');
}

function buildCameraUi() {
  el.cameraModes.innerHTML = Object.keys(CAMERA_MODE_LABEL)
    .map((mode) => `<button type="button" data-mode="${mode}">${CAMERA_MODE_LABEL[mode]}</button>`)
    .join('');
  const zoomOptions = ZOOM_PRESETS
    .map((p) => `<option value="${p.value}">${p.label} · ${p.value}×</option>`)
    .join('');
  el.zoomSelect.innerHTML = zoomOptions;
  el.helpZoom.innerHTML = zoomOptions;
  el.zoomSelect.setAttribute('aria-label', 'Zoom de la cámara de seguimiento');
  el.helpZoom.setAttribute('aria-label', 'Zoom de la cámara de seguimiento');

  el.camBtn.addEventListener('click', () => setCameraMode(cameraPrefs.mode === 'follow' ? 'overview' : 'follow'));
  el.cameraModes.addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-mode]');
    if (btn) setCameraMode(btn.dataset.mode);
    clearFlightInput();
  });
  for (const select of [el.zoomSelect, el.helpZoom]) {
    select.addEventListener('change', () => {
      setCameraZoom(select.value);
      clearFlightInput();
    });
    // Al abrir el selector se suelta el vuelo: nada queda "pegado".
    select.addEventListener('pointerdown', clearFlightInput);
  }
  document.querySelectorAll('#zoom-select, #help-zoom, #arena-select, #hill-seconds-create, .ws-hill')
    .forEach((node) => node.addEventListener('pointerdown', clearFlightInput));
  syncCameraUi();
}

// ────────────────────────────────────── arena, mapa y colina (anfitrión)
const hillOptionsHtml = HILL_SECONDS_OPTIONS
  .map((s) => `<option value="${s}">${hillSecondsLabel(s)}</option>`)
  .join('');
const arenaOptionsHtml = ARENAS
  .map((a) => `<option value="${a.id}">${a.label} · ${a.w}×${a.h}</option>`)
  .join('');
// Mapa de combate: es una elección de SALA (no de settings: el contrato de
// `settings` conserva arena + colina). El servidor lo confirma aparte.
const battlefieldOptionsHtml = BATTLEFIELDS
  .map((b) => `<option value="${b.id}">${b.label}</option>`)
  .join('');

/** Bloque compacto de ajustes, idéntico en sala, pausa final y ayuda. */
function worldSettingsHtml() {
  return `<div class="world-settings">
    <label class="ws-field">MAPA
      <select class="ws-map" aria-label="Mapa de combate">${battlefieldOptionsHtml}</select>
    </label>
    <label class="ws-field">ARENA
      <select class="ws-arena" aria-label="Tamaño de la sala">${arenaOptionsHtml}</select>
    </label>
    <label class="ws-field">COLINA CADA
      <select class="ws-hill" aria-label="Cada cuánto se mueve la colina">${hillOptionsHtml}</select>
    </label>
    <label class="ws-field">STOCKS
      <select class="ws-stocks" aria-label="Vidas por piloto">${STOCK_OPTIONS.map((n) => `<option value="${n}">${n} vidas</option>`).join('')}</select>
    </label>
    <span class="ws-note"></span>
  </div>`;
}

function buildWorldSettings() {
  for (const box of [el.lobbySettings, el.endSettings, el.helpSettings]) {
    box.innerHTML = worldSettingsHtml();
    box.querySelector('.ws-map').addEventListener('change', (event) => requestBattlefield(event.target.value));
    box.querySelector('.ws-arena').addEventListener('change', (event) => requestSettings({ arena: event.target.value }));
    box.querySelector('.ws-hill').addEventListener('change', (event) => requestSettings({ hillSeconds: event.target.value }));
    box.querySelector('.ws-stocks').addEventListener('change', (event) => requestSettings({ stocks: event.target.value }));
    // Aviso explícito si se intenta tocar los ajustes en partida.
    box.querySelector('.world-settings').addEventListener('pointerdown', () => {
      if (state.phase === 'playing' || state.phase === 'countdown') {
        toast('No se puede cambiar la sala en partida: hazlo en la sala, entre rondas.', 2600);
      }
    });
    for (const select of box.querySelectorAll('select')) select.addEventListener('pointerdown', clearFlightInput);
  }
}

function canEditSettings() {
  return state.host === state.selfId && (state.phase === 'lobby' || state.phase === 'ended');
}

/**
 * El anfitrión pide cambiar arena y/o ajuste de colina entre partidas.
 * El servidor es la fuente de verdad: los demás jugadores ven el cambio en
 * cuanto llega su mensaje `settings`.
 */
let settingsPending = null;
function requestSettings(patch = {}) {
  const wanted = {
    arena: normalizeArena(patch.arena ?? state.settings.arena, state.settings.arena),
    hillSeconds: normalizeHillSeconds(patch.hillSeconds ?? state.settings.hillSeconds, state.settings.hillSeconds),
    stocks: STOCK_OPTIONS.includes(Number(patch.stocks ?? state.settings.stocks)) ? Number(patch.stocks ?? state.settings.stocks) : STOCKS_DEFAULT,
  };
  if (wanted.arena === state.settings.arena && wanted.hillSeconds === state.settings.hillSeconds && wanted.stocks === (state.settings.stocks ?? STOCKS_DEFAULT)) {
    renderWorldSettings();
    return;
  }
  if (state.phase === 'playing' || state.phase === 'countdown') {
    toast('No se puede cambiar la sala en partida: hazlo en la sala, entre rondas.', 2600);
    renderWorldSettings();
    return;
  }
  if (!canEditSettings()) {
    toast('Solo el anfitrión puede cambiar la sala.', 2400);
    renderWorldSettings();
    return;
  }
  net.send({ t: 'settings', arena: wanted.arena, hillSeconds: wanted.hillSeconds, stocks: wanted.stocks });
  toast(`Aplicando ${arenaText(wanted.arena)} · ${wanted.stocks} vidas…`, 1800);
  clearTimeout(settingsPending);
  settingsPending = setTimeout(() => {
    if (state.settings.arena !== wanted.arena || state.settings.hillSeconds !== wanted.hillSeconds || state.settings.stocks !== wanted.stocks) {
      toast('No se pudo aplicar el cambio. Inténtalo de nuevo.', 2600);
      renderWorldSettings();
    }
  }, 1800);
}

/**
 * El anfitrión pide cambiar el MAPA entre partidas. Es un mensaje propio
 * (`battlefield`): el servidor lo valida y lo difunde solo en sala/final; en
 * partida la autoridad es `tac.map` y la petición se rechaza sin efecto.
 */
let battlefieldPending = null;
function requestBattlefield(id) {
  const wanted = sanitizeBattlefieldChoice(id, state.battlefield);
  if (state.phase === 'playing' || state.phase === 'countdown') {
    toast('El mapa no se cambia en partida: hazlo en la sala, entre rondas.', 2600);
    renderWorldSettings(true);
    return;
  }
  if (!canEditSettings()) {
    toast('Solo el anfitrión puede cambiar el mapa.', 2400);
    renderWorldSettings(true);
    return;
  }
  if (wanted === state.battlefield) {
    renderWorldSettings(true);
    return;
  }
  net.send({ t: 'battlefield', battlefield: wanted });
  toast(`Mapa: ${battlefieldMeta(wanted).label}…`, 1800);
  clearTimeout(battlefieldPending);
  battlefieldPending = setTimeout(() => {
    if (state.battlefield !== wanted) {
      toast('No se pudo aplicar el mapa. Inténtalo de nuevo.', 2600);
      renderWorldSettings(true);
    }
  }, 1800);
}

let settingsSig = '';
function renderWorldSettings(force = false) {
  const editable = canEditSettings();
  const live = state.phase === 'playing' || state.phase === 'countdown';
  // Se llama en cada snapshot: solo se toca el DOM cuando algo cambió.
  const sig = `${state.settings.arena}|${state.settings.hillSeconds}|${state.settings.stocks}|${state.battlefield}|${state.phase}|${editable}`;
  if (!force && sig === settingsSig) return;
  settingsSig = sig;
  for (const box of [el.lobbySettings, el.endSettings, el.helpSettings]) {
    const map = box.querySelector('.ws-map');
    const arena = box.querySelector('.ws-arena');
    const select = box.querySelector('.ws-hill');
    const stocks = box.querySelector('.ws-stocks');
    const note = box.querySelector('.ws-note');
    if (!map || !arena || !select || !note) continue;
    if (map.value !== state.battlefield) map.value = state.battlefield;
    if (arena.value !== state.settings.arena) arena.value = state.settings.arena;
    if (select.value !== String(state.settings.hillSeconds)) select.value = String(state.settings.hillSeconds);
    if (stocks.value !== String(state.settings.stocks ?? STOCKS_DEFAULT)) stocks.value = String(state.settings.stocks ?? STOCKS_DEFAULT);
    map.disabled = !editable;
    arena.disabled = !editable;
    select.disabled = !editable;
    stocks.disabled = !editable;
    const reason = live ? 'En partida no se toca' : editable ? 'Puedes cambiarlo entre partidas' : 'Lo decide el anfitrión';
    map.title = `Mapa: ${battlefieldMeta(state.battlefield).label} · ${reason}`;
    arena.title = `${arenaText(state.settings.arena)} · ${reason}`;
    select.title = `${hillSecondsText(state.settings.hillSeconds)} · ${reason}`;
    stocks.title = `${state.settings.stocks ?? STOCKS_DEFAULT} vidas por piloto · ${reason}`;
    note.textContent = `${battlefieldMeta(state.battlefield).label} · ${arenaText(state.settings.arena)} · ${hillSecondsText(state.settings.hillSeconds)} · ${state.settings.stocks ?? STOCKS_DEFAULT} vidas`;
  }
  renderBattlefieldChoiceUi();
}

/** Selector de mapa de la portada + pista visual del mapa elegido. */
function renderBattlefieldChoiceUi() {
  if (el.battlefieldSelect && el.battlefieldSelect.value !== state.battlefieldChoice) {
    el.battlefieldSelect.value = state.battlefieldChoice;
  }
  if (el.battlefieldNote) {
    const meta = battlefieldMeta(state.battlefieldChoice);
    el.battlefieldNote.textContent = `${meta.label}: ${battlefieldHint(meta.id)}`;
  }
}

function buildCreateOptions() {
  el.arenaSelect.innerHTML = arenaOptionsHtml;
  el.hillCreate.innerHTML = hillOptionsHtml;
  el.battlefieldSelect.innerHTML = battlefieldOptionsHtml;
  el.arenaSelect.value = state.arenaChoice;
  el.hillCreate.value = String(state.hillSecondsChoice);
  el.stocksCreate.value = String(STOCKS_DEFAULT);
  el.battlefieldSelect.value = state.battlefieldChoice;
  el.arenaSelect.addEventListener('change', () => {
    state.arenaChoice = saveArenaChoice(storage, el.arenaSelect.value);
    clearFlightInput();
  });
  el.hillCreate.addEventListener('change', () => {
    state.hillSecondsChoice = saveHillChoice(storage, el.hillCreate.value);
    clearFlightInput();
  });
  el.stocksCreate.addEventListener('change', clearFlightInput);
  el.battlefieldSelect.addEventListener('change', () => {
    state.battlefieldChoice = sanitizeBattlefieldChoice(el.battlefieldSelect.value);
    saveBattlefieldChoice(state.battlefieldChoice);
    sfx.ui();
    renderBattlefieldChoiceUi();
    clearFlightInput();
  });
  renderBattlefieldChoiceUi();
}

// ─────────────────────────── selección de casco (cosmético, sin stats)
function buildModelPicker() {
  el.modelPicker.innerHTML = SHIP_MODELS
    .map((m) => `<button type="button" class="model-btn" data-model="${m.id}" aria-pressed="false">
        ${modelPreviewSvg(m.id)}
        <b>${modelMeta(m.id).label}</b>
        <small>${modelMeta(m.id).blurb}</small>
      </button>`)
    .join('');
  el.modelPicker.addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-model]');
    if (!btn) return;
    selectModel(btn.dataset.model);
    clearFlightInput();
  });
  el.modelNote.textContent = `${modelMeta(state.model).label} · mismo rendimiento en todos: solo cambia el aspecto.`;
  renderModelUi();
}

/** Cambio de casco: se envía de inmediato si ya estamos dentro de una sala. */
function selectModel(next, { announce = true } = {}) {
  const wanted = sanitizeModelChoice(next);
  if (wanted === state.model) return;
  state.model = wanted;
  saveModelChoice(wanted);
  if (announce) toast(`Casco: ${modelMeta(wanted).label}`, 1500);
  sfx.ui();
  renderModelUi();
  state.lastSentSig = '';
  state.lastActionSig = '';
}

function renderModelUi() {
  for (const btn of el.modelPicker.querySelectorAll('button[data-model]')) {
    const on = btn.dataset.model === state.model;
    btn.classList.toggle('selected', on);
    btn.setAttribute('aria-pressed', String(on));
  }
  if (el.modelNote) {
    el.modelNote.textContent = `${modelMeta(state.model).label} · mismo rendimiento en todos: solo cambia el aspecto.`;
  }
}

const state = {
  screen: 'menu',
  name: loadName(),
  preferredTeam: 'cyan',
  createMode: MODE_DEFAULT,
  mode: MODE_DEFAULT,
  modes: [],
  team: null,
  code: null,
  selfId: null,
  host: null,
  roster: new Map(),   // id -> {id,name,team,bot}
  snapA: null,
  snapB: null,
  view: null,
  latest: null,
  phase: 'lobby',
  winner: null,
  pred: null,
  predFireCd: 0,
  predBoostTimer: 0,
  predBoostCd: 0,
  lastInputSent: 0,
  lastSentSig: '',
  lastActionSig: '',
  seq: 0,
  frames: 0,
  fps: 0,
  fpsAt: performance.now(),
  reconnectAt: null,
  announcedCapture: null,
  buffs: { shield: 0, rapid: 0, spread: 0 },
  // Mundo y sala: respaldo local hasta que el servidor confirma (fuente de verdad).
  world: { w: WORLD.w, h: WORLD.h },
  settings: { arena: 'wide', hillSeconds: DEFAULT_HILL_SECONDS, stocks: STOCKS_DEFAULT },
  hill: { x: HILL.x, y: HILL.y, r: HILL.radius, remaining: null, nextX: null, nextY: null },
  hillSecondsChoice: loadHillChoice(storage, DEFAULT_HILL_SECONDS),
  arenaChoice: loadArenaChoice(storage),
  // ─── LAB CIUDADELA v0.2 ───
  battlefield: 'citadel',                       // mapa AUTORITATIVO de la partida
  battlefieldChoice: loadBattlefieldChoice(),   // elección del anfitrión (crear sala)
  model: loadModelChoice(),                     // cosmético propio (create/join/input)
  aiming: false,                                // intención de apuntado vigente
  aimAngle: 0,                                  // último ángulo apuntado (stick neutro)
  aimCharge: 0,                                 // carga de puntería estable del servidor
  mouseAim: false,                              // el ratón manda el apuntado ahora
  pad: null,                                    // último mando leído (overrides)
  hintSig: '',
  frameInput: null,                             // muestreo ÚNICO del frame
  intent: null,                                 // última intención plana enviada
  ammoSig: '',                                  // huella del HUD de armas
  requestSmoke: false,                          // petición de humo (se consume 1 vez)
  requestBounce: false,                         // petición de rebote (se consume 1 vez)
  // ─── LAB TÁCTICO (autoridad del servidor: aquí solo intención + vista) ───
  tactical: false,          // tac.on confirmado por el servidor (koth/tdm)
  tac: emptyTactical(),     // último bloque tácito parseado
  weapon: 'auto',           // selección local (absoluta) enviada al servidor
  weaponAt: 0,              // instante del último cambio (evita parpadeo)
  dashCd: 0,                // cooldown de esquiva AUTORITATIVO por jugador
  dashCooldown: TACTICAL.dash.cooldown, // cooldown de sala AUTORITATIVO (0 = sin espera)
  selfDowned: false,        // mi nave está derribada ahora mismo
  selfTac: null,            // fila táctica propia (armas, munición, rebote, humo)
  tacticalUiOn: null,       // última visibilidad tácita aplicada al DOM
  padActive: false,         // hay un mando estándar en uso (para la pista)
};

// ─────────────────────────────────────────────────────────── utilidades UI
function show(node, on = true) {
  node.classList.toggle('hidden', !on);
}

function setScreen(name) {
  state.screen = name;
  touchTable = false; touch.clear(); show(el.scoreboard, false);
  show(el.menu, name === 'menu');
  show(el.lobby, name === 'lobby');
  show(el.endgame, name === 'ended');
  show(el.hud, name === 'playing' || name === 'ended');
  show(el.rosterPanel, name !== 'menu');
  show(el.selfPanel, name === 'playing' || name === 'ended');
  show(el.chatBox, name !== 'menu');
  show(el.killFeed, name === 'playing');
  updateTouchLayout();
  renderWorldSettings();
  if (name === 'menu') {
    resetMatchState();
    el.rosterList.innerHTML = '';
  }
}

let toastTimer = null;
function toast(text, ms = 2600) {
  el.toast.textContent = text;
  show(el.toast, true);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => show(el.toast, false), ms);
}

function showError(node, text) {
  node.textContent = text;
  show(node, true);
  sfx.error();
}
function clearError(node) {
  show(node, false);
}

function loadName() {
  try {
    return localStorage.getItem('orbit-hill-name') || 'Piloto';
  } catch {
    return 'Piloto';
  }
}
function saveName(name) {
  try {
    localStorage.setItem('orbit-hill-name', name);
  } catch {
    /* modo privado */
  }
}

function playerName(id) {
  return state.roster.get(id)?.name ?? 'Piloto';
}

// ───────────────────────── LAB CIUDADELA v0.2: preferencias de partida
// El modelo es cosmético y viaja en cada input (la autoridad la tiene el
// servidor). El mapa solo lo elige quien crea la sala; el servidor decide.
function loadModelChoice() {
  try {
    return sanitizeModelChoice(localStorage.getItem('orbit-hill-model'));
  } catch {
    return sanitizeModelChoice(null);
  }
}

function saveModelChoice(id) {
  try {
    localStorage.setItem('orbit-hill-model', state.model);
  } catch {
    /* modo privado */
  }
}

function loadBattlefieldChoice() {
  try {
    return sanitizeBattlefieldChoice(localStorage.getItem('orbit-hill-battlefield'));
  } catch {
    return sanitizeBattlefieldChoice(null);
  }
}

function saveBattlefieldChoice(id) {
  try {
    localStorage.setItem('orbit-hill-battlefield', state.battlefieldChoice);
  } catch {
    /* modo privado */
  }
}

// ─────────────────────────────────── mundo y sala (fuente de verdad: servidor)
/** El mapa autoritativo durante la partida llega en `tac.map` (snapshot). */
function applySnapshotBattlefield(id) {
  if (id === undefined || id === null) return;
  const next = sanitizeBattlefieldChoice(id, state.battlefield);
  if (next === state.battlefield) return;
  state.battlefield = next;
  resetMatchState();
}

/**
 * Adopta settings/world/hill de welcome, roster, snap o settings.
 * Si cambia el tamaño del mundo o los ajustes se limpia el estado de partida:
 * nunca se interpola ni se predice entre mundos distintos.
 */
function applyServerConfig(msg, { announce = false } = {}) {
  const previous = { world: state.world, settings: state.settings };
  const cfg = viewConfig(msg, { world: state.world, settings: state.settings, hill: state.hill }, {
    world: { w: WORLD.w, h: WORLD.h },
    settings: { arena: state.settings.arena, hillSeconds: state.settings.hillSeconds, stocks: state.settings.stocks },
    hill: { x: HILL.x, y: HILL.y, radius: HILL.radius },
  });
  // Si el mensaje cambia de arena sin mandar mundo, se deduce el tamaño nuevo
  // para no quedarse dibujando la arena anterior.
  if (!msg?.world && cfg.settings.arena !== previous.settings.arena) {
    const dims = arenaDims(cfg.settings.arena);
    if (dims) cfg.world = dims;
  }

  const worldChanged = !sameWorld(previous.world, cfg.world);
  const settingsChanged = cfg.settings.arena !== previous.settings.arena ||
    cfg.settings.hillSeconds !== previous.settings.hillSeconds ||
    cfg.settings.stocks !== previous.settings.stocks;
  // El MAPA es un dato de sala aparte (nunca dentro de `settings`): el contrato
  // de settings conserva arena + colina y el servidor manda el campo aparte.
  // Si el mensaje no trae mapa se conserva el vigente (respaldo = Ciudadela).
  const field = sanitizeBattlefieldChoice(msg?.battlefield, state.battlefield);
  const battlefieldChanged = field !== state.battlefield;
  state.battlefield = field;
  state.world = cfg.world;
  state.settings = cfg.settings;
  state.hill = cfg.hill;
  renderer.setWorld(worldChanged ? cfg.world : null, cfg.hill);

  if (worldChanged || settingsChanged || battlefieldChanged) {
    resetMatchState();
    if (battlefieldChanged && announce) toast(`Mapa: ${battlefieldMeta(state.battlefield).label}`, 2400);
    else if (announce || settingsChanged) {
      toast(`Sala: ${arenaText(cfg.settings.arena)} · ${hillSecondsText(cfg.settings.hillSeconds)}`, 2400);
    }
  }
  renderWorldSettings();
}

/** Limpia interpolación, predicción, cámara y partículas (cambio de mundo o de sala). */
function resetMatchState() {
  state.snapA = null;
  state.snapB = null;
  state.pred = null;
  state.predThrusting = false;
  state.predBoostTimer = 0;
  state.predFireCd = 0;
  state.view = null;
  particles.clear();
  particles.setWorld(state.world);
  badges.clear();
  renderer.resetCamera();
  renderer.resize();
  // LAB TÁCTICO: al cambiar de mundo o de sala se apaga hasta que el servidor
  // confirme `tac.on` en el siguiente snapshot (nunca se asume habilitado).
  state.tactical = false;
  state.tac = emptyTactical();
  state.selfDowned = false;
  state.selfTac = null;
  state.dashCd = 0;
  state.dashCooldown = TACTICAL.dash.cooldown;
  state.aiming = false;
  state.aimCharge = 0;
  state.mouseAim = false;
  edges.clear();
  dashActions.clear();
  arenaEdges.clear();
  inputSender.reset();
  state.lastSentSig = '';
  state.lastActionSig = '';
  renderTacticalUi();
  tacHintSig = '';
  renderTacticalHint();
}

function hillTargetNow() {
  return hillTarget(state.hill);
}

// ───────────────────────────────────────────────────────────── modos (UI)
// El servidor puede tener un catálogo más antiguo durante una actualización
// en caliente. Mantén siempre visibles los modos que conoce este cliente,
// incluyendo Asteroids clásico y Stocks.
const modeList = () => {
  const serverModes = state.modes.length ? state.modes : [];
  const byMode = new Map(serverModes.map((entry) => [entry.mode, entry]));
  return listModes()
    .filter((entry) => entry.mode === 'koth' || entry.mode === 'chaos')
    .map((entry) => byMode.get(entry.mode) ?? entry);
};

function modeChipText(mode) {
  return (MODE_LABEL[mode] ?? mode).toUpperCase();
}

/** Botones de modo reutilizados por el menú y el lobby. */
function renderModeButtons(container, current, onPick, disabled = false) {
  container.innerHTML = '';
  for (const m of modeList()) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `mode-btn${m.mode === current ? ' selected' : ''}`;
    btn.dataset.mode = m.mode;
    btn.disabled = disabled;
    btn.innerHTML = `<b>${escapeHtml(m.label)}</b><small>${escapeHtml(m.objective)}</small>`;
    btn.addEventListener('click', () => onPick(m.mode));
    container.appendChild(btn);
  }
}

/** En el menú el modo solo se elige al crear la sala. */
function renderMenuModeUI() {
  renderModeButtons(el.modeButtons, state.createMode, (mode) => {
    state.createMode = mode;
    sfx.ui();
    renderMenuModeUI();
  });
  const info = modeInfo(state.createMode);
  el.modeNote.textContent = info.teamBased
    ? 'Modo por equipos: elige bando abajo (máx. 4 humanos por equipo).'
    : info.mode === 'arcade'
      ? 'Cooperativo 1-8 jugadores, sin bots enemigos: entrarás como aliado.'
      : 'Cada piloto juega por su cuenta: no hay equipos aliados.';
  show(el.teamPicker, info.teamBased);
  show(el.teamNote, !info.teamBased);
}

/** En el lobby solo el anfitrión puede cambiar el modo (el servidor lo valida). */
function renderLobbyModeUI(host, phase) {
  const info = modeInfo(state.mode);
  el.lobbyMode.textContent = MODE_LABEL[state.mode] ?? state.mode;
  el.lobbyObjective.textContent = MODE_OBJECTIVE[state.mode] ?? '';
  el.lobbyRules.textContent =
    state.mode === 'arcade'
      ? 'Cooperativo: todos aliados, sin bots. 5 oleadas y 12 reapariciones comunes. Entra hasta 8 personas.'
      : state.mode === 'asteroids'
        ? 'Asteroids clásico por equipos: las balas son puntos, cada impacto quita una de 3 vidas y empuja la nave. Q/E o stick derecho: barrel roll que repele balas (2,4 s).'
      : state.mode === 'asteroids3'
        ? 'Tres impactos: los dos primeros quitan un impacto y empujan; el tercero destruye la nave sin empuje. Barrel roll con cooldown de 2,4 s.'
      : state.mode === 'stocks'
        ? `Stocks: ${state.settings.stocks ?? STOCKS_DEFAULT} vidas por piloto; al agotarlas no reapareces y gana el último equipo en pie. Q/E o stick derecho: barrel roll que repele balas (2,4 s).`
      : state.mode === 'chaos'
        ? 'Caos orbital: armas especiales y powerups aparecen por toda la arena. Consigue 30 bajas; Q/E activa el barrel roll.'
      : state.mode === 'ffa'
        ? 'Todos contra todos (sin equipos aliados): 15 bajas o 6 minutos. Los huecos hasta 8 se cubren con bots.'
        : state.mode === 'tdm'
          ? 'Combate por equipos 4v4: 25 bajas o 6 minutos. Los huecos se cubren con bots reemplazables.'
          : 'Rey de la colina: 100 puntos o 6 minutos. 4 humanos por equipo, huecos con bots.';
  const editable = host && (phase === 'lobby' || phase === 'ended');
  renderModeButtons(el.lobbyModes, state.mode, (mode) => {
    if (!editable) return;
    if (mode === state.mode) return;
    net.send({ t: 'mode', mode });
    sfx.ui();
  }, !editable);
}

function renderHelpMode() {
  const info = modeInfo(state.mode);
  const rows = modeList()
    .map((m) => `<li${m.mode === info.mode ? ' class="goal"' : ''}><b>${escapeHtml(m.label)}</b>: ${escapeHtml(m.objective)}</li>`)
    .join('');
  el.helpMode.innerHTML =
    `<h3>Modos y powerups</h3><ul class="keys">${rows}</ul>` +
    '<p class="dim">Powerups: reparación (+40 vida), escudo (6 s), disparo rápido (8 s) y triple disparo (8 s). ' +
    'Caen de algunas rocas destruidas por disparos, caducan a los 18 s y se recogen acercándose.</p>';
}

// ───────────────────────────────────────────────────────────── menú / sala
function applyRoster(msg) {
  state.roster = new Map(msg.players.map((p) => [p.id, p]));
  state.host = msg.host;
  state.phase = msg.phase;
  if (msg.mode) state.mode = msg.mode;
  if (Array.isArray(msg.modes) && msg.modes.length) state.modes = msg.modes;
  if (msg.code) state.code = msg.code;
  el.lobbyCode.textContent = state.code ?? '----';
  el.roomMini.textContent = state.code ? `· ${state.code}` : '';
  // welcome/roster siempre traen settings/world/hill: se aplican tal cual.
  applyServerConfig(msg);

  const isHost = state.host === state.selfId;
  const startBtn = $('start-btn');
  startBtn.disabled = !isHost;
  $('lobby-hint').textContent = isHost
    ? 'Eres el anfitrión: cambia el modo y pulsa Iniciar cuando quieras.'
    : 'Esperando a que el anfitrión elija el modo e inicie la partida…';

  renderLobbyModeUI(isHost, msg.phase);
  renderLobbyTeams(msg);
  renderRosterPanel();
  renderScoreboard();
  renderHelpMode();
}

function renderLobbyTeams(msg) {
  const teamBased = msg.teamBased !== false;
  show(el.lobbyTeamsGrid, teamBased);
  show(el.lobbyFlat, !teamBased);
  show($('switch-cyan'), teamBased);
  show($('switch-coral'), teamBased);

  if (!teamBased) {
    el.lobbyFlat.innerHTML = msg.players
      .map((p) => flatRow(p, msg))
      .join('') || '<div class="dim">Sala vacía</div>';
    return;
  }
  for (const team of ['cyan', 'coral']) {
    const list = $(`lobby-${team}-list`);
    const count = $(`lobby-${team}-count`);
    const players = msg.players.filter((p) => p.team === team);
    count.textContent = `${players.filter((p) => !p.bot).length} humanos · ${players.length}/4`;
    list.innerHTML = '';
    for (let i = 0; i < (msg.maxPerTeam || 4); i++) {
      const p = players[i];
      const div = document.createElement('div');
      div.className = 'slot' + (p ? '' : ' empty');
      if (p) {
        const tags = [];
        if (p.id === msg.host) tags.push('<span class="tag-pill host">ANFITRIÓN</span>');
        if (p.id === state.selfId) tags.push('<span class="tag-pill me">TÚ</span>');
        if (p.bot) tags.push('<span class="tag-pill bot">BOT</span>');
        div.innerHTML = `<span class="nm">${escapeHtml(p.name)}</span><span class="tags">${tags.join('')}</span>`;
      } else {
        div.innerHTML = '<span class="nm">puesto libre</span>';
      }
      list.appendChild(div);
    }
  }
}

function flatRow(p, msg) {
  const color = p.color ?? TEAM_COLORS[p.team] ?? '#9fc4ff';
  const tags = [];
  if (p.id === msg.host) tags.push('<span class="tag-pill host">ANFITRIÓN</span>');
  if (p.id === state.selfId) tags.push('<span class="tag-pill me">TÚ</span>');
  if (p.bot) tags.push('<span class="tag-pill bot">BOT</span>');
  return `<div class="slot flat-slot">
    <span class="dot" style="background:${color}"></span>
    <span class="nm">${escapeHtml(p.name)}</span><span class="tags">${tags.join('')}</span></div>`;
}

function renderRosterPanel() {
  const snap = state.latest;
  const rows = [];
  if (snap) {
    for (const p of snap.ps) {
      const meta = state.roster.get(p[0]);
      if (!meta) continue;
      rows.push({
        ...meta,
        alive: (p[8] & 1) === 1,
        eliminated: (p[8] & FLAG.ELIMINATED) !== 0,
        kills: p[12],
        deaths: p[13],
        hp: p[7],
      });
    }
  } else {
    for (const meta of state.roster.values()) rows.push({ ...meta, alive: true, kills: 0, deaths: 0, hp: 100 });
  }
  rows.sort((a, b) => a.team.localeCompare(b.team) || b.kills - a.kills);
  el.rosterList.innerHTML = rows
    .map((r) => {
      const color = r.color ?? TEAM_COLORS[r.team] ?? '#9fc4ff';
      const state2 = r.eliminated ? 'out' : r.alive ? '' : 'dead';
      return `<div class="roster-row ${r.team} ${state2} ${r.id === state.selfId ? 'me' : ''}">
        <span class="nm"><span class="dot" style="background:${color}"></span>${escapeHtml(r.name)}${r.bot ? ' <span class="bot-tag">BOT</span>' : ''}</span>
        <span class="kd">${r.kills}/${r.deaths}</span>
      </div>`;
    })
    .join('');

  // Tabla de todos contra todos: ranking por bajas en vivo.
  const ffa = state.mode === 'ffa';
  show(el.ffaBoard, ffa);
  if (ffa) {
    el.ffaBoard.innerHTML =
      '<h4>CLASIFICACIÓN</h4>' +
      rows
        .slice()
        .sort((a, b) => b.kills - a.kills || a.deaths - b.deaths)
        .map((r, i) => {
          const color = r.color ?? '#9fc4ff';
          return `<div class="ffa-row${r.id === state.selfId ? ' me' : ''}">
            <span class="pos">${i + 1}</span><span class="dot" style="background:${color}"></span>
            <span class="nm">${escapeHtml(r.name)}</span><span class="kd">${r.kills}</span></div>`;
        })
        .join('');
  }
}

function renderScoreboard() {
  const snap = state.latest;
  const players = [...state.roster.values()];
  const mode = state.mode;
  const teamBased = mode === 'koth' || mode === 'tdm';
  const cols = scoreColumns(mode, snap);
  // Rótulos coherentes con el modo (equipos, líder/segundo o puntos y oleada).
  el.sbCyanLabel.textContent = cols[0].label;
  el.sbCoralLabel.textContent = cols[1].label;
  $('sb-cyan').textContent = cols[0].value;
  $('sb-coral').textContent = cols[1].value;
  el.sbMode.textContent = configHeader(snap);
  show(el.sbTeams, teamBased);
  show(el.sbFlat, !teamBased);

  for (const team of ['cyan', 'coral']) {
    const host = $(`sb-${team}-list`);
    host.innerHTML = players
      .filter((p) => p.team === team)
      .map((p) => {
        const ps = snap?.ps.find((x) => x[0] === p.id);
        const kd = ps ? `${ps[12]} / ${ps[13]}` : '0 / 0';
        return `<div class="sb-row ${p.id === state.selfId ? 'me' : ''}">
          <span>${escapeHtml(p.name)}${p.bot ? ' · bot' : ''}</span><span class="kd">${kd}</span></div>`;
      })
      .join('') || '<div class="dim">Sin jugadores</div>';
  }

  // Modos sin equipos: lista plana ordenada por bajas.
  const flat = players
    .map((p) => {
      const ps = snap?.ps.find((x) => x[0] === p.id);
      return { ...p, kills: ps?.[12] ?? 0, deaths: ps?.[13] ?? 0 };
    })
    .sort((a, b) => b.kills - a.kills || a.deaths - b.deaths)
    .map((p, i) => {
      const color = p.color ?? '#9fc4ff';
      return `<div class="sb-row ${p.id === state.selfId ? 'me' : ''}">
        <span><span class="pos">${i + 1}</span><span class="dot" style="background:${color}"></span>${escapeHtml(p.name)}${p.bot ? ' · bot' : ''}</span>
        <span class="kd">${p.kills} / ${p.deaths}</span></div>`;
    })
    .join('') || '<div class="dim">Sin jugadores</div>';
  el.sbFlat.innerHTML = flat;

  $('end-cyan').textContent = cols[0].value;
  $('end-coral').textContent = cols[1].value;
  $('end-cyan-list').innerHTML = $('sb-cyan-list').innerHTML;
  $('end-coral-list').innerHTML = $('sb-coral-list').innerHTML;
  el.endFlat.innerHTML = flat;
  show(el.endTeams, teamBased);
  show(el.endFlat, !teamBased);
}

/** Cabecera con el objetivo y el marcador según el modo. */
function configHeader(snap) {
  const mode = state.mode;
  if (mode === 'stocks') return `Stocks · ${snap?.settings?.stocks ?? STOCKS_DEFAULT} vidas por piloto · último equipo en pie`;
  if (mode === 'asteroids') return 'Asteroids clásico · 3 vidas por piloto · balas puntuales con retroceso';
  if (mode === 'asteroids3') return 'Asteroids · 3 impactos · los dos primeros empujan';
  if (mode === 'arcade') {
    const wave = snap?.wv ?? 0;
    const lives = snap?.lv ?? ARCADE.sharedLives;
    return `Cooperativo · oleada ${Math.max(1, wave)}/${ARCADE.wavesToWin} · ${Math.floor(snap?.sc?.[0] ?? 0)} puntos compartidos · ${lives} reapariciones`;
  }
  if (mode === 'tdm') return `Bajas por equipo: Cyan ${Math.floor(snap?.sc?.[0] ?? 0)} / Coral ${Math.floor(snap?.sc?.[1] ?? 0)} · meta 25`;
  if (mode === 'ffa') return 'Clasificación individual por bajas · meta 15';
  if (mode === 'chaos') return 'Caos orbital · líder por bajas · meta 30';
  return `Colina: Cyan ${Math.floor(snap?.sc?.[0] ?? 0)} / Coral ${Math.floor(snap?.sc?.[1] ?? 0)} · meta ${SCORE_TO_WIN}`;
}

/**
 * Rótulos y objetivos del marcador según el modo. Es la única fuente de verdad
 * para las dos columnas del HUD y de la tabla: así arcade muestra puntos
 * compartidos y oleada, ffa líder/segundo y nunca aparece "rival" donde no toca.
 */
function scoreColumns(mode, snap) {
  const sc = snap?.sc ?? [0, 0];
  const target = mode === 'tdm' ? 25 : mode === 'ffa' ? 15 : mode === 'chaos' ? 30 : SCORE_TO_WIN;
  const frac = (v, cap) => clamp(v / cap, 0, 1);

  if (mode === 'tdm') {
    return [
      { label: 'CYAN · BAJAS', value: String(Math.floor(sc[0])), frac: frac(sc[0], target) },
      { label: 'CORAL · BAJAS', value: String(Math.floor(sc[1])), frac: frac(sc[1], target) },
    ];
  }
  if (mode === 'asteroids' || mode === 'asteroids3' || mode === 'stocks') {
    return [
      { label: 'CYAN · BAJAS', value: String(Math.floor(sc[0])), frac: 0 },
      { label: 'CORAL · BAJAS', value: String(Math.floor(sc[1])), frac: 0 },
    ];
  }
  if (mode === 'ffa') {
    return [
      { label: 'LÍDER', value: String(Math.floor(sc[0])), frac: frac(sc[0], target) },
      { label: 'SEGUNDO', value: String(Math.floor(sc[1])), frac: frac(sc[1], target) },
    ];
  }
  if (mode === 'chaos') {
    return [
      { label: 'LÍDER', value: String(Math.floor(sc[0])), frac: frac(sc[0], target) },
      { label: 'SEGUNDO', value: String(Math.floor(sc[1])), frac: frac(sc[1], target) },
    ];
  }
  if (mode === 'arcade') {
    // Puntos compartidos: la barra marca el despeje de la oleada en curso y la
    // segunda columna el avance total de oleadas (no hay rival).
    const wave = Math.max(1, snap?.wv ?? 1);
    const total = Math.min(ARCADE.waveBase + (wave - 1) * ARCADE.waveGrowth, ARCADE.waveMax);
    const left = snap?.as?.length ?? 0;
    return [
      { label: 'PUNTOS', value: String(Math.floor(sc[0])), frac: frac(Math.max(0, total - left), total || 1) },
      { label: 'OLEADA', value: `${wave}/${ARCADE.wavesToWin}`, frac: frac(wave - 1, ARCADE.wavesToWin) },
    ];
  }
  return [
    { label: 'CYAN', value: String(Math.floor(sc[0])), frac: frac(sc[0], target) },
    { label: 'CORAL', value: String(Math.floor(sc[1])), frac: frac(sc[1], target) },
  ];
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function addChatLine(msg) {
  const line = document.createElement('div');
  line.className = `chat-line ${msg.team ?? 'cyan'}`;
  line.innerHTML = `<span class="who">${escapeHtml(msg.from)}:</span> ${escapeHtml(msg.text)}`;
  el.chatLog.appendChild(line);
  while (el.chatLog.children.length > 8) el.chatLog.removeChild(el.chatLog.firstChild);
}

function addKillFeed(text, team) {
  const div = document.createElement('div');
  div.className = `feed-item ${team ?? 'cyan'}`;
  div.textContent = text;
  el.killFeed.appendChild(div);
  while (el.killFeed.children.length > 5) el.killFeed.removeChild(el.killFeed.firstChild);
  setTimeout(() => div.remove(), 4200);
}

// ───────────────────────────────────────────────────────── red: mensajes
let pendingAction = null;

function whenConnected(fn) {
  if (net.connected) {
    fn();
    return;
  }
  pendingAction = fn;
  net.connect();
}

net.on('open', () => {
  show(el.banner, false);
  if (state.reconnectCode) {
    const code = state.reconnectCode;
    state.reconnectCode = null;
    net.send({ t: 'join', code, name: state.name, team: state.preferredTeam, model: state.model });
    return;
  }
  if (pendingAction) {
    const action = pendingAction;
    pendingAction = null;
    action();
  }
});

net.on('closed', ({ manual }) => {
  touch.clear(); touch.setEnabled(false);
  if (manual) return;
  show(el.banner, true);
  state.reconnectCode = state.code;
  clearTimeout(state.reconnectAt);
  state.reconnectAt = setTimeout(() => net.connect(), 2500);
});

net.on('error', (msg) => {
  if (state.screen === 'menu') showError(el.menuError, msg.message ?? 'Error');
  else if (state.screen === 'lobby') showError(el.lobbyError, msg.message ?? 'Error');
  else toast(msg.message ?? 'Error');
  if (msg.code === 'sala_no_existe' || msg.code === 'sala_llena' || msg.code === 'equipo_lleno') {
    state.reconnectCode = null;
    state.code = null;
  }
});

net.on('welcome', (msg) => {
  state.selfId = msg.id;
  state.team = msg.team;
  state.code = msg.code;
  state.host = msg.host;
  if (msg.mode) state.mode = msg.mode;
  if (Array.isArray(msg.modes) && msg.modes.length) state.modes = msg.modes;
  applyServerConfig(msg);
  clearError(el.menuError);
  sfx.unlock();
  setScreen('lobby');
  const where = msg.teamBased ? `equipo ${TEAM_LABEL[msg.team] ?? msg.team}` : TEAM_LABEL[msg.team] ?? msg.team;
  toast(`Sala ${msg.code} · ${MODE_LABEL[state.mode] ?? state.mode} · ${where} · ${battlefieldMeta(state.battlefield).label}`);
  if (state.startAfterCreate && msg.host === state.selfId) {
    state.startAfterCreate = false;
    net.send({ t: 'start' });
  }
});

net.on('settings', (msg) => {
  // El servidor solo manda `settings` cuando algo cambió: se aplica y se avisa.
  applyServerConfig(msg, { announce: true });
  clearTimeout(settingsPending);
  sfx.ui();
});

net.on('roster', (msg) => {
  applyRoster(msg);
  if (state.screen === 'menu') setScreen('lobby');
  if (msg.phase === 'lobby' && (state.screen === 'playing' || state.screen === 'ended')) setScreen('lobby');
});

net.on('chat', addChatLine);
net.on('votes', (msg) => {
  $('rematch-info').textContent = `Votos de revancha: ${msg.votes}/${msg.total}`;
});

net.on('snap', (snap) => {
  state.snapA = state.snapB;
  state.snapB = { data: snap, at: performance.now() };
  state.latest = snap;
  if (snap.gm) state.mode = snap.gm;
  // La fase se adopta antes de tocar mundo/ajustes: la UI de ajustes depende
  // de si estamos en partida o entre partidas.
  const phaseChanged = !!snap.ph && snap.ph !== state.phase;
  if (snap.ph) state.phase = snap.ph;
  // El mapa de la partida es autoridad del servidor: si cambia, se limpia todo.
  applySnapshotBattlefield(snap.tac?.map);
  // world/settings/hill iguales en todo snapshot: si cambian, se limpia el estado.
  applyServerConfig(snap);
  updateBuffs(snap);
  if (!el.scoreboard.classList.contains('hidden')) renderScoreboard();
  if (phaseChanged ||
      ((snap.ph === 'playing' || snap.ph === 'countdown') && state.screen !== 'playing') ||
      (snap.ph === 'ended' && state.screen !== 'ended')) {
    if (snap.ph === 'playing' || snap.ph === 'countdown') {
      if (state.screen !== 'playing') setScreen('playing');
    } else if (snap.ph === 'ended') {
      state.winner = snap.win;
      showEndScreen(snap);
    } else if (snap.ph === 'lobby') {
      setScreen('lobby');
      particles.clear();
    }
  }
  handleEvents(snap);
});

function updateBuffs(snap) {
  state.buffs = { shield: 0, rapid: 0, spread: 0, laser: 0, heavy: 0, homing: 0, mine: 0, barrage: 0, overdrive: 0, magnet: 0, leech: 0, jam: 0 };
  const row = (snap.bf ?? []).find((b) => b[0] === state.selfId);
  if (row) state.buffs = { shield: row[1], rapid: row[2], spread: row[3], laser: row[4] ?? 0, heavy: row[5] ?? 0, homing: row[6] ?? 0, mine: row[7] ?? 0, barrage: row[8] ?? 0, overdrive: row[9] ?? 0, magnet: row[10] ?? 0, leech: row[11] ?? 0, jam: row[12] ?? 0 };
}

function showEndScreen(snap) {
  const winner = snap.win;
  const mine = state.team;
  const mode = snap.gm ?? state.mode;
  const title = $('end-title');
  const arcade = mode === 'arcade';
  const ffa = mode === 'ffa' || mode === 'chaos';
  const mineWon = ffa ? snap.wi === state.selfId : winner === mine;

  if (arcade) {
    const win = winner === 'victory';
    title.textContent = win ? '¡Oleadas superadas!' : 'Derrota cooperativa';
    title.style.color = win ? '#6ef7a8' : '#ff6b5e';
    win ? sfx.win() : sfx.lose();
  } else if (winner === 'draw') {
    title.textContent = 'Empate';
    title.style.color = '#ffd166';
  } else if (ffa && snap.wi) {
    title.textContent = mineWon ? '¡Ganas la partida!' : `Gana ${playerName(snap.wi)}`;
    title.style.color = mineWon ? '#6ef7a8' : '#ffd166';
    mineWon ? sfx.win() : sfx.lose();
  } else if (mineWon) {
    title.textContent = '¡Victoria de tu equipo!';
    title.style.color = TEAM_COLORS[mine] ?? '#d8ecff';
    sfx.win();
  } else {
    title.textContent = `Ganó el equipo ${TEAM_LABEL[winner] ?? winner}`;
    title.style.color = TEAM_COLORS[winner] ?? '#d8ecff';
    sfx.lose();
  }

  const target = mode === 'tdm' ? 25 : mode === 'ffa' ? 15 : mode === 'chaos' ? 30 : SCORE_TO_WIN;
  $('end-sub').textContent = endSubtitle(snap, mode, target);
  el.endMode.textContent = `${MODE_LABEL[mode] ?? mode} · ${MODE_OBJECTIVE[mode] ?? ''}`;
  renderScoreboard();
  setScreen('ended');
}

function endSubtitle(snap, mode, target) {
  if (mode === 'arcade') {
    return snap.wr === 'reserva'
      ? 'Se agotaron las 12 reapariciones comunes y no quedaba ninguna nave viva.'
      : `${ARCADE.wavesToWin} oleadas completadas.`;
  }
  if (snap.wr === 'meta') return `Se alcanzó el objetivo de ${target}.`;
  if (snap.wr === 'tiempo') return 'Se agotó el tiempo de partida.';
  return '';
}

// ───────────────────────────────────────────────────── eventos -> efectos
function handleEvents(snap) {
  const evs = snap.ev ?? [];
  for (const ev of evs) {
    switch (ev.k) {
      case 'start':
        particles.clear();
        break;
      case 'go':
        sfx.tick();
        toast({ koth: '¡A la colina!', tdm: '¡A por 25 bajas!', ffa: '¡A por 15 bajas!', arcade: '¡A limpiar la oleada!' }[state.mode] ?? '¡En marcha!');
        break;
      case 'shoot':
        if (ev.team !== state.team) {
          sfx.enemyShoot();
          particles.burst(ev.x, ev.y, 3, { color: ev.team === 'cyan' ? TEAM_COLORS.cyan : TEAM_COLORS.coral, speed: 70, life: 0.18, size: 2 });
        }
        break;
      case 'hitrock':
        particles.burst(ev.x, ev.y, 5, { color: '#ffd166', speed: 140, life: 0.3, size: 2 });
        break;
      case 'hit':
        sfx.hit();
        shake.add(2.5);
        particles.burst(ev.x, ev.y, 7, { color: TEAM_COLORS[ev.team] ?? '#fff', speed: 200, life: 0.35, size: 2.4 });
        break;
      case 'shield':
        sfx.shield();
        particles.ring(ev.x, ev.y, { radius: 30, color: '#ffffff', life: 0.45, size: 2 });
        break;
      case 'boom': {
        const scale = ev.s ?? 0;
        sfx.rock(scale);
        shake.add(3 + scale * 2);
        particles.burst(ev.x, ev.y, 12 + scale * 6, { color: '#9fc4ff', speed: 170 + scale * 40, life: 0.55, size: 2.6 });
        particles.burst(ev.x, ev.y, 5, { color: '#ffd166', speed: 90, life: 0.8, size: 3 });
        particles.ring(ev.x, ev.y, { radius: 40 + scale * 26, color: '#bcd9ff', life: 0.5, size: 2 });
        break;
      }
      case 'death': {
        sfx.death();
        if (ev.id === state.selfId) shake.add(11);
        particles.burst(ev.x, ev.y, 40, { color: TEAM_COLORS[ev.team] ?? '#fff', speed: 330, life: 0.9, size: 3 });
        particles.burst(ev.x, ev.y, 14, { color: '#ffffff', speed: 150, life: 1.1, size: 4 });
        particles.ring(ev.x, ev.y, { radius: 120, color: '#ffffff', life: 0.6, size: 3 });
        const victim = playerName(ev.id);
        const killer = ev.by ? playerName(ev.by) : null;
        const kTeam = ev.by ? state.roster.get(ev.by)?.team : null;
        addKillFeed(killer ? `${killer} eliminó a ${victim}` : `${victim} chocó contra un asteroide`, kTeam ?? ev.team);
        break;
      }
      case 'respawn':
        particles.ring(ev.x, ev.y, { radius: 44, color: TEAM_COLORS[ev.team] ?? '#fff', life: 0.6, size: 2 });
        break;
      case 'pickup': {
        const info = powerupInfo(ev.pu);
        particles.ring(ev.x, ev.y, { radius: 30, color: info.color, life: 0.5, size: 2.4 });
        particles.burst(ev.x, ev.y, 8, { color: info.color, speed: 150, life: 0.5, size: 2.4 });
        sfx.ui();
        if (ev.id === state.selfId) toast(`${info.label} · ${info.short}`, 1400);
        break;
      }
      case 'hazard': {
        const info = powerupInfo(ev.pu);
        particles.ring(ev.x, ev.y, { radius: 52, color: info.color, life: 0.45, size: 3 });
        particles.burst(ev.x, ev.y, 16, { color: info.color, speed: 230, life: 0.55, size: 3 });
        if (ev.id === state.selfId) toast(`${info.label} · ¡cuidado!`, 1800);
        break;
      }
      case 'wave':
        if (ev.n > 1) toast(`Oleada ${ev.n}`, 1800);
        break;
      case 'lives':
        if (ev.n <= 3) toast(`Reapariciones restantes: ${ev.n}`, 2000);
        break;
      case 'eliminated':
        if (ev.id === state.selfId) toast('Sin reapariciones: quedas fuera', 2600);
        break;
      case 'mode':
        toast(`Modo: ${MODE_LABEL[ev.mode] ?? ev.mode}`, 2000);
        break;
      case 'hill_move':
        // La colina salta: se mueve el marcador local y se limpia el aviso.
        state.hill = { ...state.hill, x: ev.x, y: ev.y, nextX: null, nextY: null, remaining: ev.remaining ?? state.hill.remaining };
        sfx.ui();
        toast('¡La colina se ha movido!', 1900);
        particles.ring(ev.x, ev.y, { radius: 90, color: '#ffd166', life: 0.7, size: 3 });
        particles.burst(ev.x, ev.y, 18, { color: '#3ff2ff', speed: 220, life: 0.6, size: 2.6 });
        break;
      case 'capture':
        sfx.capture();
        if (state.announcedCapture !== ev.team) {
          state.announcedCapture = ev.team;
          toast(ev.team === state.team ? '¡Dominando la colina!' : `La colina es del equipo ${TEAM_LABEL[ev.team] ?? ev.team}`, 1800);
        }
        break;
      case 'win':
        if (ev.team === 'draw') toast('Empate final');
        break;
      // ── LAB TÁCTICO: eventos opcionales (sin shake extra de cámara) ──
      case 'downed':
        particles.ring(ev.x, ev.y, { radius: 46, color: TEAM_COLORS[ev.team] ?? '#ffffff', life: 0.6, size: 2 });
        particles.burst(ev.x, ev.y, 10, { color: '#ffd166', speed: 120, life: 0.5, size: 2.2 });
        if (ev.id === state.selfId) toast(`¡Derribado! ${downedStatusText({ downedRemaining: TACTICAL.downed.seconds })}`, 2600);
        else if (ev.team === state.team) addKillFeed(`${playerName(ev.id)} derribado`, ev.team);
        break;
      case 'revived':
        particles.ring(ev.x, ev.y, { radius: 54, color: '#6ef7a8', life: 0.6, size: 2.4 });
        if (ev.id === state.selfId) toast('¡Te han rescatado!', 1800);
        else if (ev.by === state.selfId) toast(`Rescataste a ${playerName(ev.id)}`, 1800);
        break;
      case 'cover_break':
        particles.burst(ev.x, ev.y, 14, { color: '#9fc4ff', speed: 170, life: 0.5, size: 2.6 });
        particles.ring(ev.x, ev.y, { radius: 40, color: '#bcd9ff', life: 0.4, size: 2 });
        break;
      case 'dash':
        if (ev.id !== state.selfId) {
          particles.burst(ev.x, ev.y, 5, { color: TEAM_COLORS[ev.team] ?? '#ffffff', speed: 120, life: 0.3, size: 2 });
        }
        break;
      case 'armory':
        if (ev.id === state.selfId) toast(`Arma de prueba: ${(ev.weapon ?? '').toUpperCase()}`, 1400);
        break;
      case 'barrel':
        particles.ring(ev.x, ev.y, { radius: 30, color: TEAM_COLORS[ev.team] ?? '#ffffff', life: 0.28, size: 2.4 });
        particles.burst(ev.x, ev.y, 8, { color: '#ffd166', speed: 150, life: 0.28, size: 2 });
        break;
      // ── LAB CIUDADELA v0.2: explosiones, humo, armas de mapa y rebotes ──
      case 'blast': {
        // Explosión (lanzador explosivo): sin fuego amigo, con auto-daño.
        sfx.blast();
        const radius = Math.max(40, Number(ev.r ?? ev.w ?? 135));
        if (ev.team === state.team || ev.id === state.selfId) shake.add(2.5);
        particles.burst(ev.x, ev.y, 16, { color: '#ff9f43', speed: 240, life: 0.5, size: 3 });
        particles.ring(ev.x, ev.y, { radius, color: '#ffd166', life: 0.45, size: 2.6 });
        break;
      }
      case 'smoke': {
        sfx.smoke();
        const radius = Math.max(20, Number(ev.r ?? ev.w ?? 145));
        particles.burst(ev.x, ev.y, 10, { color: '#c9d6e6', speed: 90, life: 0.8, size: 4 });
        particles.ring(ev.x, ev.y, { radius: radius * 0.6, color: '#9fb3c8', life: 0.6, size: 3 });
        if (ev.id === state.selfId) toast('Humo desplegado · 6 s', 1600);
        break;
      }
      case 'bounce':
        sfx.bounce();
        particles.burst(ev.x, ev.y, 5, { color: '#bcd9ff', speed: 110, life: 0.25, size: 2 });
        break;
      case 'weapon_pickup': {
        const info = weaponInfo(ev.w ?? ev.weapon ?? 'sniper');
        particles.ring(ev.x, ev.y, { radius: 34, color: '#7fe9ff', life: 0.5, size: 2.4 });
        particles.burst(ev.x, ev.y, 8, { color: '#7fe9ff', speed: 140, life: 0.45, size: 2.4 });
        sfx.ui();
        if (ev.id === state.selfId) toast(`${info.short} recogido · ${info.label}`, 2000);
        break;
      }
      default:
        break;
    }
    if (ev.k !== 'capture') state.announcedCapture = null;
  }
}

// ───────────────────────────────────────────────────────────── input
const keys = new Set();
// El teclado vive en un Set de códigos: la resolución de intenciones
// (teclado/ratón/mando/táctil) está en `resolveFlightIntent` (módulo puro).

function isTypingTarget(target) {
  // SELECT incluido: con el selector enfocado, flechas/espacio eligen opciones
  // y NO pilotan la nave (además flightBlocked() deja el vuelo en neutral).
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement ||
    (typeof HTMLSelectElement !== 'undefined' && target instanceof HTMLSelectElement) ||
    target?.isContentEditable === true;
}

window.addEventListener('keydown', (e) => {
  const typing = isTypingTarget(e.target);
  const playing = state.screen === 'playing';
  if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code) && !typing) e.preventDefault();

  if (e.code === 'Tab') {
    // El scoreboard solo se abre jugando y sin un formulario enfocado; en menús
    // y formularios, Tab navega con normalidad.
    if (typing || !playing || !el.help.classList.contains('hidden')) return;
    e.preventDefault();
    keys.add('Tab');
    show(el.scoreboard, true);
    return;
  }
  if (e.key === 'm' || e.key === 'M') {
    if (!typing) toggleMute();
    return;
  }
  if (e.key === 'h' || e.key === 'H') {
    if (!typing) show(el.help, el.help.classList.contains('hidden'));
    return;
  }
  if (e.key === 'c' || e.key === 'C') {
    // Cámara: arena completa ⇄ seguimiento con zoom (en vivo, sin salir).
    if (!typing) {
      setCameraMode(cameraPrefs.mode === 'follow' ? 'overview' : 'follow');
      clearFlightInput();
    }
    return;
  }
  if (e.key === 'Escape') {
    if (!el.help.classList.contains('hidden')) show(el.help, false);
    if (typing) e.target.blur();
    return;
  }
  if (typing) {
    if (e.key === 'Enter' && e.target === el.chatInput) {
      const text = el.chatInput.value.trim();
      if (text) net.send({ t: 'chat', text });
      el.chatInput.value = '';
      el.chatInput.blur();
    }
    return;
  }
  if (e.key === 't' || e.key === 'T' || e.key === 'Enter') {
    el.chatInput.focus();
    return;
  }
  if (e.key === 'r' || e.key === 'R') {
    if (state.mode === 'chaos' && state.screen === 'playing') {
      net.send({ t: 'chaos_armory' });
      toast('Siguiente arma de prueba', 1200);
    }
    return;
  }
  // Armas: 1/2 base (munición ilimitada) y 3/4 especiales recogidas en el mapa.
  // Sin munición NO se pide el arma (nada de intenciones basura).
  if (e.code === 'Digit1' || e.code === 'Numpad1') {
    if (state.tactical) selectWeapon('auto');
    return;
  }
  if (e.code === 'Digit2' || e.code === 'Numpad2') {
    if (state.tactical) selectWeapon('plasma');
    return;
  }
  if (e.code === 'Digit3' || e.code === 'Numpad3') {
    if (state.tactical) selectWeapon('sniper');
    return;
  }
  if (e.code === 'Digit4' || e.code === 'Numpad4') {
    if (state.tactical) selectWeapon('boomer');
    return;
  }
  // Flancos de teclado: humo (G) y rebote en pared (Alt). El auto-repeat del
  // sistema se ignora, así que mantener la tecla NO repite la acción.
  const flank = keyFlankAction(e.code, { repeat: e.repeat });
  if (flank !== null || FLANK_KEYS[e.code]) {
    if (flank === 'smoke' && state.tactical) requestSmoke();
    if (flank === 'bounce' && state.tactical) requestBounce();
    return;
  }
  if (e.key === 'Shift') {
    sfx.unlock();
  }
  keys.add(e.code);
  sfx.unlock();
});

window.addEventListener('keyup', (e) => {
  if (e.code === 'Tab') {
    keys.delete('Tab');
    show(el.scoreboard, false);
    return;
  }
  keys.delete(e.code);
});

// ───────────────────────────────────────────────── ratón (PC): apuntar/disparar
// El apuntado del ratón se mide contra el mundo real del servidor: la posición
// de pantalla se convierte con la cámara activa y luego se calcula el ángulo
// por el camino corto del toro (nunca "por la derecha" cruzando el borde).
function mouseAngleNow() {
  const me = state.view?.players?.find((p) => p.id === state.selfId) ?? state.pred;
  if (!me) return state.aimAngle;
  const toWorld = renderer.toWorld?.bind(renderer);
  if (typeof toWorld !== 'function') return state.aimAngle;
  const point = toWorld(mouse.x, mouse.y);
  return aimAngleFromPoint(me, point, state.world);
}

if (el.screen) {
  el.screen.addEventListener('mousemove', (event) => {
    mouse.x = event.clientX;
    mouse.y = event.clientY;
    mouse.inside = true;
    if (mouse.aiming) state.aimAngle = mouseAngleNow();
  });
  el.screen.addEventListener('mouseleave', () => {
    mouse.inside = false;
    mouse.aiming = false;
    mouse.fire = false;
  });
  el.screen.addEventListener('mousedown', (event) => {
    if (flightBlocked()) return;
    if (event.button === 2) {
      mouse.aiming = true;
      state.aimAngle = mouseAngleNow();
    }
    if (event.button === 0) mouse.fire = true;
  });
  // El menú contextual se cancela SOLO sobre el campo de juego.
  el.screen.addEventListener('contextmenu', (event) => event.preventDefault());
}
window.addEventListener('mouseup', (event) => {
  if (event.button === 2) mouse.aiming = false;
  if (event.button === 0) mouse.fire = false;
});

/** Suelta cualquier acción de vuelo sin perder arma ni casco elegidos. */
function releaseFlight() {
  keys.clear(); touch.clear();
  padInput = { rot: 0 };
  padTactical = { dash: 0, interact: false };
  mouse.aiming = false;
  mouse.fire = false;
  edges.clear();
  dashActions.clear();
  arenaEdges.clear();
  state.aiming = false;
  state.mouseAim = false;
  inputSender.reset();
  state.lastSentSig = '';
  state.lastActionSig = '';
  // Los flancos retenidos se CANCELAN al soltar el vuelo (blur, menú, chat,
  // ayuda): abrir un menú no debe lanzar el humo o el rebote que quedó
  // pendiente. El mensaje de suelta va NEUTRO para que el servidor suelte
  // cualquier intención anterior (incluida la de apuntar).
  actions.clear();
  dashActions.clear();
  if (state.screen === 'playing' || state.screen === 'ended') {
    const wire = {
      rot: 0, thrust: false, brake: false, fire: false, boost: false,
      weapon: state.tactical ? state.weapon : 'auto',
      dash: 0, dashId: 0, interact: false,
      aim: false, aimAngle: state.aimAngle, moveX: 0, moveY: 0,
      smoke: false, bounce: false,
      model: state.model,
    };
    net.send(inputWireIntent(wire, ++state.seq));
  }
}
window.addEventListener('blur', releaseFlight);
document.addEventListener('visibilitychange', releaseFlight);
window.addEventListener('orientationchange', releaseFlight);

window.addEventListener('wheel', (event) => {
  if (flightBlocked() || !state.tactical) return;
  // La rueda cicla armas DISPONIBLES (nunca una especial sin munición).
  cycleWeaponAmmo(event.deltaY > 0 ? 1 : -1);
});

/** Vector de desplazamiento lateral (apuntando) desde WASD/cursores o stick. */
function keyDash() {
  return (keys.has('KeyE') ? 1 : 0) + (keys.has('KeyQ') ? -1 : 0);
}

/**
 * Muestreo ÚNICO por frame: se consume el estado de teclado/ratón/mando y los
 * flancos pendientes una sola vez, y el resultado se reusa en la vista, la
 * predicción y el envío. Así ningún flanco se consume dos veces ni se pierde.
 */
function currentInput() {
  if (flightBlocked()) {
    state.aiming = false;
    return sanitizeInputIntent({ weapon: state.tactical ? state.weapon : 'auto', model: state.model });
  }
  const fingers = touch.read();
  const downed = state.tactical && state.selfDowned;
  const pad = state.pad;
  if (pad?.assteroids?.flight === 'omni-aim' && !Number.isFinite(pad.assteroids.aimAngle) && !mouse.aiming) {
    const heading = state.pred?.angle ?? state.view?.players?.find(p => p.id === state.selfId)?.angle;
    if (Number.isFinite(heading)) state.aimAngle = heading;
  }
  // La mira del ratón se recalcula en CADA muestreo (una vez por frame): si la
  // nave o la cámara se mueven con el cursor quieto, el ángulo contra el mundo
  // cambia igualmente. Antes solo se actualizaba con mousemove/mousedown.
  if (mouse.inside && mouse.aiming && !downed) {
    const nextAngle = mouseAngleNow();
    if (Number.isFinite(nextAngle)) state.aimAngle = nextAngle;
  }
  const smokeSrc = !downed && (pad?.v2?.smoke === true || state.requestSmoke === true);
  const bounceSrc = !downed && (pad?.v2?.bounce === true || state.requestBounce === true);
  state.requestSmoke = false;
  state.requestBounce = false;
  const smoke = edges.edge('smoke', smokeSrc);
  const bounce = edges.edge('bounce', bounceSrc);
  const resolved = resolveFlightIntent({
    keys,
    pad,
    mouse: { inside: mouse.inside, aiming: mouse.aiming && !downed, fire: mouse.fire, angle: state.aimAngle },
    touch: { ...fingers, interact: false },
    tacticalProfile: state.tactical,
    aiming: state.aiming,
    lastAimAngle: state.aimAngle,
    shipAngle: state.pred?.angle ?? state.view?.players?.find(p => p.id === state.selfId)?.angle ?? state.aimAngle,
    model: state.model,
    weapon: state.weapon,
    smoke,
    bounce,
    dashKeys: downed ? 0 : keyDash(),
    downed,
  });
  state.aiming = resolved.aiming;
  state.mouseAim = resolved.aimSource === 'mouse';
  if (resolved.aiming || resolved.intent.flight === 'omni-aim') state.aimAngle = resolved.aimAngle;
  // Flancos retenidos: si el frame no puede enviar (ritmo/presupuesto), el
  // flanco sigue pendiente hasta viajar en un mensaje real.
  if (resolved.intent.smoke) actions.request('smoke');
  if (resolved.intent.bounce) actions.request('bounce');
  const intent = { ...resolved.intent };
  intent.smoke = actions.value('smoke');
  intent.bounce = actions.value('bounce');
  if (downed) dashActions.clear();
  return sanitizeInputIntent(dashActions.sample(intent, pad?.assteroids?.dashReleased === true));
}

/**
 * Envío del input: los flancos de acción salen de inmediato y el apuntado
 * continuo se limita al ritmo del contrato (30 Hz), sin superar nunca el
 * presupuesto de 60 mensajes/s. La mira local no espera a nadie.
 */
function sendInput(now, input) {
  const wire = { ...input, weapon: state.tactical ? state.weapon : 'auto', model: state.model };
  state.intent = wire;
  const digest = intentDigest(wire);
  const actionDigest = intentDigest(wire, ACTION_FIELDS) + `|dashId:${wire.dashId ?? ''}`;
  const instant = actionDigest !== state.lastActionSig;
  const changed = digest !== state.lastSentSig;
  if (!inputSender.due(now, { instant, changed })) return;
  // El socket cerrado NO cuenta como envío: ni se marcan las huellas como
  // enviadas ni se sueltan los flancos retenidos (se reintentan al reconectar).
  if (!net.send(inputWireIntent(wire, ++state.seq))) return;
  state.lastSentSig = digest;
  state.lastActionSig = actionDigest;
  // El flanco solo se suelta cuando REALMENTE ha viajado en este mensaje.
  actions.commitWire(wire);
  dashActions.commitWire(wire);
}

function updateController(now) {
  const pad = controller.poll(now);
  state.pad = pad;
  state.padActive = !!(pad.connected && pad.supported);
  const status = !window.isSecureContext || !navigator.getGamepads
    ? 'Mandos: abre localhost o HTTPS para habilitarlos.'
    : !pad.connected ? 'Mando: conecta por USB/Bluetooth y pulsa un botón.'
    : !pad.supported ? 'Mando sin mapa estándar: prueba otro navegador o usa teclado.'
    : `${pad.family} conectado · ${gamepadProfile(controllerProfileChoice).label}`;
  if (status !== padStatus) {
    padStatus = status;
    for (const node of document.querySelectorAll('.controller-status')) node.textContent = status;
    $('controller-live').textContent = pad.connected && pad.supported ? `${pad.family} · ${gamepadProfile(controllerProfileChoice).label}` : 'Teclado';
    if (el.padHint) {
      el.padHint.textContent = pad.connected && pad.supported
        ? `${pad.family} · ${gamepadProfile(controllerProfileChoice).label}`
        : 'Conecta tu mando y elige el perfil de movimiento que prefieras.';
    }
  }
  padInput = { rot: 0 };
  padTactical = { dash: 0, interact: false };
  if (!document.hasFocus() || document.hidden || !pad.supported) {
    controller.suppressGameplay();
    show(el.scoreboard, state.screen === 'playing' && el.help.classList.contains('hidden') && (touchTable || keys.has('Tab')));
    return;
  }
  const typing = isTypingTarget(document.activeElement);
  const helpOpen = !el.help.classList.contains('hidden');
  if (pad.pressed.menu) {
    if (state.screen === 'lobby' && !helpOpen && !$('start-btn').disabled) $('start-btn').click();
    else if (state.screen === 'playing' || helpOpen) show(el.help, !helpOpen);
  }
  if (pad.pressed.back && helpOpen) show(el.help, false);
  const overlay = !el.help.classList.contains('hidden') ? el.help :
    state.screen === 'menu' ? el.menu : state.screen === 'lobby' ? el.lobby :
    state.screen === 'ended' ? el.endgame : null;
  show(el.scoreboard, !overlay && (touchTable || pad.buttons.scoreboard || keys.has('Tab')));
  if (overlay) {
    controller.suppressGameplay();
    // En menús ✕/A confirma y NUNCA dispara ni rebota.
    const buttons = [...overlay.querySelectorAll('button')].filter(b => !b.disabled && b.getClientRects().length);
    if (pad.move && buttons.length) {
      const index = buttons.indexOf(document.activeElement);
      buttons[(index < 0 ? 0 : (index + pad.move + buttons.length) % buttons.length)].focus();
    }
    if (pad.pressed.confirm) {
      sfx.unlock();
      const focused = buttons.includes(document.activeElement) ? document.activeElement :
        overlay.querySelector('button.primary:not(:disabled)');
      focused?.click();
    }
    return;
  }
  if (typing) controller.suppressGameplay();
  if (!typing && state.screen === 'playing') {
    // Override de la v0.2: en modo táctico LT apunta (no frena) y ✕/A rebota
    // (no dispara). R1/RB dispara siempre y RT dispara mientras se apunta.
    if (state.tactical && !state.selfDowned) {
      padInput = {
        ...pad.input,
        brake: false,
        fire: !!pad.v2?.fire || (!!pad.v2?.aim && !!pad.v2?.thrust),
      };
    } else {
      padInput = pad.input;
    }
    padTactical = {
      dash: pad.tactical?.dash ?? 0,
      interact: !!pad.tactical?.interact,
    };
    // □/X cicla SOLO armas disponibles (las especiales exigen munición).
    if (state.tactical && pad.pressed.weapon) cycleWeaponAmmo(1);
    if (state.tactical && pad.assteroids) {
      if (pad.pressed.selectAuto) selectWeapon('auto');
      if (pad.pressed.selectSniper || pad.pressed.sniper) selectWeapon('sniper');
      if (pad.pressed.selectBoomer) selectWeapon('boomer');
    }
    if (state.tactical && pad.pressed.smoke && !state.selfDowned) requestSmoke();
    if (state.tactical && pad.pressed.bounce && !state.selfDowned) requestBounce();
    if (padInput.fire || padInput.thrust || padInput.boost) sfx.unlock();
  }
}

function toggleMute() {
  const muted = sfx.toggle();
  el.muteBtn.textContent = muted ? '🔇' : '🔊';
  toast(muted ? 'Sonido silenciado' : 'Sonido activado', 1200);
  if (!muted) sfx.ui();
}

// ───────────────────────────────────────────────── LAB CIUDADELA (armas y flancos)
/** Selección ABSOLUTA de arma (1/2/3/4, □/X cicla, rueda del ratón). */
function selectWeapon(next, { announce = true } = {}) {
  const wanted = sanitizeInputIntent({ weapon: next }).weapon;
  // Las especiales solo se equipan con munición de pad recogida (autoridad del
  // servidor: si el servidor no la reconoce, la vista vuelve a `auto`).
  if (state.tactical && !weaponAvailable(state.selfTac, wanted) && wanted !== state.weapon) {
    toast(`${weaponInfo(wanted).short} sin munición · se recoge en el mapa`, 2200);
    return;
  }
  if (wanted === state.weapon) return;
  state.weapon = wanted;
  state.weaponAt = performance.now();
  if (announce) {
    const info = weaponInfo(wanted);
    toast(`${info.short} · ${info.label}`, 1600);
  }
  sfx.ui();
  renderWeaponUi();
}

/** Cicla armas DISPONIBLES (nunca deja el arma en una especial vacía). */
function cycleWeaponAmmo(direction = 1) {
  const next = cycleAvailableWeapon(state.weapon, state.selfTac);
  if (next === state.weapon) {
    if (!weaponAvailable(state.selfTac, 'auto')) return;
    toast('Sin cambios: no hay más armas con munición', 1600);
    return;
  }
  selectWeapon(next, { announce: true });
  void direction;
}

/** Humo: solo se pide por flanco y con cargas (la nube la decide el servidor). */
function requestSmoke() {
  if (state.selfDowned) return;
  const charges = state.selfTac?.smokeAmmo ?? 0;
  if (!state.tactical || charges <= 0) {
    toast('Sin humo · 2 cargas por vida', 1600);
    return;
  }
  state.requestSmoke = true;
}

/** Rebote en pared: flanco, con cooldown autoritativo del servidor. */
function requestBounce() {
  if (state.selfDowned) return;
  if (!state.tactical) return;
  if ((state.selfTac?.bounceCd ?? 0) > 0) return;
  state.requestBounce = true;
}

/** Refleja arma equipada y munición (autoritativa) en el HUD compacto. */
function renderWeaponUi() {
  const player = state.selfTac;
  const rows = weaponHudRows(player);
  for (const btn of el.weaponSeg.querySelectorAll('button[data-weapon]')) {
    const row = rows.find((r) => r.id === btn.dataset.weapon);
    if (!row) continue;
    const on = btn.dataset.weapon === state.weapon;
    const empty = !row.available;
    btn.classList.toggle('selected', on);
    btn.classList.toggle('empty', empty);
    btn.disabled = empty;
    btn.setAttribute('aria-pressed', String(on));
    const ammo = btn.querySelector('.w-ammo');
    if (ammo) {
      ammo.textContent = row.special ? String(row.ammo) : '∞';
      ammo.classList.toggle('low', row.special && row.ammo <= 1);
    }
    if (row.special) btn.title = `${row.label} · ${row.ammo}/${row.ammoMax} · tecla ${row.key}`;
  }
}

function buildWeaponUi() {
  // Botones de arma: funcionan con ratón en escritorio y son accesibles.
  el.weaponSeg.addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-weapon]');
    if (!btn || btn.disabled) return;
    selectWeapon(btn.dataset.weapon);
    clearFlightInput();
  });
  el.chaosArmoryBtn.addEventListener('click', () => {
    if (state.mode !== 'chaos' || state.phase !== 'playing') return;
    net.send({ t: 'chaos_armory' });
    toast('Siguiente arma de prueba', 1200);
  });
  el.chaosArmoryTop.addEventListener('click', () => {
    if (state.mode !== 'chaos' || state.phase !== 'playing') return;
    net.send({ t: 'chaos_armory' });
    toast('Siguiente arma de prueba', 1200);
  });
  renderWeaponUi();
}

/** Muestra u oculta el HUD táctico según `tac.on` confirmado por el servidor. */
function renderTacticalUi() {
  const on = state.tactical;
  document.documentElement.classList.toggle('tac-mode', on);
  show(el.weaponStrip, on);
  show(el.weaponVital, on);
  show(el.chaosArmoryBtn, on && state.mode === 'chaos' && state.phase === 'playing');
  show(el.chaosArmoryTop, on && state.mode === 'chaos' && state.phase === 'playing');
  show(el.dashVital, on);
  show(el.smokeVital, on);
  show(el.bounceVital, on);
  show(el.aimVital, on);
  if (!on) {
    show(el.tacStatus, false);
    show(el.padPrompt, false);
    el.dashBar.style.width = '0%';
    el.dashNum.textContent = '—';
    el.smokeNum.textContent = '0/2';
    el.bounceBar.style.width = '0%';
    el.bounceNum.textContent = '—';
    el.aimNum.textContent = '—';
  }
  renderWeaponUi();
}

/** Estado del HUD táctico a partir de la vista (arma, esquiva, derribo/rescate). */
function renderTacticalStatus(view) {
  if (!state.tactical) return;
  const me = view?.players.find((p) => p.id === state.selfId);
  if (!me) return;
  const info = tacticalOf(state.tac, state.selfId);

  // Cooldown de esquiva AUTORITATIVO (el del servidor, no invención local).
  // Con 0 (sala de prueba) la barra queda al 100 % y se anuncia SIN ESPERA.
  const dash = dashState(info, state.dashCooldown);
  el.dashBar.style.width = `${clamp(dash.fraction * 100, 0, 100)}%`;
  el.dashNum.textContent = dash.text;

  // Munición de humo y cooldown de rebote en pared (ambos del servidor).
  const smoke = smokeRail(info);
  el.smokeNum.textContent = smoke.text;
  el.smokeNum.classList.toggle('low', smoke.ammo <= 0);
  const bounce = bounceState(info);
  el.bounceBar.style.width = `${(bounce.fraction * 100).toFixed(0)}%`;
  el.bounceNum.textContent = bounce.text;

  // Puntería: la carga también la manda el servidor (índice 12 de su fila).
  const aim = aimState(info);
  el.aimNum.textContent = aim.on ? (aim.steady ? 'FIJA' : `${Math.round(aim.charge * 100)}%`) : '—';
  el.aimVital.classList.toggle('steady', aim.steady);

  // Aviso de arma recogible cercana (solo vivo y sin apuntar a la ayuda).
  const pad = nearestPad(view?.weaponPads, me, state.world, torusDistance);
  if (pad) {
    el.padPrompt.textContent = padPromptText(pad);
    el.padPrompt.dataset.type = pad.type;
    show(el.padPrompt, true);
  } else {
    show(el.padPrompt, false);
  }

  if (me.downed) {
    el.tacStatus.className = 'tac-status downed';
    el.tacStatus.textContent = downedStatusText(me);
    show(el.tacStatus, true);
    return;
  }
  const target = nearestReviveTarget(view.players, me, state.world, torusDistance);
  if (target) {
    el.tacStatus.className = 'tac-status revive';
    el.tacStatus.textContent = `${reviveStatusText(target)} · ${playerName(target.id)}`;
    show(el.tacStatus, true);
    return;
  }
  show(el.tacStatus, false);
}

let tacHintSig = '';
/** Pista discreta de controles tácticos durante la partida (teclado o mando). */
function renderTacticalHint() {
  const text = state.screen === 'playing'
    ? flightHint({ padActive: state.padActive, tactical: state.tactical, downed: state.selfDowned, profile: controllerProfileChoice })
    : '';
  if (text === tacHintSig) return;
  tacHintSig = text;
  el.tacHint.textContent = text;
  show(el.tacHint, !!text);
}

// ─────────────────────────────────────────────────────── vista interpolada
// La interpolación y la predicción toroidal viven en motion.js y SIEMPRE usan
// el mundo del servidor (state.world): envolver con las constantes clásicas
// teletransportaba la nave al cruzar los bordes de arenas grandes.

function buildView(now, input = state.frameInput) {
  const b = state.snapB;
  if (!b) return null;
  const a = state.snapA ?? b;
  const t = interpolationFactor(a.at, b.at, now, INTERP_DELAY, 1.35);

  const dataA = a.data;
  const dataB = b.data;
  const world = state.world;

  // LAB TÁCTICO: parser tolerante (si el servidor no manda `tac`, va apagado).
  const tactical = parseTactical(dataB.tac, { mode: dataB.gm ?? state.mode });
  const meTac = tactical.players.get(state.selfId) ?? null;
  state.tactical = tactical.on;
  state.tac = tactical;
  state.selfTac = tacticalOf(tactical, state.selfId);
  state.dashCd = meTac?.dashCd ?? 0;
  state.dashCooldown = tactical.dashCooldown;
  state.aimCharge = state.selfTac.aimCharge01;
  state.selfDowned = tactical.on && !!meTac?.downed;
  // Fuera del perfil táctico (ffa/arcade) el arma vuelve al cañón de siempre:
  // las especiales solo existen donde el servidor las reconoce.
  if (!tactical.on && state.weapon !== 'auto') {
    state.weapon = 'auto';
    renderWeaponUi();
  }
  // El servidor es la autoridad del arma equipada; se adopta su valor salvo que
  // acabemos de cambiarla (evita parpadeo con la latencia de ida y vuelta).
  if (tactical.on && meTac && now - state.weaponAt > 400 && meTac.weapon !== state.weapon) {
    state.weapon = meTac.weapon;
    renderWeaponUi();
  }

  const players = [];
  const mapA = new Map(dataA.ps.map((p) => [p[0], p]));
  for (const pB of dataB.ps) {
    const pA = mapA.get(pB[0]) ?? pB;
    const [x, y] = lerpPos(pA[2], pA[3], pB[2], pB[3], t, world);
    const meta = state.roster.get(pB[0]);
    const tac = tacticalOf(tactical, pB[0]);
    players.push({
      id: pB[0],
      team: pB[1],
      x,
      y,
      vx: pB[4],
      vy: pB[5],
      angle: lerpAngle(pA[6], pB[6], t),
      hp: pB[7],
      alive: (pB[8] & FLAG.ALIVE) !== 0,
      protected: pB[10],
      boosting: (pB[8] & FLAG.BOOSTING) !== 0,
      shield: (pB[8] & FLAG.SHIELD) !== 0,
      rapid: (pB[8] & FLAG.RAPID) !== 0,
      spread: (pB[8] & FLAG.SPREAD) !== 0,
      boostCd: pB[9],
      kills: pB[12],
      deaths: pB[13],
      bot: (pB[8] & FLAG.BOT) !== 0,
      slot: meta?.slot ?? null,
      color: meta?.color ?? TEAM_COLORS[pB[1]] ?? '#9fc4ff',
      name: meta?.name ?? '',
      thrusting: Math.hypot(pB[4], pB[5]) > 12,
      // Vista táctica por jugador (contrato fijo; neutra si el perfil está off).
      weapon: tac.weapon,
      dashCd: tac.dashCd,
      downed: tac.downed,
      downedRemaining: tac.downedRemaining,
      reviveProgress: tac.reviveProgress,
      downedHp: tac.downedHp,
      // v0.2 (aditivo): casco cosmético, puntería y munición de pad.
      model: tac.model,
      aiming: tac.aiming,
      ammoSniper: tac.ammoSniper,
      ammoBoomer: tac.ammoBoomer,
      smokeAmmo: tac.smokeAmmo,
      bounceCd: tac.bounceCd,
      aimCharge: tac.aimCharge01,
    });
  }

  // Insignias de reaparición derivadas del snapshot (no de eventos perdidos).
  // La fase entra aquí para rearmar el flanco en la transición a 'playing'.
  badges.update(players, now, dataB.ph);
  for (const p of players) {
    const progress = badges.progress(p.id, now);
    p.badge = progress == null ? null : { label: badges.label(p.id, state.selfId, p.slot), progress };
  }

  const bulMapA = new Map(dataA.bs.map((x) => [x[0], x]));
  const bullets = dataB.bs.map((bB) => {
    const bA = bulMapA.get(bB[0]) ?? bB;
    const [x, y] = lerpPos(bA[1], bA[2], bB[1], bB[2], t, world);
    // El color de la bala sale del DUEÑO (necesario en ffa: el bit cyan/coral
    // no identifica a cada piloto).
    const ownerMeta = state.roster.get(bB[5]);
    return {
      x,
      y,
      angle: bB[3],
      owner: bB[5],
      team: bB[4] === 0 ? 'cyan' : 'coral',
      color: ownerMeta?.color ?? (bB[4] === 0 ? TEAM_COLORS.cyan : TEAM_COLORS.coral),
      kind: parseBulletKind(bB),
    };
  });

  const pickups = (dataB.pu ?? []).map((pu) => ({
    id: pu[0],
    x: pu[1],
    y: pu[2],
    type: POWERUP_TYPES[pu[3]] ?? 'repair',
    remaining: pu[4],
  }));

  // Armas recogibles del mapa (autoridad del servidor) y nubes de humo activas.
  const weaponPads = tactical.weaponPads;
  const smokes = tactical.smokes;

  const asMapA = new Map(dataA.as.map((x) => [x[0], x]));
  const asteroids = [];
  for (const aB of dataB.as) {
    const aA = asMapA.get(aB[0]);
    if (aA) {
      const [x, y] = lerpPos(aA[1], aA[2], aB[1], aB[2], t, world);
      asteroids.push({ id: aB[0], x, y, angle: aA[3] + (aB[3] - aA[3]) * t, size: aB[4], hp: aB[5], superCore: aB[6] === 1 });
    } else {
      asteroids.push({ id: aB[0], x: aB[1], y: aB[2], angle: aB[3], size: aB[4], hp: aB[5], superCore: aB[6] === 1 });
    }
  }

  const view = {
    players,
    bullets,
    asteroids,
    pickups,
    hillStatus: dataB.hs,
    hillCounts: dataB.hc,
    score: dataB.sc,
    timeLeft: dataB.tl,
    countdown: dataB.cd,
    phase: dataB.ph,
    mode: dataB.gm ?? state.mode,
    wave: dataB.wv ?? 0,
    lives: dataB.lv ?? 0,
    winner: dataB.win,
    seed: dataB.sd ?? 1,
    // Mundo, ajustes y colina del servidor: los usan render, torus y minimapa.
    world: state.world,
    settings: state.settings,
    hill: state.hill,
    // LAB CIUDADELA v0.2: mapa de la partida, armas del mapa y humo.
    battlefield: state.battlefield,
    weaponPads,
    smokes,
    // LAB TÁCTICO: perfil activo y coberturas estáticas destruibles.
    tactical: tactical.on,
    covers: tactical.covers,
    // v3 aditivo: cooldown de sala (0 = evasión sin espera). El renderer lo
    // usa para el dial; el HUD, para su barra y su texto.
    dashCooldown: tactical.dashCooldown,
  };

  // Predicción local de la propia nave (suavizada hacia la verdad del servidor).
  const me = players.find((p) => p.id === state.selfId);
  if (me) {
    predictSelf(me, now, input);
    if (state.pred) {
      me.x = state.pred.x;
      me.y = state.pred.y;
      me.angle = state.pred.angle;
      me.thrusting = state.predThrusting;
    }
  }
  state.view = view;
  return view;
}

function predictSelf(serverMe, now, input = state.frameInput) {
  const dt = state.lastDt ?? 1 / 60;
  // Intención PLANA ya muestreada este frame (rot/thrust/brake/boost/aim/
  // aimAngle/moveX/moveY): `stepShip` lee campos directos, no bloques anidados.
  if (!input) input = sanitizeInputIntent({ model: state.model });

  // Derribado: ALIVE está apagado, así que no se predice vuelo ni se dispara.
  if (!serverMe.alive || serverMe.downed) {
    state.pred = null;
    state.predFireCd = Math.max(0, state.predFireCd - dt);
    return;
  }
  if (!state.pred) {
    state.pred = { x: serverMe.x, y: serverMe.y, vx: serverMe.vx, vy: serverMe.vy, angle: serverMe.angle, boostTimer: 0 };
    state.predBoostTimer = 0;
    state.predBoostCd = serverMe.boostCd ?? 0;
    state.predFireCd = 0;
  }

  const pred = state.pred;
  pred.boostTimer = state.predBoostTimer;

  if (input.boost && !input.aim && state.predBoostTimer <= 0 && state.predBoostCd <= 0) {
    // El servidor no da boost mientras se apunta (LT/RMB): predecirlo igual
    // que él evita la sacudida de velocidad al apuntar con Shift mantenido.
    state.predBoostTimer = SHIP.boostDuration;
    state.predBoostCd = SHIP.boostCooldown;
    sfx.boost();
  }
  pred.boostTimer = state.predBoostTimer;
  // Predicción con el mundo del servidor y la MISMA física compartida: si se
  // apunta, el paso lleva aim/moveX/moveY igual que el servidor autoritativo.
  state.predThrusting = advancePrediction(pred, input, dt, state.world);
  resolvePredictionCovers(pred);
  state.predBoostTimer = Math.max(0, state.predBoostTimer - dt);
  state.predBoostCd = Math.max(0, state.predBoostCd - dt);

  // Corrección suave por el camino corto del toro (nunca teletransporta salvo
  // error enorme, p. ej. reaparición).
  correctPrediction(pred, serverMe, dt, state.world);
  const kv = 1 - Math.exp(-4 * dt);
  pred.vx += (serverMe.vx - pred.vx) * kv;
  pred.vy += (serverMe.vy - pred.vy) * kv;
  pred.angle += angleDelta(pred.angle, serverMe.angle) * (1 - Math.exp(-9 * dt));

  // Disparo local (solo efecto; el servidor decide el daño). Cada arma usa SU
  // cadencia del contrato: nunca se predice el sniper como automático continuo.
  state.predFireCd = Math.max(0, state.predFireCd - dt);
  const weapon = state.tactical ? state.weapon : 'auto';
  const fireCd = weapon === 'plasma' ? TACTICAL.shotgun.cooldown
    : Number(weaponInfo(weapon).cadence) || BULLET.cooldown;
  if (input.fire && state.predFireCd <= 0) {
    state.predFireCd = fireCd;
    sfx.shoot(weapon);
    const [muzzleX, muzzleY] = muzzlePoint(pred, state.world, SHIP.radius + 8);
    if (weapon === 'plasma') {
      particles.burst(muzzleX, muzzleY, TACTICAL.shotgun.pellets + 2,
        { color: '#ffd166', speed: 190, dir: pred.angle, spread: 0.9, life: 0.22, size: 2.2 },
      );
    } else if (weapon === 'sniper') {
      particles.burst(muzzleX, muzzleY, 6,
        { color: '#7fe9ff', speed: 260, dir: pred.angle, spread: 0.25, life: 0.24, size: 2.2 },
      );
    } else if (weapon === 'boomer') {
      particles.burst(muzzleX, muzzleY, 6,
        { color: '#ff9f43', speed: 150, dir: pred.angle, spread: 0.5, life: 0.3, size: 3 },
      );
    } else {
      particles.burst(muzzleX, muzzleY, 4,
        { color: TEAM_COLORS[state.team] ?? '#fff', speed: 120, dir: pred.angle, spread: 0.7, life: 0.2, size: 2 },
      );
    }
    const liveMine = state.view?.bullets.filter((b) => b.team === state.team).length ?? 0;
    if (liveMine >= BULLET.maxLive) shake.add(0.6);
  }
  void now;
}

/**
 * La predicción visual NUNCA atraviesa coberturas: se resuelve el contacto con
 * el mismo `coverContact` compartido que usa el servidor (círculos legacy y
 * rectángulos axis-aligned, en el toro del mundo). Solo se corrige la posición:
 * el daño de un boomer, la munición o el humo son decisiones del servidor.
 */
function resolvePredictionCovers(pred) {
  const covers = state.tac?.covers ?? [];
  if (!covers.length) return;
  for (let i = 0; i < 2; i++) {
    let moved = false;
    for (const cover of covers) {
      const contact = coverContact(pred.x, pred.y, SHIP.radius, cover, state.world);
      if (!contact) continue;
      pred.x = wrap(pred.x + contact.nx * (contact.depth + 0.01), state.world.w);
      pred.y = wrap(pred.y + contact.ny * (contact.depth + 0.01), state.world.h);
      moved = true;
    }
    if (!moved) break;
  }
}

// ─────────────────────────────────────────────────────────── HUD + bucle
let hudAcc = 0;
function updateHud(dt, view) {
  hudAcc += dt;
  const snap = state.latest;
  if (!snap) return;
  if (state.tacticalUiOn !== state.tactical) {
    state.tacticalUiOn = state.tactical;
    renderTacticalUi();
  }

  if (hudAcc > 0.05) {
    hudAcc = 0;
    const mode = snap.gm ?? state.mode;
    const arcade = mode === 'arcade';
    const koth = mode === 'koth';

    el.modeChip.textContent = modeChipText(mode);
    el.objectiveText.textContent = MODE_OBJECTIVE[mode] ?? '';
    el.mapChip.textContent = battlefieldChip(state.battlefield) || battlefieldMeta(state.battlefield).label;
    // Munición y armas: la vista del servidor manda; el DOM solo se toca si
    // cambió algo (el apuntado se refresca a 30 Hz como el input).
    const hudInfo = state.selfTac;
    const ammoSig = [
      hudInfo?.ammoSniper, hudInfo?.ammoBoomer, hudInfo?.smokeAmmo,
      weaponAvailable(hudInfo, 'sniper') ? 1 : 0, weaponAvailable(hudInfo, 'boomer') ? 1 : 0,
      state.weapon, state.tactical ? 1 : 0,
    ].join('|');
    if (ammoSig !== state.ammoSig) {
      state.ammoSig = ammoSig;
      renderWeaponUi();
    }

    // Marcador según modo: colina, bajas por equipo, líder/segundo o puntos y
    // oleada compartidos. Las barras usan el objetivo real de cada columna.
    const cols = scoreColumns(mode, snap);
    el.scoreCyanLabel.textContent = cols[0].label;
    el.scoreCoralLabel.textContent = cols[1].label;
    el.scoreCyan.textContent = cols[0].value;
    el.scoreCoral.textContent = cols[1].value;
    el.barCyan.style.width = `${(cols[0].frac * 100).toFixed(1)}%`;
    el.barCoral.style.width = `${(cols[1].frac * 100).toFixed(1)}%`;

    const total = Math.max(0, snap.tl);
    const m = Math.floor(total / 60);
    const s = Math.floor(total % 60);
    el.timer.textContent = arcade ? '∞' : `${m}:${String(s).padStart(2, '0')}`;

    show(el.hillState, koth);
    show(el.waveInfo, arcade);
    if (arcade) {
      // En cooperativo la reserva común es el dato crítico; los puntos y la
      // oleada ya viven en las dos columnas del marcador.
      el.waveInfo.textContent =
        snap.lv > 0 ? `REAPARICIONES ${snap.lv}` : 'SIN REAPARICIONES · SOBREVIVID';
      el.waveInfo.classList.toggle('danger', snap.lv <= 3);
    } else if (koth) {
      const status = snap.hs;
      const counts = snap.hc;
      const target = hillTargetNow();
      const remaining = state.hill.remaining;
      const moving = remaining !== null && remaining !== undefined;
      const urgent = moving && remaining <= 5;
      el.hillState.className = `hill-state ${status}${urgent ? ' warning' : ''}`;
      const base =
        status === 'contested'
          ? 'COLINA DISPUTADA'
          : status === 'idle'
            ? 'COLINA LIBRE'
            : `${TEAM_LABEL[status]?.toUpperCase() ?? status} DOMINA (${counts[0]}/${counts[1]})`;
      el.hillState.textContent = `${base} · ${hillTimerText(state.hill)}${target.next ? ' → NUEVA' : ''}`;
    }
    // tdm y ffa no usan la línea de colina: su progreso va en el marcador
    // (CYAN · BAJAS / CORAL · BAJAS o LÍDER / SEGUNDO) y el objetivo arriba.
    if (koth && snap.hs === 'contested' && Math.random() < 0.25) {
      particles.burst(state.hill.x + (Math.random() - 0.5) * state.hill.r * 1.6, state.hill.y + (Math.random() - 0.5) * state.hill.r * 1.6, 1, {
        color: '#ffd166',
        speed: 60,
        life: 0.5,
        size: 2,
      });
    }

    const me = snap.ps.find((p) => p[0] === state.selfId);
    if (me) {
      const hp = me[7];
      const eliminated = (me[8] & FLAG.ELIMINATED) !== 0;
      const alive = (me[8] & FLAG.ALIVE) !== 0;
      const downed = state.tactical && state.selfDowned;
      const downedHp = state.tac.players.get(state.selfId)?.downedHp ?? hp;
      el.hpBar.style.width = `${clamp(downed ? (downedHp / TACTICAL.downed.hp) * 100 : hp, 0, 100)}%`;
      el.hpBar.className = downed ? 'low' : hp > 55 ? '' : 'low';
      // Derribado nunca se muestra como "K.O." ni con respawn prematuro.
      el.hpNum.textContent = downed ? 'DERRIBADO' : alive ? Math.max(0, Math.round(hp)) : eliminated ? 'FUERA' : 'K.O.';
      const cd = me[9];
      el.boostBar.style.width = `${clamp((1 - cd / SHIP.boostCooldown) * 100, 0, 100)}%`;
      el.boostNum.textContent = downed ? '—' : cd > 0 ? `${cd.toFixed(1)}s` : 'LISTO';
      el.selfName.textContent = me[8] & FLAG.BOT ? `${playerName(me[0])} (bot)` : playerName(me[0]);
      const meta = state.roster.get(me[0]);
      const teamBased = mode === 'koth' || mode === 'tdm';
      const slotTag = meta?.slot ? `${meta.slot}P` : null;
      // En arcade somos aliados (sin rival) y en ffa cada piloto va por libre:
      // no tiene sentido rotular "cyan".
      const roleTag = mode === 'arcade' ? 'ALIADO' : (mode === 'ffa' || mode === 'chaos') ? 'PILOTO' : TEAM_LABEL[me[1]] ?? me[1];
      el.selfTeam.textContent = slotTag ? `${roleTag} · ${slotTag}` : roleTag;
      el.selfTeam.className = `tag ${teamBased ? me[1] : 'flat'}`;
      const respawn = alive || downed ? '' : eliminated ? ' · sin reapariciones' : ` · respawn ${Math.ceil(me[11])}s`;
      el.selfStats.textContent = `K ${me[12]} · D ${me[13]}${respawn}`;
      el.netStats.textContent = `ping ${net.ping} ms · ${state.fps} fps`;
    }
    renderTacticalStatus(view);
    renderTacticalHint();
    renderBuffBar();
    renderRosterPanel();
  }
  void view;
}

/** Barra de buffs propios con temporizador visible. */
function renderBuffBar() {
  const rows = [];
  for (const type of POWERUP_TYPES) {
    const t = state.buffs[type] ?? 0;
    if (type === 'repair' || t <= 0) continue;
    const info = powerupInfo(type);
    rows.push(`<span class="buff-chip" style="--buff:${info.color}"><b>${info.icon}</b>${escapeHtml(info.short)} ${t.toFixed(1)}s</span>`);
  }
  el.buffBar.innerHTML = rows.join('');
}

let lastFrame = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - lastFrame) / 1000) || 1 / 60;
  lastFrame = now;
  state.lastDt = dt;
  state.frames += 1;
  if (now - state.fpsAt > 1000) {
    state.fps = state.frames;
    state.frames = 0;
    state.fpsAt = now;
  }

  updateController(now);
  updateTouch();
  // MUESTREO ÚNICO por frame: el mismo objeto alimenta la predicción, el
  // apuntado local y el envío (nunca se consume dos veces el mismo flanco).
  const live = state.screen === 'playing' || state.screen === 'ended';
  const input = live ? currentInput() : sanitizeInputIntent({ weapon: state.tactical ? state.weapon : 'auto', model: state.model });
  state.frameInput = input;
  if (live) sendInput(now, input);

  const view = buildView(now, input) ?? state.view;
  shake.update(dt);
  particles.update(dt);

  if (view) {
    renderer.draw(view, {
      dt,
      particles,
      shake: shake.offset(),
      selfId: state.selfId,
      camera: { mode: cameraPrefs.mode, zoom: cameraPrefs.zoom },
      chrome: { touch: touchMode },
    });
    renderer.ctx.setTransform(1, 0, 0, 1, 0, 0);
  } else {
    renderer.drawIdleHome(dt);
  }

  updateHud(dt, view);
  requestAnimationFrame(frame);
}

// ─────────────────────────────────────────────────────────── acciones UI
$('create-btn').addEventListener('click', () => {
  const name = sanitizeName(el.nameInput.value) ?? 'Piloto';
  state.name = name;
  saveName(name);
  sfx.unlock();
  clearError(el.menuError);
  const room = createRoomOptions({ arena: state.arenaChoice, hillSeconds: state.hillSecondsChoice, stocks: el.stocksCreate.value });
  const battlefield = sanitizeBattlefieldChoice(state.battlefieldChoice);
  // El mapa solo lo propone quien crea; el modelo es cosmético propio.
  // Lee el botón seleccionado como fuente final: así una selección recién
  // hecha no puede perderse si el render del menú ocurrió en el mismo frame.
  const selectedMode = el.modeButtons.querySelector('button.selected')?.dataset.mode ?? state.createMode;
  state.createMode = selectedMode;
  state.startAfterCreate = true;
  whenConnected(() => net.send({
    t: 'create', name, team: state.preferredTeam, mode: selectedMode,
    battlefield, model: state.model, ...room,
  }));
});

$('join-btn').addEventListener('click', () => {
  const code = sanitizeRoomCode(el.codeInput.value);
  if (!code) {
    showError(el.menuError, 'Escribe un código de sala válido (4 caracteres).');
    return;
  }
  const name = sanitizeName(el.nameInput.value) ?? 'Piloto';
  state.name = name;
  saveName(name);
  sfx.unlock();
  clearError(el.menuError);
  whenConnected(() => net.send({ t: 'join', code, name, team: state.preferredTeam, model: state.model }));
});

for (const btn of document.querySelectorAll('#team-picker .team-btn')) {
  btn.addEventListener('click', () => {
    state.preferredTeam = btn.dataset.team;
    for (const other of document.querySelectorAll('#team-picker .team-btn')) other.classList.toggle('selected', other === btn);
    sfx.ui();
  });
}
document.querySelector('#team-picker .team-btn.cyan')?.classList.add('selected');

$('switch-cyan').addEventListener('click', () => {
  net.send({ t: 'team', team: 'cyan' });
  sfx.ui();
});
$('switch-coral').addEventListener('click', () => {
  net.send({ t: 'team', team: 'coral' });
  sfx.ui();
});

$('start-btn').addEventListener('click', () => {
  net.send({ t: 'start' });
  sfx.ui();
});

$('rematch-btn').addEventListener('click', () => {
  net.send({ t: 'rematch' });
  sfx.ui();
  $('rematch-info').textContent = 'Voto enviado. La revancha empieza cuando voten todos (o el anfitrión la fuerce).';
});

function leaveRoom() {
  net.close();
  state.code = null;
  state.team = null;
  state.selfId = null;
  state.host = null;
  state.reconnectCode = null;
  state.roster = new Map();
  state.latest = null;
  resetMatchState();
  setScreen('menu');
  setTimeout(() => net.connect(), 250);
}
$('leave-btn').addEventListener('click', leaveRoom);
$('leave-btn-2').addEventListener('click', leaveRoom);

el.muteBtn.addEventListener('click', toggleMute);
$('help-btn').addEventListener('click', () => show(el.help, el.help.classList.contains('hidden')));
$('help-close').addEventListener('click', () => show(el.help, false));

window.addEventListener('resize', () => { touch.clear(); renderer.resize(); });
new ResizeObserver(() => renderer.resize()).observe(el.screen);
window.visualViewport?.addEventListener('resize', () => {
  document.documentElement.style.setProperty('--view-height', `${window.visualViewport.height}px`);
  touch.clear();
});
window.addEventListener('beforeunload', () => net.close());

// ───────────────────────────────────────────────────────────── arranque
function buildControllerProfiles() {
  controllerProfileChoice = loadGamepadProfile(storage);
  controller.setProfile(controllerProfileChoice);
  const sync = () => {
    for (const button of document.querySelectorAll('[data-gamepad-profile]')) {
      const selected = button.dataset.gamepadProfile === controllerProfileChoice;
      button.classList.toggle('selected', selected);
      button.setAttribute('aria-pressed', String(selected));
    }
    for (const note of document.querySelectorAll('.gamepad-profile-note')) note.textContent = profileControls(controllerProfileChoice);
  };
  for (const group of document.querySelectorAll('.gamepad-profile-options')) {
    for (const profile of GAMEPAD_PROFILES) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.gamepadProfile = profile.id;
      button.textContent = profile.label;
      button.addEventListener('click', () => {
        clearFlightInput();
        controllerProfileChoice = saveGamepadProfile(storage, profile.id);
        controller.setProfile(controllerProfileChoice);
        controller.suppressGameplay();
        state.pad = null;
        padStatus = '';
        sync();
      });
      group.append(button);
    }
  }
  sync();
}
buildControllerProfiles();
el.nameInput.value = state.name;
el.muteBtn.textContent = sfx.muted ? '🔇' : '🔊';
buildCameraUi();
buildWorldSettings();
buildCreateOptions();
buildModelPicker();
buildWeaponUi();
particles.setWorld(state.world);
renderer.setWorld(state.world, state.hill);
applyServerConfig({}, {});
setScreen('menu');
renderMenuModeUI();
net.connect();
requestAnimationFrame(frame);

// El servidor es la autoridad: si la pestaña se oculta, no mandamos basura.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) keys.clear();
});

$('cupo-cyan').textContent = 'se elige al entrar';
$('cupo-coral').textContent = 'se elige al entrar';
