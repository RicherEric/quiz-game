/**
 * E2E Load Test: 100 Concurrent Players + 1 Admin
 *
 * Simulates a complete quiz game session with detailed timing:
 * - 1 admin controls the game flow (state transitions + scoring via RPC)
 * - 100 players join, listen for state changes via Realtime, and submit answers
 * - Measures every step: join, realtime propagation, answer submission,
 *   scoring RPC, leaderboard fetch, state transitions
 * - Generates an HTML report with SVG timeline & bar charts
 *
 * Usage: node load-test.mjs
 */

import { createClient } from '@supabase/supabase-js';
import { writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// ─── Load .env ─────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dirname, '.env');
try {
  const envContent = readFileSync(envPath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
} catch {
  console.warn('  Warning: .env file not found, using environment variables directly.');
}

// ─── Config ────────────────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

if (!SUPABASE_URL || !SUPABASE_KEY || !ADMIN_PASSWORD) {
  console.error('Missing required env vars: SUPABASE_URL, SUPABASE_KEY, ADMIN_PASSWORD');
  console.error('Create a .env file in the e2e-test/ directory. See .env.example');
  process.exit(1);
}

const NUM_PLAYERS = 100;
const COUNTDOWN_MS = 15000;

// ─── Helpers ───────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randomInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const randomSleep = (min, max) => sleep(randomInt(min, max));
const now = () => performance.now();

function weightedChoice() {
  const weights = [0.35, 0.30, 0.20, 0.15];
  const r = Math.random();
  let cum = 0;
  for (let i = 0; i < weights.length; i++) {
    cum += weights[i];
    if (r < cum) return i + 1;
  }
  return 4;
}

function padNum(n, len = 3) {
  return String(n).padStart(len, '0');
}

function percentile(arr, p) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function fmtMs(ms) {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  return `${ms.toFixed(0)}ms`;
}

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── Timing Collector ──────────────────────────────────────────────────────────

/**
 * Central timing store. Every operation is recorded as a "step" with:
 *   { phase, step, detail, durationMs, success, timestamp }
 */
const timing = {
  steps: [],            // all timed steps
  phases: {},           // phase -> { startMs, endMs }
  realtimeLags: [],     // per-player realtime propagation delays
  testStartMs: 0,
  testEndMs: 0,
};

function recordStep(phase, step, detail, durationMs, success = true) {
  timing.steps.push({ phase, step, detail, durationMs, success, timestamp: Date.now() });
}

function phaseStart(name) {
  timing.phases[name] = { startMs: now(), endMs: 0 };
}
function phaseEnd(name) {
  if (timing.phases[name]) timing.phases[name].endMs = now();
}

// ─── Per-Question Stats ────────────────────────────────────────────────────────

const stats = {
  playersCreated: 0,
  playersFailed: 0,
  errors: [],
  perQuestion: {},
  playerLogs: {},
};

function initQStats(qId) {
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
    };
  }
}

function recordError(ctx, err) {
  const msg = `[${ctx}] ${err?.message || err}`;
  stats.errors.push(msg);
  console.error(`  ERROR ${msg}`);
}

// ─── Supabase Client Factory ───────────────────────────────────────────────────

function newClient() {
  return createClient(SUPABASE_URL, SUPABASE_KEY, {
    realtime: { params: { eventsPerSecond: 10 } },
  });
}

// ─── Admin Actions ─────────────────────────────────────────────────────────────

const admin = newClient();

async function adminLogin() {
  const t0 = now();
  const { data, error } = await admin.rpc('admin_login', {
    p_username: ADMIN_USERNAME,
    p_password: ADMIN_PASSWORD,
  });
  const dur = now() - t0;
  recordStep('setup', 'admin-login', '', dur, !error && data?.success);
  if (error || !data?.success) throw new Error(`Admin login failed: ${error?.message || 'invalid credentials'}`);
  console.log(`  Admin logged in (${fmtMs(dur)})`);
}

async function cleanTestData() {
  const t0 = now();

  const { error: e1 } = await admin.from('responses').delete().like('player_name', 'test_%');
  if (e1) recordError('clean-responses', e1);

  const { error: e2 } = await admin.from('players').delete().like('name', 'test_%');
  if (e2) recordError('clean-players', e2);

  const { error: e3 } = await admin.from('game_status').update({ state: 'waiting', current_q_id: 1, start_time: 0 }).eq('id', 1);
  if (e3) recordError('reset-game-status', e3);

  const dur = now() - t0;
  recordStep('setup', 'clean-test-data', '', dur);
  console.log(`  Old test data cleaned (${fmtMs(dur)})`);
}

async function fetchQrToken() {
  const t0 = now();
  const { data, error } = await admin.from('qr_tokens').select('token').limit(1).single();
  const dur = now() - t0;
  recordStep('setup', 'fetch-qr-token', '', dur, !error && !!data);
  if (error || !data) throw new Error(`Failed to fetch QR token: ${error?.message || 'no token'}`);
  return data.token;
}

async function fetchQuestions() {
  const t0 = now();
  const { data, error } = await admin.from('questions').select('*').order('sort_order', { ascending: true }).order('id', { ascending: true });
  const dur = now() - t0;
  recordStep('setup', 'fetch-questions', `${data?.length || 0} questions`, dur, !error && !!data);
  if (error) throw new Error(`Failed to fetch questions: ${error.message}`);
  if (!data || data.length === 0) throw new Error('No questions found.');
  console.log(`  ${data.length} questions loaded (${fmtMs(dur)})`);
  return data;
}

async function updateGameStatus(state, currentQId) {
  const payload = { state, start_time: Date.now() };
  if (currentQId !== undefined) payload.current_q_id = currentQId;

  const t0 = now();
  const { error } = await admin.from('game_status').update(payload).eq('id', 1);
  const dur = now() - t0;
  const detail = currentQId !== undefined ? `q=${currentQId}` : '';
  recordStep('admin', `state->${state}`, detail, dur, !error);
  if (error) recordError(`update-game-status(${state})`, error);
  return { durationMs: dur, sentAt: Date.now() };
}

/**
 * Score a question using the same RPC the real admin uses.
 */
async function adminScoreViaRPC(questionId, correctAnswer) {
  const t0 = now();
  const { data, error } = await admin.rpc('score_question', {
    p_question_id: questionId,
    p_correct_answer: correctAnswer,
    p_mode: 'official',
  });
  const dur = now() - t0;
  recordStep('admin', 'score-question-rpc', `q=${questionId}, correct=${correctAnswer}`, dur, !error);
  if (error) recordError(`score-question-rpc(q${questionId})`, error);
  return { durationMs: dur, correctCount: data?.correct_count ?? 0 };
}

/**
 * Fetch response counts per choice (like admin.html revealed state).
 */
async function fetchResponseCounts(questionId) {
  const t0 = now();
  const { data, error } = await admin.from('responses').select('choice').eq('question_id', questionId);
  const dur = now() - t0;
  recordStep('admin', 'fetch-response-counts', `q=${questionId}`, dur, !error);
  const counts = { 1: 0, 2: 0, 3: 0, 4: 0 };
  if (data) data.forEach(r => { if (counts[r.choice] !== undefined) counts[r.choice]++; });
  return { durationMs: dur, counts, total: data?.length || 0 };
}

/**
 * Fetch leaderboard (like admin.html leaderboard tab).
 */
async function fetchLeaderboard() {
  const t0 = now();
  const { data, error } = await admin.from('players').select('*').order('score', { ascending: false });
  const dur = now() - t0;
  recordStep('admin', 'fetch-leaderboard', `${data?.length || 0} players`, dur, !error);
  return { durationMs: dur, players: data || [] };
}

/**
 * Fetch player_stats RPC (like admin.html PDF export).
 */
async function fetchPlayerStats() {
  const t0 = now();
  const { data, error } = await admin.rpc('get_player_stats');
  const dur = now() - t0;
  recordStep('admin', 'fetch-player-stats', `${data?.length || 0} rows`, dur, !error);
  return { durationMs: dur, data: data || [] };
}

// ─── Player Simulation ─────────────────────────────────────────────────────────

function createPlayer(index, qrToken) {
  const name = `test_user_${padNum(index)}`;
  const client = newClient();
  let channel = null;
  let lastStateReceivedAt = 0;

  stats.playerLogs[name] = { joinTimeMs: 0, joinSuccess: false, answers: [] };

  return {
    name,

    async join() {
      await randomSleep(0, 2000);

      const t0 = now();
      const { data, error } = await client.rpc('join_via_qr', {
        qr_token: qrToken,
        player_name: name,
      });
      const dur = now() - t0;

      stats.playerLogs[name].joinTimeMs = dur;
      recordStep('join', 'player-join', name, dur, !error);

      if (error) {
        stats.playersFailed++;
        stats.playerLogs[name].joinSuccess = false;
        recordError(`player-join(${name})`, error);
        return false;
      }
      stats.playersCreated++;
      stats.playerLogs[name].joinSuccess = true;
      return true;
    },

    /**
     * Subscribe to game_status realtime and record propagation lag.
     */
    subscribe(onStateChange) {
      channel = client
        .channel(`player-${name}`)
        .on(
          'postgres_changes',
          { event: 'UPDATE', schema: 'public', table: 'game_status', filter: 'id=eq.1' },
          (payload) => {
            lastStateReceivedAt = Date.now();
            if (onStateChange) onStateChange(name, payload.new, lastStateReceivedAt);
          }
        )
        .subscribe();
    },

    getLastStateReceivedAt() {
      return lastStateReceivedAt;
    },

    async answer(questionId) {
      initQStats(questionId);
      const qs = stats.perQuestion[questionId];

      // 10% chance of not answering
      if (Math.random() < 0.1) {
        qs.skipped++;
        stats.playerLogs[name].answers.push({
          questionId, choice: null, responseTimeMs: 0, apiTimeMs: 0, skipped: true, success: false,
        });
        return;
      }

      // Random thinking time 1-12s
      const thinkTime = randomInt(1000, 12000);
      await sleep(thinkTime);
      await randomSleep(200, 800);

      const choice = weightedChoice();
      const responseTimeMs = thinkTime + randomInt(200, 800);

      const t0 = now();
      const { error } = await client.rpc('submit_response', {
        p_player_name: name,
        p_question_id: questionId,
        p_choice: choice,
        p_response_time_ms: responseTimeMs,
        p_qr_token: qrToken,
      });
      const apiTime = now() - t0;

      qs.submitted++;
      qs.apiTimes.push(apiTime);

      if (error) {
        qs.failed++;
        stats.playerLogs[name].answers.push({
          questionId, choice, responseTimeMs, apiTimeMs: apiTime, skipped: false, success: false,
        });
        recordError(`player-answer(${name}, q${questionId})`, error);
      } else {
        qs.succeeded++;
        qs.responseTimes.push(responseTimeMs);
        stats.playerLogs[name].answers.push({
          questionId, choice, responseTimeMs, apiTimeMs: apiTime, skipped: false, success: true,
        });
      }
    },

    /**
     * Poll game_status (like the 2s fallback in index.html).
     */
    async poll() {
      const t0 = now();
      const { data } = await client.from('game_status').select('*').eq('id', 1).single();
      return { durationMs: now() - t0, data };
    },

    /**
     * Fetch own score (like scoring-ui in index.html).
     */
    async fetchMyScore(questionId) {
      const t0 = now();
      const { data: resp } = await client.from('responses').select('scored_points').eq('player_name', name).eq('question_id', questionId).single();
      const { data: player } = await client.from('players').select('score').eq('name', name).single();
      const dur = now() - t0;
      return { durationMs: dur, questionScore: resp?.scored_points || 0, totalScore: player?.score || 0 };
    },

    /**
     * Fetch final leaderboard (like end-ui in index.html).
     */
    async fetchEndLeaderboard() {
      const t0 = now();
      const { data } = await client.from('players').select('*').order('score', { ascending: false });
      const dur = now() - t0;
      const rank = data ? data.findIndex(p => p.name === name) + 1 : -1;
      return { durationMs: dur, rank, total: data?.length || 0 };
    },

    async cleanup() {
      if (channel) await client.removeChannel(channel);
    },
  };
}

// ─── Measure Realtime Propagation ──────────────────────────────────────────────

/**
 * After admin updates game_status, wait up to `timeoutMs` and measure
 * how long each player's realtime subscription takes to receive the event.
 */
async function measureRealtimePropagation(players, sentAt, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  const lags = [];

  // Poll until all players received or timeout
  while (Date.now() < deadline) {
    let allReceived = true;
    for (const p of players) {
      const recv = p.getLastStateReceivedAt();
      if (recv < sentAt) { allReceived = false; break; }
    }
    if (allReceived) break;
    await sleep(50);
  }

  for (const p of players) {
    const recv = p.getLastStateReceivedAt();
    if (recv >= sentAt) {
      lags.push(recv - sentAt);
    }
  }

  return lags;
}

// ─── Console Report ────────────────────────────────────────────────────────────

function printReport(questions) {
  console.log('\n' + '='.repeat(72));
  console.log('  E2E LOAD TEST REPORT (DETAILED TIMING)');
  console.log('='.repeat(72));

  const totalDur = (timing.testEndMs - timing.testStartMs) / 1000;
  console.log(`\n  Total duration: ${totalDur.toFixed(1)}s`);
  console.log(`  Players: ${stats.playersCreated} joined / ${stats.playersFailed} failed / ${NUM_PLAYERS} total`);

  // Phase durations
  console.log('\n  Phase Durations:');
  for (const [name, p] of Object.entries(timing.phases)) {
    const dur = (p.endMs - p.startMs) / 1000;
    console.log(`    ${name.padEnd(30)} ${dur.toFixed(2)}s`);
  }

  // Per-question summary
  const allApiTimes = [];
  console.log('\n  Per-Question Summary:');
  console.log('  ' + '-'.repeat(68));
  console.log(
    '  ' + 'Q#'.padEnd(5) + 'Submit'.padEnd(9) + 'OK'.padEnd(6) + 'Fail'.padEnd(6) + 'Skip'.padEnd(6) +
    'API p50'.padEnd(10) + 'API p95'.padEnd(10) + 'Score RPC'.padEnd(12) + 'RT Lag p50'
  );
  console.log('  ' + '-'.repeat(68));

  for (const q of questions) {
    const qs = stats.perQuestion[q.id];
    if (!qs) continue;
    allApiTimes.push(...qs.apiTimes);
    const qi = questions.indexOf(q) + 1;
    const rtLagP50 = qs.realtimePropagation.length > 0 ? fmtMs(percentile(qs.realtimePropagation, 50)) : '-';
    console.log(
      '  ' + `Q${qi}`.padEnd(5) +
      String(qs.submitted).padEnd(9) +
      String(qs.succeeded).padEnd(6) +
      String(qs.failed).padEnd(6) +
      String(qs.skipped).padEnd(6) +
      fmtMs(percentile(qs.apiTimes, 50)).padEnd(10) +
      fmtMs(percentile(qs.apiTimes, 95)).padEnd(10) +
      fmtMs(qs.scoringMs).padEnd(12) +
      rtLagP50
    );
  }

  // Overall API timing
  console.log('\n  Overall API (submit_response) Distribution:');
  if (allApiTimes.length > 0) {
    console.log(`    p50:  ${fmtMs(percentile(allApiTimes, 50))}`);
    console.log(`    p90:  ${fmtMs(percentile(allApiTimes, 90))}`);
    console.log(`    p95:  ${fmtMs(percentile(allApiTimes, 95))}`);
    console.log(`    p99:  ${fmtMs(percentile(allApiTimes, 99))}`);
    console.log(`    max:  ${fmtMs(Math.max(...allApiTimes))}`);
  }

  // Realtime propagation
  if (timing.realtimeLags.length > 0) {
    console.log('\n  Realtime Propagation Lag (all state changes):');
    console.log(`    p50:  ${fmtMs(percentile(timing.realtimeLags, 50))}`);
    console.log(`    p95:  ${fmtMs(percentile(timing.realtimeLags, 95))}`);
    console.log(`    max:  ${fmtMs(Math.max(...timing.realtimeLags))}`);
  }

  console.log(`\n  Total errors: ${stats.errors.length}`);
  if (stats.errors.length > 0) {
    for (const e of stats.errors.slice(0, 15)) console.log(`    - ${e}`);
    if (stats.errors.length > 15) console.log(`    ... and ${stats.errors.length - 15} more`);
  }

  console.log('\n' + '='.repeat(72));
}

// ─── HTML Report ───────────────────────────────────────────────────────────────

function generateHtmlReport(questions) {
  const testDuration = ((timing.testEndMs - timing.testStartMs) / 1000).toFixed(1);
  const startTimeStr = new Date(timing.testStartMs).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });

  // ── Collect all API times ──
  const allApiTimes = [];
  for (const q of questions) {
    const qs = stats.perQuestion[q.id];
    if (qs) allApiTimes.push(...qs.apiTimes);
  }

  // ── Step breakdown by category ──
  const stepGroups = {};
  timing.steps.forEach(s => {
    const key = `${s.phase}/${s.step}`;
    if (!stepGroups[key]) stepGroups[key] = { count: 0, times: [], failed: 0 };
    stepGroups[key].count++;
    stepGroups[key].times.push(s.durationMs);
    if (!s.success) stepGroups[key].failed++;
  });

  // ── Phase timeline data ──
  const phaseEntries = Object.entries(timing.phases)
    .filter(([, p]) => p.endMs > 0)
    .map(([name, p]) => ({ name, duration: p.endMs - p.startMs, start: p.startMs }));
  const minStart = phaseEntries.length > 0 ? Math.min(...phaseEntries.map(p => p.start)) : 0;

  // ── SVG Timeline Chart ──
  const timelineWidth = 900;
  const barHeight = 28;
  const labelWidth = 180;
  const timelineChartHeight = phaseEntries.length * (barHeight + 8) + 40;
  const maxDur = phaseEntries.length > 0 ? Math.max(...phaseEntries.map(p => (p.start - minStart) + p.duration)) : 1;
  const scale = (timelineWidth - labelWidth - 20) / maxDur;

  let timelineSvg = `<svg width="${timelineWidth}" height="${timelineChartHeight}" xmlns="http://www.w3.org/2000/svg" style="font-family:monospace;font-size:12px">`;
  phaseEntries.forEach((p, i) => {
    const y = i * (barHeight + 8) + 10;
    const x = labelWidth + (p.start - minStart) * scale;
    const w = Math.max(2, p.duration * scale);
    const colors = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16'];
    const c = colors[i % colors.length];
    timelineSvg += `<text x="4" y="${y + 18}" fill="#ccc">${escapeHtml(p.name)}</text>`;
    timelineSvg += `<rect x="${x}" y="${y}" width="${w}" height="${barHeight}" rx="4" fill="${c}" opacity="0.85"/>`;
    timelineSvg += `<text x="${x + w + 6}" y="${y + 18}" fill="#aaa">${(p.duration / 1000).toFixed(2)}s</text>`;
  });
  timelineSvg += '</svg>';

  // ── SVG Bar Chart: Per-question API p50/p95 ──
  const qBarWidth = 900;
  const qBarItemH = 36;
  const qBarChartH = questions.length * qBarItemH + 40;
  const allMaxApi = allApiTimes.length > 0 ? Math.max(...allApiTimes) : 1;
  const qScale = (qBarWidth - 200) / allMaxApi;

  let qBarSvg = `<svg width="${qBarWidth}" height="${qBarChartH}" xmlns="http://www.w3.org/2000/svg" style="font-family:monospace;font-size:12px">`;
  questions.forEach((q, qi) => {
    const qs = stats.perQuestion[q.id];
    if (!qs || qs.apiTimes.length === 0) return;
    const y = qi * qBarItemH + 10;
    const p50 = percentile(qs.apiTimes, 50);
    const p95 = percentile(qs.apiTimes, 95);
    const maxV = Math.max(...qs.apiTimes);
    qBarSvg += `<text x="4" y="${y + 20}" fill="#ccc">Q${qi + 1}</text>`;
    // p95 bar (background)
    qBarSvg += `<rect x="40" y="${y + 2}" width="${Math.max(2, p95 * qScale)}" height="${qBarItemH - 8}" rx="3" fill="#ef4444" opacity="0.4"/>`;
    // p50 bar (foreground)
    qBarSvg += `<rect x="40" y="${y + 2}" width="${Math.max(2, p50 * qScale)}" height="${qBarItemH - 8}" rx="3" fill="#3b82f6" opacity="0.8"/>`;
    // Labels
    const labelX = 40 + Math.max(p95 * qScale, p50 * qScale) + 8;
    qBarSvg += `<text x="${labelX}" y="${y + 15}" fill="#60a5fa">p50: ${fmtMs(p50)}</text>`;
    qBarSvg += `<text x="${labelX}" y="${y + 28}" fill="#f87171">p95: ${fmtMs(p95)}</text>`;
    qBarSvg += `<text x="${labelX + 130}" y="${y + 15}" fill="#888">max: ${fmtMs(maxV)}</text>`;
  });
  qBarSvg += '</svg>';

  // ── SVG Bar Chart: Scoring RPC + Leaderboard ──
  const adminSteps = timing.steps.filter(s => s.phase === 'admin');
  const adminBarH = 28;
  const scoringSteps = adminSteps.filter(s => s.step === 'score-question-rpc' || s.step === 'fetch-leaderboard' || s.step === 'fetch-player-stats' || s.step === 'fetch-response-counts');
  const scoringMaxMs = scoringSteps.length > 0 ? Math.max(...scoringSteps.map(s => s.durationMs)) : 1;
  const scoringBarW = 900;
  const scoringBarH = scoringSteps.length * (adminBarH + 6) + 40;
  const scoringScale = (scoringBarW - 320) / scoringMaxMs;

  let scoringBarSvg = `<svg width="${scoringBarW}" height="${scoringBarH}" xmlns="http://www.w3.org/2000/svg" style="font-family:monospace;font-size:11px">`;
  scoringSteps.forEach((s, i) => {
    const y = i * (adminBarH + 6) + 10;
    const w = Math.max(2, s.durationMs * scoringScale);
    const c = s.success ? '#10b981' : '#ef4444';
    const label = `${s.step} ${s.detail}`;
    scoringBarSvg += `<text x="4" y="${y + 18}" fill="#ccc">${escapeHtml(label.slice(0, 35))}</text>`;
    scoringBarSvg += `<rect x="280" y="${y}" width="${w}" height="${adminBarH}" rx="3" fill="${c}" opacity="0.7"/>`;
    scoringBarSvg += `<text x="${280 + w + 6}" y="${y + 18}" fill="#aaa">${fmtMs(s.durationMs)}</text>`;
  });
  scoringBarSvg += '</svg>';

  // ── SVG: Realtime propagation histogram ──
  const rtLags = timing.realtimeLags;
  let rtHistSvg = '';
  if (rtLags.length > 0) {
    const bucketSize = 100; // ms per bucket
    const buckets = {};
    rtLags.forEach(lag => {
      const b = Math.floor(lag / bucketSize) * bucketSize;
      buckets[b] = (buckets[b] || 0) + 1;
    });
    const bucketKeys = Object.keys(buckets).map(Number).sort((a, b) => a - b);
    const maxCount = Math.max(...Object.values(buckets));
    const histW = 900;
    const histBarW = Math.min(40, (histW - 80) / bucketKeys.length - 2);
    const histH = 200;
    const histScale = (histH - 40) / maxCount;

    rtHistSvg = `<svg width="${histW}" height="${histH}" xmlns="http://www.w3.org/2000/svg" style="font-family:monospace;font-size:10px">`;
    bucketKeys.forEach((b, i) => {
      const x = 50 + i * (histBarW + 2);
      const h = buckets[b] * histScale;
      const y = histH - 30 - h;
      rtHistSvg += `<rect x="${x}" y="${y}" width="${histBarW}" height="${h}" rx="2" fill="#8b5cf6" opacity="0.8"/>`;
      rtHistSvg += `<text x="${x + histBarW / 2}" y="${histH - 15}" text-anchor="middle" fill="#888">${b}ms</text>`;
      rtHistSvg += `<text x="${x + histBarW / 2}" y="${y - 4}" text-anchor="middle" fill="#c4b5fd">${buckets[b]}</text>`;
    });
    rtHistSvg += `<text x="4" y="15" fill="#aaa">Realtime Propagation Histogram (${rtLags.length} events)</text>`;
    rtHistSvg += '</svg>';
  }

  // ── Per-question rows ──
  let questionRows = '';
  questions.forEach((q, qi) => {
    const qs = stats.perQuestion[q.id];
    if (!qs) return;
    const avgRT = qs.responseTimes.length > 0
      ? Math.round(qs.responseTimes.reduce((a, b) => a + b, 0) / qs.responseTimes.length)
      : 0;
    const rtP50 = qs.realtimePropagation.length > 0 ? fmtMs(percentile(qs.realtimePropagation, 50)) : '-';
    const rtP95 = qs.realtimePropagation.length > 0 ? fmtMs(percentile(qs.realtimePropagation, 95)) : '-';
    const failClass = qs.failed > 0 ? ' class="fail"' : '';

    // State transitions timing
    let stateTimings = '';
    for (const [state, dur] of Object.entries(qs.stateTransitions)) {
      stateTimings += `<span class="badge">${state}: ${fmtMs(dur)}</span> `;
    }

    questionRows += `
      <tr>
        <td>Q${qi + 1}</td>
        <td>${escapeHtml((q.question || '').slice(0, 50))}</td>
        <td>${qs.submitted}</td>
        <td>${qs.succeeded}</td>
        <td${failClass}>${qs.failed}</td>
        <td>${qs.skipped}</td>
        <td>${avgRT}ms</td>
        <td>${fmtMs(percentile(qs.apiTimes, 50))}</td>
        <td>${fmtMs(percentile(qs.apiTimes, 95))}</td>
        <td>${qs.apiTimes.length > 0 ? fmtMs(Math.max(...qs.apiTimes)) : '-'}</td>
        <td>${fmtMs(qs.scoringMs)}</td>
        <td>${fmtMs(qs.responseCountFetchMs)}</td>
        <td>${rtP50}</td>
        <td>${rtP95}</td>
        <td>${stateTimings || '-'}</td>
      </tr>`;
  });

  // ── Step operations table ──
  let stepRows = '';
  Object.entries(stepGroups)
    .sort((a, b) => b[1].count - a[1].count)
    .forEach(([key, g]) => {
      const avg = Math.round(g.times.reduce((s, t) => s + t, 0) / g.count);
      const failClass = g.failed > 0 ? ' class="fail"' : '';
      stepRows += `
      <tr>
        <td>${escapeHtml(key)}</td>
        <td>${g.count}</td>
        <td>${fmtMs(avg)}</td>
        <td>${fmtMs(percentile(g.times, 50))}</td>
        <td>${fmtMs(percentile(g.times, 95))}</td>
        <td>${g.times.length > 0 ? fmtMs(Math.max(...g.times)) : '-'}</td>
        <td${failClass}>${g.failed}</td>
      </tr>`;
    });

  // ── Player detail rows ──
  let playerRows = '';
  const playerNames = Object.keys(stats.playerLogs).sort();
  playerNames.forEach(name => {
    const log = stats.playerLogs[name];
    const answered = log.answers.filter(a => !a.skipped);
    const skippedCount = log.answers.filter(a => a.skipped).length;
    const failedCount = answered.filter(a => !a.success).length;
    const successCount = answered.filter(a => a.success).length;
    const apiTimes = answered.filter(a => a.apiTimeMs > 0).map(a => a.apiTimeMs);
    const avgApi = apiTimes.length > 0 ? Math.round(apiTimes.reduce((s, t) => s + t, 0) / apiTimes.length) : 0;
    const maxApi = apiTimes.length > 0 ? Math.max(...apiTimes) : 0;

    let answerCells = '';
    log.answers.forEach((a, i) => {
      let status, cls;
      if (a.skipped) { status = 'SKIP'; cls = 'skip'; }
      else if (a.success) { status = 'OK'; cls = 'pass'; }
      else { status = 'FAIL'; cls = 'fail'; }
      answerCells += `
        <tr>
          <td>Q${i + 1}</td>
          <td>${a.choice ?? '-'}</td>
          <td>${a.skipped ? '-' : fmtMs(a.responseTimeMs)}</td>
          <td>${a.skipped ? '-' : fmtMs(a.apiTimeMs)}</td>
          <td class="${cls}">${status}</td>
        </tr>`;
    });

    playerRows += `
      <tr class="player-row" data-player="${escapeHtml(name)}">
        <td>${escapeHtml(name)}</td>
        <td class="${log.joinSuccess ? 'pass' : 'fail'}">${log.joinSuccess ? 'OK' : 'FAIL'}</td>
        <td>${fmtMs(log.joinTimeMs)}</td>
        <td>${successCount}</td>
        <td>${skippedCount}</td>
        <td${failedCount > 0 ? ' class="fail"' : ''}>${failedCount}</td>
        <td>${fmtMs(avgApi)}</td>
        <td>${fmtMs(maxApi)}</td>
      </tr>
      <tr class="detail-row">
        <td colspan="8">
          <table class="detail-table">
            <thead><tr><th>Question</th><th>Choice</th><th>Response Time</th><th>API Latency</th><th>Status</th></tr></thead>
            <tbody>${answerCells}</tbody>
          </table>
        </td>
      </tr>`;
  });

  // ── Error rows ──
  let errorRows = '';
  stats.errors.forEach((e, i) => {
    errorRows += `<tr><td>${i + 1}</td><td>${escapeHtml(e)}</td></tr>`;
  });

  // ── Build HTML ──
  const totalDbOps = timing.steps.length;
  const failedDbOps = timing.steps.filter(s => !s.success).length;

  const html = `<!DOCTYPE html>
<html lang="zh-TW">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>E2E Load Test Report — Detailed Timing</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Microsoft JhengHei', sans-serif; background: #0f1117; color: #e2e8f0; }

    .header { background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%); color: #fff; padding: 32px 40px; border-bottom: 2px solid #334155; }
    .header h1 { font-size: 28px; margin-bottom: 8px; }
    .header .subtitle { opacity: 0.8; font-size: 14px; }

    .container { max-width: 1600px; margin: 0 auto; padding: 24px; }

    .summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 14px; margin-bottom: 24px; }
    .summary-card { background: #1e293b; border-radius: 12px; padding: 18px; border: 1px solid #334155; }
    .summary-card .label { font-size: 11px; color: #94a3b8; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 4px; }
    .summary-card .value { font-size: 26px; font-weight: 700; }
    .summary-card .value.green { color: #34d399; }
    .summary-card .value.red { color: #f87171; }
    .summary-card .value.blue { color: #60a5fa; }
    .summary-card .value.orange { color: #fbbf24; }
    .summary-card .value.purple { color: #a78bfa; }

    .section { background: #1e293b; border-radius: 12px; padding: 24px; margin-bottom: 24px; border: 1px solid #334155; }
    .section h2 { font-size: 18px; margin-bottom: 16px; padding-bottom: 8px; border-bottom: 2px solid #334155; color: #f1f5f9; }

    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th { background: #0f172a; text-align: left; padding: 10px 12px; font-weight: 600; color: #94a3b8; border-bottom: 2px solid #334155; position: sticky; top: 0; }
    td { padding: 7px 12px; border-bottom: 1px solid #1e293b; }
    tr:hover { background: #1e293b; }

    .pass { color: #34d399; font-weight: 600; }
    .fail { color: #f87171; font-weight: 600; }
    .skip { color: #fbbf24; font-weight: 600; }

    .player-row { cursor: pointer; transition: background 0.15s; }
    .player-row:hover { background: #1e3a5f !important; }
    .player-row td:first-child::before { content: '\\25B6 '; font-size: 10px; color: #475569; }
    .player-row.expanded td:first-child::before { content: '\\25BC '; }

    .detail-row { display: none; }
    .detail-row.show { display: table-row; }
    .detail-row > td { padding: 0 12px 12px 32px; background: #0f172a; }

    .detail-table { margin-top: 8px; font-size: 11px; }
    .detail-table th { background: #1e293b; padding: 6px 10px; }
    .detail-table td { padding: 5px 10px; border-bottom: 1px solid #334155; }

    .percentile-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; margin-top: 12px; }
    .percentile-card { text-align: center; padding: 12px; background: #0f172a; border-radius: 8px; border: 1px solid #334155; }
    .percentile-card .p-label { font-size: 10px; color: #64748b; text-transform: uppercase; letter-spacing: 1px; }
    .percentile-card .p-value { font-size: 22px; font-weight: 700; color: #e2e8f0; margin-top: 2px; }

    .badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 10px; font-weight: 600; background: #334155; color: #94a3b8; margin: 1px; }

    .chart-container { overflow-x: auto; padding: 8px 0; }
    .chart-container svg { background: #0f172a; border-radius: 8px; padding: 12px; }

    .filter-bar { display: flex; gap: 12px; margin-bottom: 12px; align-items: center; flex-wrap: wrap; }
    .filter-bar input, .filter-bar select { padding: 6px 12px; border: 1px solid #334155; border-radius: 6px; font-size: 13px; background: #0f172a; color: #e2e8f0; }

    .error-section { border-left: 4px solid #ef4444; }
    .error-section h2 { color: #f87171; }

    .footer { text-align: center; padding: 16px; color: #475569; font-size: 12px; }

    .tab-nav { display: flex; gap: 4px; margin-bottom: 16px; flex-wrap: wrap; }
    .tab-btn { padding: 8px 16px; border-radius: 8px 8px 0 0; border: 1px solid #334155; border-bottom: none; background: #0f172a; color: #94a3b8; cursor: pointer; font-size: 13px; font-weight: 600; }
    .tab-btn.active { background: #1e293b; color: #f1f5f9; border-color: #3b82f6; border-bottom: 2px solid #1e293b; margin-bottom: -1px; }
    .tab-content { display: none; }
    .tab-content.active { display: block; }

    @media (max-width: 768px) {
      .header { padding: 20px; }
      .container { padding: 12px; }
      .summary-grid { grid-template-columns: repeat(2, 1fr); }
    }
  </style>
</head>
<body>

<div class="header">
  <h1>E2E Load Test Report — Detailed Timing</h1>
  <div class="subtitle">${startTimeStr} &nbsp;|&nbsp; Duration: ${testDuration}s &nbsp;|&nbsp; ${NUM_PLAYERS} Players &nbsp;|&nbsp; ${questions.length} Questions &nbsp;|&nbsp; ${totalDbOps} Operations</div>
</div>

<div class="container">

  <!-- ── Summary Cards ── -->
  <div class="summary-grid">
    <div class="summary-card">
      <div class="label">Players Joined</div>
      <div class="value green">${stats.playersCreated} <span style="font-size:13px;color:#64748b">/ ${NUM_PLAYERS}</span></div>
    </div>
    <div class="summary-card">
      <div class="label">Join Failures</div>
      <div class="value ${stats.playersFailed > 0 ? 'red' : 'green'}">${stats.playersFailed}</div>
    </div>
    <div class="summary-card">
      <div class="label">API p50 / p95</div>
      <div class="value blue" style="font-size:18px">${allApiTimes.length > 0 ? fmtMs(percentile(allApiTimes, 50)) + ' / ' + fmtMs(percentile(allApiTimes, 95)) : '-'}</div>
    </div>
    <div class="summary-card">
      <div class="label">Realtime Lag p50</div>
      <div class="value purple">${timing.realtimeLags.length > 0 ? fmtMs(percentile(timing.realtimeLags, 50)) : '-'}</div>
    </div>
    <div class="summary-card">
      <div class="label">Realtime Lag p95</div>
      <div class="value purple">${timing.realtimeLags.length > 0 ? fmtMs(percentile(timing.realtimeLags, 95)) : '-'}</div>
    </div>
    <div class="summary-card">
      <div class="label">Total Operations</div>
      <div class="value blue">${totalDbOps}</div>
    </div>
    <div class="summary-card">
      <div class="label">Failed Operations</div>
      <div class="value ${failedDbOps > 0 ? 'red' : 'green'}">${failedDbOps}</div>
    </div>
    <div class="summary-card">
      <div class="label">Total Errors</div>
      <div class="value ${stats.errors.length > 0 ? 'red' : 'green'}">${stats.errors.length}</div>
    </div>
  </div>

  <!-- ── Tabs ── -->
  <div class="tab-nav">
    <button class="tab-btn active" onclick="showTab('timeline')">Timeline</button>
    <button class="tab-btn" onclick="showTab('questions')">Per-Question</button>
    <button class="tab-btn" onclick="showTab('api')">API Timing</button>
    <button class="tab-btn" onclick="showTab('scoring')">Scoring & Settlement</button>
    <button class="tab-btn" onclick="showTab('realtime')">Realtime Propagation</button>
    <button class="tab-btn" onclick="showTab('operations')">All Operations</button>
    <button class="tab-btn" onclick="showTab('players')">Player Details</button>
    <button class="tab-btn" onclick="showTab('errors')">Errors</button>
  </div>

  <!-- ── Tab: Timeline ── -->
  <div id="tab-timeline" class="tab-content active">
    <div class="section">
      <h2>Phase Timeline</h2>
      <p style="color:#64748b;font-size:12px;margin-bottom:12px">Each bar shows the total time spent in that phase. Horizontal position = time offset from test start.</p>
      <div class="chart-container">${timelineSvg}</div>
    </div>
  </div>

  <!-- ── Tab: Per-Question ── -->
  <div id="tab-questions" class="tab-content">
    <div class="section">
      <h2>Per-Question Results (Detailed)</h2>
      <p style="color:#64748b;font-size:12px;margin-bottom:12px">API latency = round-trip to Supabase for submit_response. RT Lag = realtime push delay to players. Scoring = score_question RPC duration.</p>
      <div style="overflow-x:auto">
      <table>
        <thead>
          <tr>
            <th>#</th><th>Question</th><th>Submit</th><th>OK</th><th>Fail</th><th>Skip</th>
            <th>Avg RT</th><th>API p50</th><th>API p95</th><th>API Max</th>
            <th>Scoring RPC</th><th>Resp Fetch</th><th>RT Lag p50</th><th>RT Lag p95</th><th>State Transitions</th>
          </tr>
        </thead>
        <tbody>${questionRows}</tbody>
      </table>
      </div>
    </div>
  </div>

  <!-- ── Tab: API Timing ── -->
  <div id="tab-api" class="tab-content">
    <div class="section">
      <h2>API Response Time Distribution (submit_response)</h2>
      <p style="color:#64748b;font-size:12px;margin-bottom:12px">Round-trip from Node.js to Supabase REST API for all player answer submissions.</p>
      <div class="percentile-grid">
        <div class="percentile-card"><div class="p-label">p50 (Median)</div><div class="p-value">${allApiTimes.length > 0 ? fmtMs(percentile(allApiTimes, 50)) : '-'}</div></div>
        <div class="percentile-card"><div class="p-label">p75</div><div class="p-value">${allApiTimes.length > 0 ? fmtMs(percentile(allApiTimes, 75)) : '-'}</div></div>
        <div class="percentile-card"><div class="p-label">p90</div><div class="p-value">${allApiTimes.length > 0 ? fmtMs(percentile(allApiTimes, 90)) : '-'}</div></div>
        <div class="percentile-card"><div class="p-label">p95</div><div class="p-value">${allApiTimes.length > 0 ? fmtMs(percentile(allApiTimes, 95)) : '-'}</div></div>
        <div class="percentile-card"><div class="p-label">p99</div><div class="p-value">${allApiTimes.length > 0 ? fmtMs(percentile(allApiTimes, 99)) : '-'}</div></div>
        <div class="percentile-card"><div class="p-label">Max</div><div class="p-value">${allApiTimes.length > 0 ? fmtMs(Math.max(...allApiTimes)) : '-'}</div></div>
        <div class="percentile-card"><div class="p-label">Mean</div><div class="p-value">${allApiTimes.length > 0 ? fmtMs(allApiTimes.reduce((s, t) => s + t, 0) / allApiTimes.length) : '-'}</div></div>
        <div class="percentile-card"><div class="p-label">Total Calls</div><div class="p-value">${allApiTimes.length}</div></div>
      </div>
    </div>
    <div class="section">
      <h2>Per-Question API Latency (p50 / p95)</h2>
      <p style="color:#64748b;font-size:12px;margin-bottom:12px">Blue = p50 (median), Red = p95. Shows how API latency varies across questions under sustained load.</p>
      <div class="chart-container">${qBarSvg}</div>
    </div>
  </div>

  <!-- ── Tab: Scoring ── -->
  <div id="tab-scoring" class="tab-content">
    <div class="section">
      <h2>Scoring & Settlement Timing</h2>
      <p style="color:#64748b;font-size:12px;margin-bottom:12px">Duration of each admin operation: score_question RPC, response count fetch, leaderboard fetch, player stats fetch. These simulate the real admin.html actions.</p>
      <div class="chart-container">${scoringBarSvg}</div>
    </div>
  </div>

  <!-- ── Tab: Realtime ── -->
  <div id="tab-realtime" class="tab-content">
    <div class="section">
      <h2>Realtime Propagation Latency</h2>
      <p style="color:#64748b;font-size:12px;margin-bottom:12px">Time from admin's game_status UPDATE to player receiving the event via Supabase Realtime WebSocket. Measured per-player per state change.</p>
      <div class="percentile-grid">
        <div class="percentile-card"><div class="p-label">Total Events</div><div class="p-value">${timing.realtimeLags.length}</div></div>
        <div class="percentile-card"><div class="p-label">p50</div><div class="p-value">${timing.realtimeLags.length > 0 ? fmtMs(percentile(timing.realtimeLags, 50)) : '-'}</div></div>
        <div class="percentile-card"><div class="p-label">p90</div><div class="p-value">${timing.realtimeLags.length > 0 ? fmtMs(percentile(timing.realtimeLags, 90)) : '-'}</div></div>
        <div class="percentile-card"><div class="p-label">p95</div><div class="p-value">${timing.realtimeLags.length > 0 ? fmtMs(percentile(timing.realtimeLags, 95)) : '-'}</div></div>
        <div class="percentile-card"><div class="p-label">p99</div><div class="p-value">${timing.realtimeLags.length > 0 ? fmtMs(percentile(timing.realtimeLags, 99)) : '-'}</div></div>
        <div class="percentile-card"><div class="p-label">Max</div><div class="p-value">${timing.realtimeLags.length > 0 ? fmtMs(Math.max(...timing.realtimeLags)) : '-'}</div></div>
      </div>
      ${rtHistSvg ? `<div class="chart-container" style="margin-top:16px">${rtHistSvg}</div>` : '<p style="color:#64748b;margin-top:12px">No realtime events recorded.</p>'}
    </div>
  </div>

  <!-- ── Tab: Operations ── -->
  <div id="tab-operations" class="tab-content">
    <div class="section">
      <h2>All Operations Breakdown</h2>
      <p style="color:#64748b;font-size:12px;margin-bottom:12px">Every Supabase API call, grouped by operation type.</p>
      <table>
        <thead>
          <tr><th>Operation</th><th>Count</th><th>Avg</th><th>p50</th><th>p95</th><th>Max</th><th>Failures</th></tr>
        </thead>
        <tbody>${stepRows}</tbody>
      </table>
    </div>
  </div>

  <!-- ── Tab: Players ── -->
  <div id="tab-players" class="tab-content">
    <div class="section">
      <h2>Player Details <span style="font-size:12px;color:#64748b;font-weight:normal">(click row to expand)</span></h2>
      <div class="filter-bar">
        <label style="color:#94a3b8;font-size:12px">Filter:</label>
        <input type="text" id="playerFilter" placeholder="Search player..." oninput="filterPlayers()">
        <select id="playerStatusFilter" onchange="filterPlayers()">
          <option value="all">All</option>
          <option value="failed">Has Failures</option>
          <option value="ok">All OK</option>
        </select>
      </div>
      <div style="max-height:600px;overflow:auto">
      <table id="playerTable">
        <thead>
          <tr><th>Player</th><th>Join</th><th>Join Time</th><th>Answered</th><th>Skipped</th><th>Failed</th><th>Avg API</th><th>Max API</th></tr>
        </thead>
        <tbody>${playerRows}</tbody>
      </table>
      </div>
    </div>
  </div>

  <!-- ── Tab: Errors ── -->
  <div id="tab-errors" class="tab-content">
    ${stats.errors.length > 0 ? `
    <div class="section error-section">
      <h2>Errors (${stats.errors.length})</h2>
      <table>
        <thead><tr><th style="width:50px">#</th><th>Detail</th></tr></thead>
        <tbody>${errorRows}</tbody>
      </table>
    </div>` : `
    <div class="section">
      <h2>Errors</h2>
      <p style="color:#34d399;font-weight:600">No errors recorded.</p>
    </div>`}
  </div>

</div>

<div class="footer">
  Generated by quiz-game E2E Load Test &nbsp;|&nbsp; ${startTimeStr} &nbsp;|&nbsp; ${NUM_PLAYERS} players × ${questions.length} questions
</div>

<script>
  // Tab switching
  function showTab(id) {
    document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));
    document.getElementById('tab-' + id).classList.add('active');
    event.target.classList.add('active');
  }

  // Toggle player detail rows
  document.querySelectorAll('.player-row').forEach(row => {
    row.addEventListener('click', () => {
      row.classList.toggle('expanded');
      const detail = row.nextElementSibling;
      if (detail && detail.classList.contains('detail-row')) {
        detail.classList.toggle('show');
      }
    });
  });

  // Filter players
  function filterPlayers() {
    const text = document.getElementById('playerFilter').value.toLowerCase();
    const status = document.getElementById('playerStatusFilter').value;
    document.querySelectorAll('#playerTable tbody .player-row').forEach(row => {
      const name = row.getAttribute('data-player').toLowerCase();
      const failCount = parseInt(row.children[5].textContent) || 0;
      const joinFailed = row.children[1].classList.contains('fail');
      let show = name.includes(text);
      if (status === 'failed') show = show && (failCount > 0 || joinFailed);
      if (status === 'ok') show = show && failCount === 0 && !joinFailed;
      row.style.display = show ? '' : 'none';
      const detail = row.nextElementSibling;
      if (detail && detail.classList.contains('detail-row') && !show) detail.classList.remove('show');
    });
  }
</script>

</body>
</html>`;

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = join(__dirname, `test-report-${timestamp}.html`);
  writeFileSync(filename, html, 'utf-8');
  console.log(`\n  HTML report saved: ${filename}`);
  return filename;
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n========== E2E Load Test: 100 Players + Admin (Detailed Timing) ==========\n');

  timing.testStartMs = Date.now();

  // ══════════════════════════════════════════════════════════════════════════════
  // Phase 0: Setup
  // ══════════════════════════════════════════════════════════════════════════════
  phaseStart('0-setup');
  console.log('[Phase 0] Initializing...');
  await adminLogin();
  await cleanTestData();
  const questions = await fetchQuestions();
  const qrToken = await fetchQrToken();
  console.log(`  QR token loaded.`);
  phaseEnd('0-setup');

  // ══════════════════════════════════════════════════════════════════════════════
  // Phase 1: Players join
  // ══════════════════════════════════════════════════════════════════════════════
  phaseStart('1-player-join');
  console.log(`\n[Phase 1] ${NUM_PLAYERS} players joining...`);
  const players = Array.from({ length: NUM_PLAYERS }, (_, i) => createPlayer(i + 1, qrToken));

  const joinT0 = now();
  const joinResults = await Promise.all(players.map(p => p.join()));
  const joinDur = now() - joinT0;
  recordStep('join', 'all-players-join', `${NUM_PLAYERS} concurrent`, joinDur);

  const activePlayers = players.filter((_, i) => joinResults[i]);
  console.log(`  ${activePlayers.length} players joined (total: ${fmtMs(joinDur)})`);

  // Per-player join time distribution
  const joinTimes = Object.values(stats.playerLogs).filter(l => l.joinSuccess).map(l => l.joinTimeMs);
  if (joinTimes.length > 0) {
    console.log(`  Join time: p50=${fmtMs(percentile(joinTimes, 50))}, p95=${fmtMs(percentile(joinTimes, 95))}, max=${fmtMs(Math.max(...joinTimes))}`);
  }

  // Subscribe all active players to realtime
  const stateCallbacks = [];
  for (const p of activePlayers) {
    p.subscribe((playerName, state, receivedAt) => {
      // This callback fires for every realtime event received by every player
    });
  }
  await sleep(2000);
  console.log('  All players subscribed to realtime.');
  phaseEnd('1-player-join');

  // ══════════════════════════════════════════════════════════════════════════════
  // Phase 2: Question loop
  // ══════════════════════════════════════════════════════════════════════════════
  phaseStart('2-question-loop');
  for (let qi = 0; qi < questions.length; qi++) {
    const q = questions[qi];
    const qNum = qi + 1;
    initQStats(q.id);
    const qs = stats.perQuestion[q.id];
    const phaseName = `2-Q${qNum}`;
    phaseStart(phaseName);

    console.log(`\n[Q${qNum}/${questions.length}] id=${q.id}: ${(q.question || '').slice(0, 40)}...`);

    // ── Step 1: Admin -> playing ──
    console.log('  [1] Admin -> playing');
    const playResult = await updateGameStatus('playing', q.id);
    qs.stateTransitions['playing'] = playResult.durationMs;

    // Measure realtime propagation for "playing"
    const playingLags = await measureRealtimePropagation(activePlayers, playResult.sentAt, 5000);
    qs.realtimePropagation.push(...playingLags);
    timing.realtimeLags.push(...playingLags);
    if (playingLags.length > 0) {
      console.log(`  [1] Realtime propagation: ${playingLags.length} received, p50=${fmtMs(percentile(playingLags, 50))}, p95=${fmtMs(percentile(playingLags, 95))}`);
    }

    // Wait for propagation to settle
    await sleep(500);

    // ── Step 2: Players answer concurrently ──
    console.log('  [2] Players answering...');
    const answerT0 = now();
    await Promise.all(activePlayers.map(p => p.answer(q.id)));
    const answerDur = now() - answerT0;
    recordStep('question', 'all-players-answer', `q=${q.id}`, answerDur);
    console.log(`  [2] All answers submitted (${fmtMs(answerDur)})`);

    // ── Step 3: Wait remaining countdown ──
    // In real game admin waits 15s. We already spent thinkTime, so wait a bit more.
    const remainWait = Math.max(1000, 15000 - answerDur);
    console.log(`  [3] Waiting ${(remainWait / 1000).toFixed(1)}s for countdown...`);
    await sleep(remainWait);

    // ── Step 4: Admin -> stopped ──
    console.log('  [4] Admin -> stopped');
    const stopResult = await updateGameStatus('stopped');
    qs.stateTransitions['stopped'] = stopResult.durationMs;
    await sleep(1000);

    // ── Step 5: Admin -> revealed (fetch response counts like admin.html) ──
    console.log('  [5] Admin -> revealed');
    const revealResult = await updateGameStatus('revealed');
    qs.stateTransitions['revealed'] = revealResult.durationMs;

    // Measure realtime for "revealed"
    const revealLags = await measureRealtimePropagation(activePlayers, revealResult.sentAt, 5000);
    qs.realtimePropagation.push(...revealLags);
    timing.realtimeLags.push(...revealLags);

    // Fetch response counts (like admin.html does)
    const respCounts = await fetchResponseCounts(q.id);
    qs.responseCountFetchMs = respCounts.durationMs;
    console.log(`  [5] Response counts: total=${respCounts.total}, fetch=${fmtMs(respCounts.durationMs)}`);

    await sleep(2000);

    // ── Step 6: Admin scores via RPC (settlement) ──
    console.log('  [6] Scoring (settlement)...');
    const correctAnswer = q.answer || 1;
    const scoreResult = await adminScoreViaRPC(q.id, correctAnswer);
    qs.scoringMs = scoreResult.durationMs;
    console.log(`  [6] score_question RPC: ${fmtMs(scoreResult.durationMs)}, correct=${scoreResult.correctCount}`);

    // ── Step 7: Admin -> scoring ──
    console.log('  [7] Admin -> scoring');
    const scoringResult = await updateGameStatus('scoring');
    qs.stateTransitions['scoring'] = scoringResult.durationMs;

    // Measure realtime for "scoring"
    const scoringLags = await measureRealtimePropagation(activePlayers, scoringResult.sentAt, 5000);
    qs.realtimePropagation.push(...scoringLags);
    timing.realtimeLags.push(...scoringLags);

    // ── Step 8: Players fetch their own score (like scoring-ui) ──
    console.log('  [8] Players fetching scores...');
    const scoreFetchT0 = now();
    // Sample 10 players for score fetch (to avoid flooding)
    const samplePlayers = activePlayers.filter((_, i) => i % 10 === 0);
    const scoreFetches = await Promise.all(samplePlayers.map(p => p.fetchMyScore(q.id)));
    const scoreFetchDur = now() - scoreFetchT0;
    const scoreFetchTimes = scoreFetches.map(r => r.durationMs);
    recordStep('player', 'fetch-score', `q=${q.id}, sample=${samplePlayers.length}`, scoreFetchDur);
    console.log(`  [8] Score fetch (${samplePlayers.length} players): p50=${fmtMs(percentile(scoreFetchTimes, 50))}, max=${fmtMs(Math.max(...scoreFetchTimes))}`);

    // ── Step 9: Admin fetches leaderboard ──
    console.log('  [9] Admin fetching leaderboard...');
    const lb = await fetchLeaderboard();
    qs.leaderboardFetchMs = lb.durationMs;
    console.log(`  [9] Leaderboard: ${lb.players.length} players, ${fmtMs(lb.durationMs)}`);

    await sleep(2000);

    // ── Step 10: Move to next question ──
    if (qi < questions.length - 1) {
      const nextQ = questions[qi + 1];
      console.log(`  [10] Admin -> waiting (next q=${nextQ.id})`);
      const waitResult = await updateGameStatus('waiting', nextQ.id);
      qs.stateTransitions['waiting'] = waitResult.durationMs;
      await sleep(1000);
    }

    console.log(`  Done: ${qs.submitted} submitted, ${qs.succeeded} ok, ${qs.failed} fail, ${qs.skipped} skip`);
    phaseEnd(phaseName);
  }
  phaseEnd('2-question-loop');

  // ══════════════════════════════════════════════════════════════════════════════
  // Phase 3: End game
  // ══════════════════════════════════════════════════════════════════════════════
  phaseStart('3-end-game');
  console.log('\n[Phase 3] Ending game...');

  // Admin -> ended
  const endResult = await updateGameStatus('ended');
  console.log(`  state->ended: ${fmtMs(endResult.durationMs)}`);

  // Measure realtime for "ended"
  const endLags = await measureRealtimePropagation(activePlayers, endResult.sentAt, 5000);
  timing.realtimeLags.push(...endLags);
  if (endLags.length > 0) {
    console.log(`  Realtime propagation: ${endLags.length} received, p50=${fmtMs(percentile(endLags, 50))}`);
  }

  // Players fetch final leaderboard (like end-ui)
  console.log('  Players fetching final leaderboard...');
  const endFetchT0 = now();
  const sampleEnd = activePlayers.filter((_, i) => i % 10 === 0);
  const endFetches = await Promise.all(sampleEnd.map(p => p.fetchEndLeaderboard()));
  const endFetchDur = now() - endFetchT0;
  const endFetchTimes = endFetches.map(r => r.durationMs);
  recordStep('player', 'fetch-end-leaderboard', `sample=${sampleEnd.length}`, endFetchDur);
  console.log(`  End leaderboard fetch (${sampleEnd.length} players): p50=${fmtMs(percentile(endFetchTimes, 50))}, max=${fmtMs(Math.max(...endFetchTimes))}`);

  // Admin fetches final leaderboard + player stats (for PDF export)
  const finalLb = await fetchLeaderboard();
  console.log(`  Admin final leaderboard: ${fmtMs(finalLb.durationMs)}`);
  const playerStats = await fetchPlayerStats();
  console.log(`  Admin player stats (PDF export): ${fmtMs(playerStats.durationMs)}`);

  phaseEnd('3-end-game');

  // ══════════════════════════════════════════════════════════════════════════════
  // Phase 4: Cleanup
  // ══════════════════════════════════════════════════════════════════════════════
  phaseStart('4-cleanup');
  console.log('\n[Phase 4] Cleaning up...');
  await Promise.all(activePlayers.map(p => p.cleanup()));
  console.log(`  ${activePlayers.length} player connections closed.`);
  phaseEnd('4-cleanup');

  timing.testEndMs = Date.now();

  // Print console report
  printReport(questions);

  // Generate HTML report
  generateHtmlReport(questions);

  console.log('\nLoad test complete.\n');
  process.exit(0);
}

main().catch(err => {
  console.error('\nFATAL:', err);
  process.exit(1);
});
