// Orbit Hill — preferencias locales de cámara y reglas de sala (arena/colina).
// Módulo puro: sin DOM, sin imports y sin estado global, para poder probarlo
// directamente en Node. El servidor sigue siendo la fuente de verdad: aquí solo
// viven los valores por defecto, los presets y la persistencia individual.

/** Niveles de zoom del modo seguimiento, con lectura en español. */
export const ZOOM_PRESETS = [
  { value: 0.55, label: 'Lejos', hint: 'ves más arena' },
  { value: 0.72, label: 'Medio', hint: 'equilibrado' },
  { value: 1, label: 'Cerca', hint: 'recomendado' },
  { value: 1.25, label: 'Muy cerca', hint: 'nave grande' },
];

export const ZOOM_VALUES = ZOOM_PRESETS.map((p) => p.value);
export const DEFAULT_ZOOM = 0.72;

/** Modo de cámara, independiente de los controles táctiles/teclado/mando. */
export const CAMERA_MODES = ['overview', 'follow'];
export const CAMERA_MODE_LABEL = { overview: 'Arena completa', follow: 'Seguimiento con zoom' };
export const CAMERA_MODE_HINT = {
  overview: 'Toda la arena en pantalla (sin minimapa).',
  follow: 'La cámara sigue tu nave; el minimapa te orienta.',
};
export const CAMERA_MODE_ICON = { overview: '⬚', follow: '⊕' };

/** Tamaños de sala que acepta `create` (el servidor valida igualmente). */
export const ARENAS = [
  { id: 'classic', label: 'Clásico', w: 1800, h: 1200 },
  { id: 'wide', label: 'Ampliado', w: 2400, h: 1600 },
  { id: 'large', label: 'Grande', w: 3000, h: 2000 },
  { id: 'huge', label: 'Enorme', w: 3600, h: 2400 },
];
export const DEFAULT_ARENA = 'wide';
export const ARENA_IDS = ARENAS.map((a) => a.id);

/** Ajuste de colina: 0 = fija en el centro; el resto, segundos hasta moverse. */
export const HILL_SECONDS_OPTIONS = [0, 30, 45, 60, 90];
export const DEFAULT_HILL_SECONDS = 45;

export const STORAGE_KEYS = {
  camera: 'orbit-hill-camera',
  arena: 'orbit-hill-arena',
  hill: 'orbit-hill-hill-seconds',
};

// ───────────────────────────────────────────────────────────── zoom y modo
const toNumber = (value) => {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') return Number(value);
  return NaN; // null, undefined, '', booleanos y objetos no son valores válidos
};

export function zoomPreset(value) {
  const n = toNumber(value);
  if (!Number.isFinite(n)) return null;
  let best = null;
  let bestD = Infinity;
  for (const preset of ZOOM_PRESETS) {
    const d = Math.abs(preset.value - n);
    if (d < bestD) {
      bestD = d;
      best = preset;
    }
  }
  return best;
}

/** Cualquier valor se ajusta al preset válido más cercano (o al respaldo). */
export function normalizeZoom(value, fallback = DEFAULT_ZOOM) {
  const preset = zoomPreset(value);
  return preset ? preset.value : fallback;
}

export function zoomLabel(value) {
  return zoomPreset(normalizeZoom(value, DEFAULT_ZOOM))?.label ?? 'Medio';
}

export function normalizeCameraMode(value, fallback = 'overview') {
  return CAMERA_MODES.includes(value) ? value : fallback;
}

export function cameraModeLabel(value) {
  return CAMERA_MODE_LABEL[normalizeCameraMode(value, 'overview')];
}

// ───────────────────────────────────────────────────────────────── arenas
export function arenaById(id) {
  return ARENAS.find((a) => a.id === id) ?? null;
}

export function normalizeArena(id, fallback = DEFAULT_ARENA) {
  return arenaById(id) ? id : fallback;
}

export function arenaLabel(id) {
  return arenaById(id)?.label ?? String(id ?? '');
}

export function arenaDims(id) {
  const a = arenaById(id);
  return a ? { w: a.w, h: a.h } : null;
}

export function arenaText(id) {
  const a = arenaById(id);
  return a ? `${a.label} · ${a.w}×${a.h}` : String(id ?? '');
}

// ────────────────────────────────────────────────────────────────── colina
export function normalizeHillSeconds(value, fallback = DEFAULT_HILL_SECONDS) {
  const n = toNumber(value);
  if (!Number.isFinite(n)) return fallback;
  return HILL_SECONDS_OPTIONS.includes(n) ? n : fallback;
}

export function hillSecondsLabel(seconds) {
  const s = normalizeHillSeconds(seconds, DEFAULT_HILL_SECONDS);
  return s === 0 ? 'Fija' : `${s} s`;
}

export function hillSecondsText(seconds) {
  const s = normalizeHillSeconds(seconds, DEFAULT_HILL_SECONDS);
  return s === 0 ? 'Colina fija en el centro' : `La colina se mueve cada ${s} s`;
}

// ─────────────────────────────────────────────── preferencias del jugador
export function isIPhoneLike(nav = {}) {
  const ua = String(nav.userAgent ?? '');
  const platform = String(nav.platform ?? '');
  const touch = Number(nav.maxTouchPoints ?? 0);
  if (/iPhone|iPod|iPad/.test(ua)) return true;
  // iPadOS 13+ se declara "Mac" pero con pantalla táctil.
  if (platform === 'MacIntel' && touch > 1) return true;
  return false;
}

/**
 * Cámara inicial: en iPhone/iPad y en pantallas táctiles arranca en
 * seguimiento con zoom (nave grande y minimapa); en escritorio, arena completa.
 */
export function defaultCameraPrefs(nav = {}, env = {}) {
  const iphone = isIPhoneLike(nav);
  const touchable = iphone || env.coarsePointer === true || Number(nav.maxTouchPoints ?? 0) > 0;
  return { mode: touchable ? 'follow' : 'overview', zoom: DEFAULT_ZOOM };
}

export function normalizeCameraPrefs(raw, fallback = { mode: 'overview', zoom: DEFAULT_ZOOM }) {
  const base = { mode: normalizeCameraMode(fallback?.mode, 'overview'), zoom: normalizeZoom(fallback?.zoom, DEFAULT_ZOOM) };
  // Tolera JSON, valores planos antiguos ('follow', '0.72') y basura.
  // null/'' no son números: nunca deben caer en el preset "Lejos" por Number(null)=0.
  const src = typeof raw === 'string'
    ? (/^[0-9]*\.?[0-9]+$/.test(raw.trim()) ? { zoom: raw } : { mode: raw })
    : (raw && typeof raw === 'object' ? (raw.settings ?? raw) : {});
  return {
    mode: normalizeCameraMode(src.mode, base.mode),
    zoom: normalizeZoom(src.zoom, base.zoom),
  };
}

export function loadCameraPrefs(storage, fallback = { mode: 'overview', zoom: DEFAULT_ZOOM }) {
  let raw = null;
  try {
    raw = storage?.getItem?.(STORAGE_KEYS.camera) ?? null;
  } catch {
    raw = null; // modo privado o almacenamiento bloqueado
  }
  if (raw === null || raw === undefined || raw === '') return normalizeCameraPrefs(null, fallback);
  let parsed = raw;
  if (typeof raw === 'string' && (raw.startsWith('{') || raw.startsWith('['))) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = { mode: raw };
    }
  }
  return normalizeCameraPrefs(parsed, fallback);
}

export function saveCameraPrefs(storage, prefs) {
  const clean = {
    mode: normalizeCameraMode(prefs?.mode, 'overview'),
    zoom: normalizeZoom(prefs?.zoom, DEFAULT_ZOOM),
  };
  try {
    storage?.setItem?.(STORAGE_KEYS.camera, JSON.stringify(clean));
  } catch {
    /* modo privado */
  }
  return clean;
}

export function loadArenaChoice(storage, fallback = DEFAULT_ARENA) {
  let raw = null;
  try {
    raw = storage?.getItem?.(STORAGE_KEYS.arena) ?? null;
  } catch {
    raw = null;
  }
  return normalizeArena(typeof raw === 'string' ? raw : raw ?? fallback, fallback);
}

export function saveArenaChoice(storage, arena) {
  const clean = normalizeArena(arena, DEFAULT_ARENA);
  try {
    storage?.setItem?.(STORAGE_KEYS.arena, clean);
  } catch {
    /* modo privado */
  }
  return clean;
}

export function loadHillChoice(storage, fallback = DEFAULT_HILL_SECONDS) {
  let raw = null;
  try {
    raw = storage?.getItem?.(STORAGE_KEYS.hill) ?? null;
  } catch {
    raw = null;
  }
  return normalizeHillSeconds(raw === null || raw === '' ? fallback : raw, fallback);
}

export function saveHillChoice(storage, seconds) {
  const clean = normalizeHillSeconds(seconds, DEFAULT_HILL_SECONDS);
  try {
    storage?.setItem?.(STORAGE_KEYS.hill, String(clean));
  } catch {
    /* modo privado */
  }
  return clean;
}

/** Opciones de sala que viajan en `create` (arena + ajuste de colina). */
export function createRoomOptions({ arena, hillSeconds, stocks } = {}) {
  return {
    arena: normalizeArena(arena, DEFAULT_ARENA),
    hillSeconds: normalizeHillSeconds(hillSeconds, DEFAULT_HILL_SECONDS),
    stocks: [1, 3, 5, 7].includes(Number(stocks)) ? Number(stocks) : 3,
  };
}
