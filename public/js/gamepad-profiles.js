// Movement profiles translated from Assteroids' live Unity input code.
export const GAMEPAD_PROFILES = Object.freeze([
  { id: 'citadel', label: 'Ciudadela', hint: 'Vuelo original: RT acelera; LT + stick derecho apunta. R1 dispara, A/✕ rebota y R3 lanza humo.' },
  { id: 'assteroids-turn', label: 'Assteroids · Giro', hint: 'Stick izquierdo mueve en cualquier dirección; stick derecho gira. LT/R3 apunta, RT dispara. LB propulsa; al soltar LB con dirección haces una esquiva sin espera.' },
  { id: 'assteroids-aim', label: 'Assteroids · Apuntar', hint: 'Stick izquierdo mueve en cualquier dirección; stick derecho orienta la nave. LT/R3 apunta, RT dispara. LB propulsa; al soltar LB con dirección haces una esquiva sin espera.' },
]);
export const PROFILE_STORAGE_KEY = 'orbit-hill-gamepad-profile';
export function normalizeGamepadProfile(value) {
  return GAMEPAD_PROFILES.some(p => p.id === value) ? value : 'citadel';
}
export function gamepadProfile(value) {
  return GAMEPAD_PROFILES.find(p => p.id === normalizeGamepadProfile(value));
}
export function loadGamepadProfile(storage) {
  try { return normalizeGamepadProfile(storage?.getItem(PROFILE_STORAGE_KEY)); }
  catch { return 'citadel'; }
}
export function saveGamepadProfile(storage, value) {
  const profile = normalizeGamepadProfile(value);
  try { storage?.setItem(PROFILE_STORAGE_KEY, profile); } catch { /* private mode */ }
  return profile;
}
export function profileControls(value) {
  const p = gamepadProfile(value);
  return p.hint + (p.id === 'citadel' ? '' : ' A/✕ humo · B/○ rebote · X/□ cambia arma · Y/△ rescata · RB/R1 dispara sniper si tienes munición. Cruceta: ← automático, → siguiente, ↓ sniper, ↑ lanzador.');
}
