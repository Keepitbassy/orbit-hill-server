// Opt-in movement intents. Speeds, collisions and cooldowns stay authoritative.
export const OMNI_FLIGHTS = Object.freeze(['omni-turn', 'omni-aim']);
export function sanitizeFlight(value) {
  return OMNI_FLIGHTS.includes(value) ? value : null;
}
