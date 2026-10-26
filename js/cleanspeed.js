// Clean-speed loop: with note check on, the speed trainer speeds up only after clean loops
// and backs off after a messy one. Pure, so tests/cleanspeed.test.mjs can check it.

export const CLEAN = 90;    // a loop at or above this score is clean
export const MESSY = 70;    // below this it is messy
export const CLEAN_RUN = 3; // clean loops in a row before speeding up
export const BACK_OFF = 0.95;

// One finished loop. state: { speed, run, loops }, opts: { start, target, step, every }.
// score: the loop's note-check score (0-100), or null when note check is off.
// Returns the new state plus { done, change: 'up' | 'down' | null }.
export function trainerStep(state, score, opts) {
  const { target, step, every } = opts;
  const loops = state.loops + 1;
  let { speed, run } = state;
  let change = null;
  if (score == null) {
    // No note check: the old rule, faster every few loops.
    if (loops % every === 0) { speed = Math.min(target, speed + step); change = 'up'; }
  } else if (score >= CLEAN) {
    run += 1;
    if (run >= CLEAN_RUN) { speed = Math.min(target, speed + step); run = 0; change = 'up'; }
  } else if (score < MESSY) {
    speed = Math.max(25, Math.round(speed * BACK_OFF));
    run = 0;
    change = 'down';
  } else {
    run = 0; // a middling loop doesn't count toward the clean run
  }
  return { speed, run, loops, change, done: change === 'up' && speed >= target };
}

// Best clean tempo per loop range: { "startTick-endTick": percent }.
export const rangeKey = (r) => (r ? `${r.startTick}-${r.endTick}` : 'all');

export function recordClean(best, key, speed, score) {
  if (score == null || score < CLEAN) return best;
  if ((best?.[key] || 0) >= speed) return best;
  return { ...(best || {}), [key]: speed };
}
