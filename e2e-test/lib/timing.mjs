/**
 * Central timing collector and per-question stats.
 */
import { now } from './helpers.mjs';

// ─── Timing Collector ──────────────────────────────────────────────────────────

/**
 * Central timing store. Every operation is recorded as a "step" with:
 *   { phase, step, detail, durationMs, success, timestamp }
 */
export const timing = {
  steps: [],            // all timed steps
  phases: {},           // phase -> { startMs, endMs }
  realtimeLags: [],     // per-player realtime propagation delays
  testStartMs: 0,
  testEndMs: 0,
};

export function recordStep(phase, step, detail, durationMs, success = true) {
  timing.steps.push({ phase, step, detail, durationMs, success, timestamp: Date.now() });
}

export function phaseStart(name) {
  timing.phases[name] = { startMs: now(), endMs: 0 };
}

export function phaseEnd(name) {
  if (timing.phases[name]) timing.phases[name].endMs = now();
}

// ─── Per-Question Stats ────────────────────────────────────────────────────────

export const stats = {
  playersCreated: 0,
  playersFailed: 0,
  errors: [],
  perQuestion: {},
  playerLogs: {},
  edgeCases: [],       // { name, description, expected, actual, pass }
  dataIntegrity: [],   // { check, detail, pass }
  passFail: [],        // { criterion, threshold, actual, pass }
  playerFetchTimes: [],    // individual player fetch durations (ms)
  scoreBroadcastHits: 0,   // players who received score via broadcast
  scoreBroadcastMisses: 0, // players who needed fallback RPC
};

export function initQStats(qId) {
  if (!stats.perQuestion[qId]) {
    stats.perQuestion[qId] = {
      submitted: 0, succeeded: 0, failed: 0, skipped: 0,
      responseTimes: [], apiTimes: [],
      // admin-side timing
      stateTransitions: {},   // state -> durationMs
      scoringMs: 0,
      leaderboardFetchMs: 0,
      responseCountFetchMs: 0,
      realtimePropagation: [],  // per-player lag
      viewerScoringDelayMs: null,  // test_viewer scoring UI delay
      scoreBroadcastHits: 0,   // players who got score via broadcast
      scoreFallbackCount: 0,   // players who needed RPC fallback
    };
  }
}

export function recordError(ctx, err) {
  const msg = `[${ctx}] ${err?.message || err}`;
  stats.errors.push(msg);
  console.error(`  ERROR ${msg}`);
}
