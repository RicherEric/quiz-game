/**
 * E2E Load Test: 100 Concurrent Players + 1 Admin
 *
 * Simulates a complete quiz game session with detailed timing:
 * - 1 admin controls the game flow (state transitions + scoring via RPC)
 * - 100 players join, listen for state changes via Realtime, and submit answers
 * - Measures every step: join, realtime propagation, answer submission,
 *   scoring RPC, leaderboard fetch, state transitions
 * - Generates an HTML report with SVG timeline & bar charts
 * - Opens a player browser (stays open) and admin browser (real-time monitoring)
 *
 * Usage: node load-test.mjs
 */

import { createClient } from '@supabase/supabase-js';
import { writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';
import { createServer } from 'node:http';
import { chromium } from 'playwright';

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

const SITE_URL = (process.env.SITE_URL || '').replace(/\/+$/, '');

if (!SUPABASE_URL || !SUPABASE_KEY || !ADMIN_PASSWORD) {
  console.error('Missing required env vars: SUPABASE_URL, SUPABASE_KEY, ADMIN_PASSWORD');
  console.error('Create a .env file in the e2e-test/ directory. See .env.example');
  process.exit(1);
}

const NUM_PLAYERS = 100;
const ANSWER_TIMEOUT_MS = 30000;  // Admin waits up to 30s for all players to answer

let gameMode = 'official';  // will be set from game_status.mode at runtime

// ─── Browser Monitoring ───────────────────────────────────────────────────────

let httpServer = null;
let serverPort = 0;
let userBrowser = null;
let adminBrowser = null;
let adminPage = null;  // Playwright page for admin browser automation
let userPage = null;   // Playwright page for test_viewer browser

function startHttpServer() {
  return new Promise((resolve) => {
    const projectRoot = join(__dirname, '..');
    const mimeTypes = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.svg': 'image/svg+xml',
      '.json': 'application/json',
      '.ico': 'image/x-icon',
      '.woff': 'font/woff',
      '.woff2': 'font/woff2',
    };

    httpServer = createServer((req, res) => {
      const urlPath = decodeURIComponent(req.url.split('?')[0]);
      let filePath = join(projectRoot, urlPath === '/' ? 'index.html' : urlPath);
      if (existsSync(filePath) && statSync(filePath).isDirectory()) {
        filePath = join(filePath, 'index.html');
      }
      if (!existsSync(filePath)) {
        res.writeHead(404);
        res.end('Not Found');
        return;
      }
      const ext = extname(filePath).toLowerCase();
      const contentType = mimeTypes[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(readFileSync(filePath));
    });

    httpServer.listen(0, () => {
      serverPort = httpServer.address().port;
      console.log(`  Local HTTP server on http://localhost:${serverPort}`);
      resolve(serverPort);
    });
  });
}

async function launchBrowsers(qrToken) {
  let baseUrl;
  if (SITE_URL) {
    baseUrl = SITE_URL;
    console.log(`  Using remote site: ${baseUrl}`);
  } else {
    const port = await startHttpServer();
    baseUrl = `http://localhost:${port}`;
  }

  // ── User browser: mobile viewport, stays open throughout ──
  userBrowser = await chromium.launch({ headless: false });
  const userCtx = await userBrowser.newContext({
    viewport: { width: 390, height: 844 },
  });
  userPage = await userCtx.newPage();
  await userPage.goto(`${baseUrl}/index.html?token=${qrToken}`);
  await userPage.fill('#p-name', 'test_viewer');
  await userPage.click('button[onclick="join()"]');
  await userPage.waitForSelector('#waiting-ui:not(.hidden)', { timeout: 10000 });
  console.log('  User browser opened (test_viewer joined)');

  // ── Admin browser: desktop viewport, real-time monitoring ──
  adminBrowser = await chromium.launch({ headless: false });
  const adminCtx = await adminBrowser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  adminPage = await adminCtx.newPage();
  await adminPage.goto(`${baseUrl}/admin.html`);
  await adminPage.fill('#login-username', ADMIN_USERNAME);
  await adminPage.fill('#login-password', ADMIN_PASSWORD);
  await adminPage.click('button[onclick="doLogin()"]');
  await adminPage.waitForSelector('#admin-panel:not(.hidden)', { timeout: 10000 });
  console.log('  Admin browser opened (logged in)');
}

async function closeBrowsers() {
  if (userBrowser) { try { await userBrowser.close(); } catch {} }
  if (adminBrowser) { try { await adminBrowser.close(); } catch {} }
  if (httpServer) { httpServer.close(); }
}

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

function stdDev(arr) {
  if (arr.length < 2) return 0;
  const mean = arr.reduce((s, v) => s + v, 0) / arr.length;
  const variance = arr.reduce((s, v) => s + (v - mean) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(variance);
}

function throughput(count, durationMs) {
  if (durationMs <= 0) return 0;
  return count / (durationMs / 1000);
}

async function staggeredAll(tasks, batchSize = 10, delayMs = 50) {
  const results = new Array(tasks.length);
  for (let i = 0; i < tasks.length; i += batchSize) {
    const batch = tasks.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(fn => fn()));
    for (let j = 0; j < batchResults.length; j++) {
      results[i + j] = batchResults[j];
    }
    if (i + batchSize < tasks.length) await sleep(delayMs);
  }
  return results;
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

// ─── Admin Browser Automation ────────────────────────────────────────────────
// Drive the admin UI via Playwright clicks so the dashboard reflects real-time data

async function adminSelectQuestion(questionId) {
  // Wait for the dropdown to be populated with actual question options (not placeholder)
  await adminPage.waitForFunction(
    (qId) => {
      const sel = document.getElementById('q-selector');
      if (!sel) return false;
      // Check that the specific question option exists
      return Array.from(sel.options).some(o => o.value === String(qId));
    },
    questionId,
    { timeout: 15000 }
  );
  await adminPage.selectOption('#q-selector', String(questionId));
  await sleep(300);
}

async function adminClickStart() {
  const sentAt = Date.now();
  const t0 = now();
  await adminPage.click('#btn-start');
  await adminPage.waitForFunction(
    () => document.getElementById('current-state-label')?.innerText?.includes('Playing'),
    { timeout: 10000 }
  );
  const dur = now() - t0;
  recordStep('admin-browser', 'click-start', '', dur);
  return { durationMs: dur, sentAt };
}

async function adminClickStop() {
  adminPage.once('dialog', dialog => dialog.accept());
  const sentAt = Date.now();
  const t0 = now();
  await adminPage.click('#btn-stop');
  await adminPage.waitForFunction(
    () => document.getElementById('current-state-label')?.innerText?.includes('Stopped'),
    { timeout: 10000 }
  );
  const dur = now() - t0;
  recordStep('admin-browser', 'click-stop', '', dur);
  return { durationMs: dur, sentAt };
}

async function adminClickReveal() {
  const sentAt = Date.now();
  const t0 = now();
  await adminPage.click('#btn-reveal');
  await adminPage.waitForFunction(
    () => document.getElementById('current-state-label')?.innerText?.includes('Revealed'),
    { timeout: 10000 }
  );
  const dur = now() - t0;
  recordStep('admin-browser', 'click-reveal', '', dur);
  return { durationMs: dur, sentAt };
}

async function adminClickScore() {
  const sentAt = Date.now();
  const t0 = now();
  await adminPage.click('#btn-score');
  await adminPage.waitForFunction(
    () => document.getElementById('current-state-label')?.innerText?.includes('Scoring'),
    { timeout: 30000 }
  );
  const dur = now() - t0;
  recordStep('admin-browser', 'click-score', '', dur);
  return { durationMs: dur, sentAt };
}

async function adminClickNext() {
  const sentAt = Date.now();
  const t0 = now();
  await adminPage.click('#btn-next');
  await adminPage.waitForFunction(
    () => document.getElementById('current-state-label')?.innerText?.includes('Waiting'),
    { timeout: 10000 }
  );
  const dur = now() - t0;
  recordStep('admin-browser', 'click-next', '', dur);
  return { durationMs: dur, sentAt };
}

async function adminClickEnd() {
  adminPage.on('dialog', dialog => dialog.dismiss());
  const sentAt = Date.now();
  const t0 = now();
  await adminPage.click('#btn-end');
  await adminPage.waitForFunction(
    () => document.getElementById('current-state-label')?.innerText?.includes('Ended'),
    { timeout: 10000 }
  );
  const dur = now() - t0;
  adminPage.removeAllListeners('dialog');
  recordStep('admin-browser', 'click-end', '', dur);
  return { durationMs: dur, sentAt };
}

// ─── Per-Question Stats ────────────────────────────────────────────────────────

const stats = {
  playersCreated: 0,
  playersFailed: 0,
  errors: [],
  perQuestion: {},
  playerLogs: {},
  edgeCases: [],       // { name, description, expected, actual, pass }
  dataIntegrity: [],   // { check, detail, pass }
  passFail: [],        // { criterion, threshold, actual, pass }
  playerFetchTimes: [],    // individual player fetch durations (ms)

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
      viewerScoringDelayMs: null,  // test_viewer scoring UI delay
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

async function fetchGameMode() {
  const { data } = await admin.from('game_status').select('mode').eq('id', 1).single();
  return data?.mode || 'official';
}

async function fetchQuestions() {
  const t0 = now();
  // Read game mode to filter questions the same way admin.html does:
  // admin.html uses (q.type || 'official') === currentMode
  gameMode = await fetchGameMode();
  let query = admin.from('questions').select('*');
  if (gameMode === 'official') {
    // Match type='official' OR type IS NULL (admin.html defaults null to 'official')
    query = query.or('type.eq.official,type.is.null');
  } else {
    query = query.eq('type', gameMode);
  }
  const { data, error } = await query
    .order('sort_order', { ascending: true })
    .order('id', { ascending: true });
  const dur = now() - t0;
  recordStep('setup', 'fetch-questions', `${data?.length || 0} ${gameMode} questions`, dur, !error && !!data);
  if (error) throw new Error(`Failed to fetch questions: ${error.message}`);
  if (!data || data.length === 0) throw new Error(`No questions found for mode "${gameMode}".`);
  console.log(`  ${data.length} questions loaded (mode=${gameMode}, ${fmtMs(dur)})`);
  return data;
}

async function updateGameStatus(state, currentQId) {
  const payload = { state, start_time: Date.now() };
  if (currentQId !== undefined) payload.current_q_id = currentQId;

  const sentAt = Date.now();  // capture BEFORE update for accurate realtime lag
  const t0 = now();
  const { error } = await admin.from('game_status').update(payload).eq('id', 1);
  const dur = now() - t0;
  const detail = currentQId !== undefined ? `q=${currentQId}` : '';
  recordStep('admin', `state->${state}`, detail, dur, !error);
  if (error) recordError(`update-game-status(${state})`, error);
  return { durationMs: dur, sentAt };
}

/**
 * Score a question using the same RPC the real admin uses.
 */
async function adminScoreViaRPC(questionId, correctAnswer) {
  const t0 = now();
  const { data, error } = await admin.rpc('score_question', {
    p_question_id: questionId,
    p_correct_answer: correctAnswer,
    p_mode: gameMode,
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
  const { data, error } = await admin.rpc('get_response_counts', { p_question_id: questionId });
  const dur = now() - t0;
  recordStep('admin', 'fetch-response-counts', `q=${questionId}`, dur, !error);
  const counts = { 1: 0, 2: 0, 3: 0, 4: 0 };
  if (data) Object.entries(data).forEach(([k, v]) => { const key = parseInt(k); if (counts[key] !== undefined) counts[key] = v; });
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return { durationMs: dur, counts, total };
}

/**
 * Fetch leaderboard (like admin.html leaderboard tab).
 */
async function fetchLeaderboard() {
  const t0 = now();
  const scoreField = gameMode === 'test' ? 'test_score' : 'score';
  const { data, error } = await admin.from('players').select('*').order(scoreField, { ascending: false });
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
     * Returns a Promise that resolves when subscription is confirmed (SUBSCRIBED),
     * or rejects after timeoutMs.
     */
    subscribe(onStateChange, timeoutMs = 15000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`Realtime subscribe timeout for player-${name}`));
        }, timeoutMs);

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
          .subscribe((status) => {
            if (status === 'SUBSCRIBED') {
              clearTimeout(timer);
              resolve(true);
            } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
              clearTimeout(timer);
              reject(new Error(`Realtime subscribe failed for player-${name}: ${status}`));
            }
          });
      });
    },

    isSubscribed() {
      return channel && channel.state === 'joined';
    },

    getLastStateReceivedAt() {
      return lastStateReceivedAt;
    },

    async answer(questionId) {
      initQStats(questionId);
      const qs = stats.perQuestion[questionId];

      // All players answer (no random skip)


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
      const { data } = await client.rpc('get_my_score', {
        p_player_name: name, p_question_id: questionId, p_mode: gameMode
      });
      const dur = now() - t0;
      return { durationMs: dur, questionScore: data?.question_score || 0, totalScore: data?.total_score || 0 };
    },

    /**
     * Fetch final leaderboard (like end-ui in index.html).
     */
    async fetchEndLeaderboard() {
      const t0 = now();
      const scoreField = gameMode === 'test' ? 'test_score' : 'score';
      const { data } = await client.from('players').select('*').order(scoreField, { ascending: false });
      const dur = now() - t0;
      const rank = data ? data.findIndex(p => p.name === name) + 1 : -1;
      return { durationMs: dur, rank, total: data?.length || 0 };
    },

    async cleanup() {
      if (channel) await client.removeChannel(channel);
    },
  };
}

// ─── Edge Case Tests ──────────────────────────────────────────────────────────

/**
 * Run edge-case tests to verify the system rejects invalid operations.
 * Each test records pass/fail into stats.edgeCases.
 */
async function runEdgeCaseTests(qrToken, questions) {
  console.log('\n[Phase 1.5] Edge case tests...');
  phaseStart('1.5-edge-cases');

  const edgeClient = newClient();
  const testName = `test_user_001`;     // already exists from Phase 1
  const testName2 = `test_edge_dup_${Date.now()}`;

  // ── Test 1: Duplicate player name rejection ──
  {
    const t0 = now();
    const { data, error } = await edgeClient.rpc('join_via_qr', {
      qr_token: qrToken,
      player_name: testName,
    });
    const dur = now() - t0;
    const pass = !!error;
    stats.edgeCases.push({
      name: 'duplicate-player-name',
      description: '重複暱稱應被拒絕',
      expected: 'error (此暱稱已存在)',
      actual: error ? `rejected: ${error.message}` : `allowed (unexpected!)`,
      pass,
    });
    recordStep('edge-case', 'duplicate-player-name', '', dur, pass);
    console.log(`  [EC1] Duplicate name: ${pass ? 'PASS' : 'FAIL'} (${fmtMs(dur)})`);
  }

  // ── Test 2: Invalid QR token rejection ──
  {
    const fakeName = `test_edge_badqr_${Date.now()}`;
    const t0 = now();
    const { data, error } = await edgeClient.rpc('join_via_qr', {
      qr_token: 'invalid-token-12345',
      player_name: fakeName,
    });
    const dur = now() - t0;
    const pass = !!error;
    stats.edgeCases.push({
      name: 'invalid-qr-token',
      description: '無效 QR token 應被拒絕',
      expected: 'error (Invalid QR token)',
      actual: error ? `rejected: ${error.message}` : `allowed (unexpected!)`,
      pass,
    });
    recordStep('edge-case', 'invalid-qr-token', '', dur, pass);
    console.log(`  [EC2] Invalid QR token: ${pass ? 'PASS' : 'FAIL'} (${fmtMs(dur)})`);
    // Clean up in case it was wrongly created
    if (!error) await admin.from('players').delete().eq('name', fakeName);
  }

  // ── Test 3: Submit with invalid QR token ──
  {
    const q = questions[0];
    const t0 = now();
    const { data, error } = await edgeClient.rpc('submit_response', {
      p_player_name: testName,
      p_question_id: q.id,
      p_choice: 1,
      p_response_time_ms: 5000,
      p_qr_token: 'invalid-token-12345',
    });
    const dur = now() - t0;
    const pass = !!error;
    stats.edgeCases.push({
      name: 'submit-invalid-qr',
      description: '用無效 QR token 提交答案應被拒絕',
      expected: 'error (Not a verified player)',
      actual: error ? `rejected: ${error.message}` : `allowed (unexpected!)`,
      pass,
    });
    recordStep('edge-case', 'submit-invalid-qr', '', dur, pass);
    console.log(`  [EC3] Submit with bad QR: ${pass ? 'PASS' : 'FAIL'} (${fmtMs(dur)})`);
  }

  // ── Test 4: Submit with null QR token ──
  {
    const q = questions[0];
    const t0 = now();
    const { data, error } = await edgeClient.rpc('submit_response', {
      p_player_name: testName,
      p_question_id: q.id,
      p_choice: 1,
      p_response_time_ms: 5000,
      p_qr_token: null,
    });
    const dur = now() - t0;
    const pass = !!error;
    stats.edgeCases.push({
      name: 'submit-null-qr',
      description: '不帶 QR token 提交答案應被拒絕',
      expected: 'error (Not a verified player)',
      actual: error ? `rejected: ${error.message}` : `allowed (unexpected!)`,
      pass,
    });
    recordStep('edge-case', 'submit-null-qr', '', dur, pass);
    console.log(`  [EC4] Submit with null QR: ${pass ? 'PASS' : 'FAIL'} (${fmtMs(dur)})`);
  }

  // ── Test 5: Double answer submission (same player, same question) ──
  // First create a dedicated test player and submit once in the question loop,
  // then try to submit again. The DB allows duplicates (no unique constraint),
  // so we just verify the behavior is consistent.
  {
    const dupPlayer = `test_edge_dup_answer_${Date.now()}`;
    // Create player
    await edgeClient.rpc('join_via_qr', { qr_token: qrToken, player_name: dupPlayer });
    const q = questions[0];

    // First submission
    const { error: e1 } = await edgeClient.rpc('submit_response', {
      p_player_name: dupPlayer, p_question_id: q.id, p_choice: 1, p_response_time_ms: 3000, p_qr_token: qrToken,
    });

    // Second submission (same player, same question)
    const t0 = now();
    const { error: e2 } = await edgeClient.rpc('submit_response', {
      p_player_name: dupPlayer, p_question_id: q.id, p_choice: 2, p_response_time_ms: 5000, p_qr_token: qrToken,
    });
    const dur = now() - t0;

    // Check if duplicate was created
    const { data: dupCheck } = await edgeClient
      .from('responses')
      .select('id, choice')
      .eq('player_name', dupPlayer)
      .eq('question_id', q.id);
    const dupCount = dupCheck?.length || 0;

    // Record as informational: DB currently allows duplicates (no unique constraint)
    stats.edgeCases.push({
      name: 'double-answer-submission',
      description: '同一玩家同一題重複提交（DB 無唯一約束，記錄行為）',
      expected: `行為記錄 (responses count)`,
      actual: `${dupCount} responses created (e1=${e1 ? 'err' : 'ok'}, e2=${e2 ? 'err' : 'ok'})`,
      pass: true, // informational - just records actual behavior
    });
    recordStep('edge-case', 'double-answer', `q=${q.id}`, dur);
    console.log(`  [EC5] Double answer: ${dupCount} rows created (${fmtMs(dur)})`);

    // Clean up
    await admin.from('responses').delete().eq('player_name', dupPlayer);
    await admin.from('players').delete().eq('name', dupPlayer);
  }

  // ── Test 6: Submit to non-existent question ──
  {
    const t0 = now();
    const { data, error } = await edgeClient.rpc('submit_response', {
      p_player_name: testName,
      p_question_id: 999999,
      p_choice: 1,
      p_response_time_ms: 5000,
      p_qr_token: qrToken,
    });
    const dur = now() - t0;
    // This may or may not error (depends on FK constraints)
    stats.edgeCases.push({
      name: 'submit-nonexistent-question',
      description: '提交不存在的題目 ID',
      expected: '行為記錄',
      actual: error ? `rejected: ${error.message}` : `allowed (no FK constraint)`,
      pass: true, // informational
    });
    recordStep('edge-case', 'submit-nonexistent-question', '', dur);
    console.log(`  [EC6] Non-existent question: ${error ? 'rejected' : 'allowed'} (${fmtMs(dur)})`);
    // Clean up if it was inserted
    if (!error) await admin.from('responses').delete().eq('player_name', testName).eq('question_id', 999999);
  }

  // ── Test 7: Score non-existent question ──
  {
    const t0 = now();
    const { data, error } = await admin.rpc('score_question', {
      p_question_id: 999999,
      p_correct_answer: 1,
      p_mode: gameMode,
    });
    const dur = now() - t0;
    stats.edgeCases.push({
      name: 'score-nonexistent-question',
      description: '結算不存在的題目',
      expected: '行為記錄 (不應崩潰)',
      actual: error ? `error: ${error.message}` : `ok (correct_count=${data?.correct_count})`,
      pass: !error, // should not crash
    });
    recordStep('edge-case', 'score-nonexistent-question', '', dur, !error);
    console.log(`  [EC7] Score non-existent Q: ${error ? 'FAIL' : 'PASS'} (${fmtMs(dur)})`);
  }

  // ── Test 8: Late submission after stopped ──
  {
    const q = questions[1]; // use second question to avoid Q1 conflicts
    const latePlayer = testName; // test_user_001, already joined

    // Set up: play -> stopped
    await admin.from('game_status').update({ state: 'playing', current_q_id: q.id, start_time: Date.now() }).eq('id', 1);
    await sleep(500);
    await admin.from('game_status').update({ state: 'stopped', start_time: Date.now() }).eq('id', 1);
    await sleep(300);

    // Try late submission while in "stopped" state
    const t0 = now();
    const { data, error } = await edgeClient.rpc('submit_response', {
      p_player_name: latePlayer,
      p_question_id: q.id,
      p_choice: 1,
      p_response_time_ms: 16000,
      p_qr_token: qrToken,
    });
    const dur = now() - t0;

    stats.edgeCases.push({
      name: 'late-submission-after-stopped',
      description: '在 stopped 狀態後嘗試提交答案',
      expected: '行為記錄 (是否接受遲交)',
      actual: error ? `rejected: ${error.message}` : `allowed (late answer accepted)`,
      pass: true, // informational — records actual behavior
    });
    recordStep('edge-case', 'late-submission', `q=${q.id}`, dur);
    console.log(`  [EC8] Late submission: ${error ? 'rejected' : 'allowed'} (${fmtMs(dur)})`);

    // Clean up response if created
    if (!error) await admin.from('responses').delete().eq('player_name', latePlayer).eq('question_id', q.id);

    // Reset game state
    await admin.from('game_status').update({ state: 'waiting', current_q_id: questions[0].id, start_time: 0 }).eq('id', 1);
    await sleep(300);
  }

  // ── Test 9: Submit after question already scored ──
  {
    const q = questions[2]; // use third question
    const scoreTestPlayer = testName;

    // Set up: play -> stopped -> score -> scoring
    await admin.from('game_status').update({ state: 'playing', current_q_id: q.id, start_time: Date.now() }).eq('id', 1);
    await sleep(300);
    await admin.from('game_status').update({ state: 'stopped', start_time: Date.now() }).eq('id', 1);
    await sleep(300);

    // Score the question
    await admin.rpc('score_question', { p_question_id: q.id, p_correct_answer: q.answer || 1, p_mode: gameMode });
    await admin.from('game_status').update({ state: 'scoring', start_time: Date.now() }).eq('id', 1);
    await sleep(300);

    // Try submitting after scoring
    const t0 = now();
    const { data, error } = await edgeClient.rpc('submit_response', {
      p_player_name: scoreTestPlayer,
      p_question_id: q.id,
      p_choice: 2,
      p_response_time_ms: 5000,
      p_qr_token: qrToken,
    });
    const dur = now() - t0;

    stats.edgeCases.push({
      name: 'submit-after-scored',
      description: '在題目已結算後嘗試提交答案',
      expected: '行為記錄 (是否影響結算)',
      actual: error ? `rejected: ${error.message}` : `allowed (post-score submission)`,
      pass: true, // informational
    });
    recordStep('edge-case', 'submit-after-scored', `q=${q.id}`, dur);
    console.log(`  [EC9] Submit after scored: ${error ? 'rejected' : 'allowed'} (${fmtMs(dur)})`);

    // Clean up: remove any response created and reset
    await admin.from('responses').delete().eq('player_name', scoreTestPlayer).eq('question_id', q.id);
    // Reset all responses for this question (edge case scoring may have set scored_points)
    await admin.from('responses').delete().eq('question_id', q.id);
    // Reset player scores affected by edge case scoring
    await admin.from('players').update({ score: 0 }).like('name', 'test_%');
    await admin.from('game_status').update({ state: 'waiting', current_q_id: questions[0].id, start_time: 0 }).eq('id', 1);
    await sleep(300);
  }

  const passed = stats.edgeCases.filter(e => e.pass).length;
  const total = stats.edgeCases.length;
  console.log(`  Edge cases: ${passed}/${total} passed`);
  phaseEnd('1.5-edge-cases');
}

// ─── Data Integrity Validation ────────────────────────────────────────────────

/**
 * After all questions are scored, validate data integrity:
 * 1. is_correct flags match choice == answer
 * 2. scored_points follows the time bonus formula
 * 3. Player total scores == sum of their scored_points
 */
async function validateDataIntegrity(questions) {
  console.log('\n  [Data Integrity] Validating...');
  phaseStart('data-integrity');

  // Fetch all test responses (paginate to bypass Supabase default 1000-row limit)
  const allResponses = [];
  const PAGE_SIZE = 1000;
  let offset = 0;
  let fetchError = null;
  while (true) {
    const { data: page, error: re } = await admin
      .from('responses')
      .select('id, player_name, question_id, choice, is_correct, response_time_ms, scored_points')
      .like('player_name', 'test_%')
      .neq('player_name', 'test_viewer')
      .range(offset, offset + PAGE_SIZE - 1);
    if (re || !page) {
      fetchError = re;
      break;
    }
    allResponses.push(...page);
    if (page.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  if (fetchError || allResponses.length === 0) {
    stats.dataIntegrity.push({ check: 'fetch-responses', detail: fetchError?.message || 'no data', pass: false });
    console.log(`  ERROR: Failed to fetch responses: ${fetchError?.message}`);
    phaseEnd('data-integrity');
    return;
  }

  console.log(`  Fetched ${allResponses.length} test responses (${Math.ceil(allResponses.length / PAGE_SIZE)} pages)`);

  // Build question map: id -> { answer, points }
  const qMap = {};
  for (const q of questions) {
    qMap[q.id] = { answer: q.answer, points: q.points || 1000 };
  }

  // ── Check 1: is_correct flags ──
  let correctFlagErrors = 0;
  let correctFlagTotal = 0;
  for (const r of allResponses) {
    const q = qMap[r.question_id];
    if (!q) continue; // response to unknown question
    correctFlagTotal++;
    const expectedCorrect = r.choice === q.answer && r.choice !== 0;
    if (r.is_correct !== expectedCorrect) {
      correctFlagErrors++;
      if (correctFlagErrors <= 3) {
        console.log(`    is_correct mismatch: resp ${r.id}, player=${r.player_name}, q=${r.question_id}, choice=${r.choice}, answer=${q.answer}, is_correct=${r.is_correct}, expected=${expectedCorrect}`);
      }
    }
  }
  stats.dataIntegrity.push({
    check: 'is_correct flags',
    detail: `${correctFlagTotal - correctFlagErrors}/${correctFlagTotal} correct`,
    pass: correctFlagErrors === 0,
  });
  console.log(`  [DI1] is_correct flags: ${correctFlagErrors === 0 ? 'PASS' : 'FAIL'} (${correctFlagErrors} mismatches / ${correctFlagTotal})`);

  // ── Check 2: scored_points formula ──
  let scoreFormulaErrors = 0;
  let scoreFormulaTotal = 0;
  for (const r of allResponses) {
    const q = qMap[r.question_id];
    if (!q) continue;
    scoreFormulaTotal++;
    const isCorrect = r.choice === q.answer && r.choice !== 0;
    let expectedScore;
    if (isCorrect) {
      const responseTime = r.response_time_ms ?? 15000;
      expectedScore = Math.floor(q.points * (1 + Math.max(0, 15000 - responseTime) / 15000 * 0.75) + 0.5);
    } else {
      expectedScore = 0;
    }
    if (r.scored_points !== expectedScore) {
      scoreFormulaErrors++;
      if (scoreFormulaErrors <= 3) {
        console.log(`    scored_points mismatch: resp ${r.id}, player=${r.player_name}, q=${r.question_id}, actual=${r.scored_points}, expected=${expectedScore}, time=${r.response_time_ms}`);
      }
    }
  }
  stats.dataIntegrity.push({
    check: 'scored_points formula',
    detail: `${scoreFormulaTotal - scoreFormulaErrors}/${scoreFormulaTotal} correct`,
    pass: scoreFormulaErrors === 0,
  });
  console.log(`  [DI2] scored_points formula: ${scoreFormulaErrors === 0 ? 'PASS' : 'FAIL'} (${scoreFormulaErrors} mismatches / ${scoreFormulaTotal})`);

  // ── Check 3: Player total scores == sum of scored_points ──
  const scoreField = gameMode === 'test' ? 'test_score' : 'score';
  const { data: allPlayers, error: pe } = await admin
    .from('players')
    .select(`name, ${scoreField}`)
    .like('name', 'test_%')
    .neq('name', 'test_viewer');

  if (pe || !allPlayers) {
    stats.dataIntegrity.push({ check: 'player-total-scores', detail: pe?.message || 'no data', pass: false });
    phaseEnd('data-integrity');
    return;
  }

  // Compute expected score per player from responses
  const expectedScores = {};
  for (const r of allResponses) {
    if (!expectedScores[r.player_name]) expectedScores[r.player_name] = 0;
    expectedScores[r.player_name] += r.scored_points || 0;
  }

  let playerScoreErrors = 0;
  let playerScoreTotal = 0;
  for (const p of allPlayers) {
    playerScoreTotal++;
    const expected = expectedScores[p.name] || 0;
    const actual = p[scoreField] || 0;
    if (actual !== expected) {
      playerScoreErrors++;
      if (playerScoreErrors <= 3) {
        console.log(`    player score mismatch: ${p.name}, actual=${actual}, expected=${expected}`);
      }
    }
  }
  stats.dataIntegrity.push({
    check: 'player total scores = Σ scored_points',
    detail: `${playerScoreTotal - playerScoreErrors}/${playerScoreTotal} correct`,
    pass: playerScoreErrors === 0,
  });
  console.log(`  [DI3] Player total scores: ${playerScoreErrors === 0 ? 'PASS' : 'FAIL'} (${playerScoreErrors} mismatches / ${playerScoreTotal})`);

  // ── Check 4: No orphan responses (all player_names exist in players) ──
  const playerNameSet = new Set(allPlayers.map(p => p.name));
  const orphanResponses = allResponses.filter(r => !playerNameSet.has(r.player_name));
  stats.dataIntegrity.push({
    check: 'no orphan responses',
    detail: `${orphanResponses.length} orphan responses`,
    pass: orphanResponses.length === 0,
  });
  console.log(`  [DI4] Orphan responses: ${orphanResponses.length === 0 ? 'PASS' : 'FAIL'} (${orphanResponses.length} orphans)`);

  // ── Check 5: No duplicate responses (same player + question) ──
  const responseKeys = new Map();
  let duplicateCount = 0;
  for (const r of allResponses) {
    const key = `${r.player_name}|${r.question_id}`;
    const cnt = responseKeys.get(key) || 0;
    if (cnt > 0) {
      duplicateCount++;
      if (duplicateCount <= 3) {
        console.log(`    duplicate response: ${r.player_name}, q=${r.question_id} (${cnt + 1} copies)`);
      }
    }
    responseKeys.set(key, cnt + 1);
  }
  stats.dataIntegrity.push({
    check: 'no duplicate responses (player+question)',
    detail: duplicateCount === 0 ? '0 duplicates' : `${duplicateCount} duplicates found`,
    pass: duplicateCount === 0,
  });
  console.log(`  [DI5] Duplicate responses: ${duplicateCount === 0 ? 'PASS' : 'FAIL'} (${duplicateCount} duplicates)`);

  // ── Check 6: Response count per question within expected range ──
  // DB count should be between succeeded and submitted (inclusive), because
  // server may process requests that returned transport errors (e.g., 502)
  const responseCountByQ = {};
  for (const r of allResponses) {
    responseCountByQ[r.question_id] = (responseCountByQ[r.question_id] || 0) + 1;
  }
  let responseCountErrors = 0;
  for (const q of questions) {
    const qs = stats.perQuestion[q.id];
    if (!qs) continue;
    const dbCount = responseCountByQ[q.id] || 0;
    const minExpected = qs.succeeded;
    const maxExpected = qs.submitted;  // succeeded + failed
    if (dbCount < minExpected || dbCount > maxExpected) {
      responseCountErrors++;
      if (responseCountErrors <= 3) {
        console.log(`    response count out of range: q=${q.id}, DB=${dbCount}, expected=${minExpected}~${maxExpected}`);
      }
    }
  }
  stats.dataIntegrity.push({
    check: 'response count per question (range check)',
    detail: `${questions.length - responseCountErrors}/${questions.length} within range`,
    pass: responseCountErrors === 0,
  });
  console.log(`  [DI6] Response counts: ${responseCountErrors === 0 ? 'PASS' : 'FAIL'} (${responseCountErrors} out of range)`);

  const diPassed = stats.dataIntegrity.filter(d => d.pass).length;
  const diTotal = stats.dataIntegrity.length;
  console.log(`  Data integrity: ${diPassed}/${diTotal} checks passed`);
  phaseEnd('data-integrity');
}

// ─── Pass/Fail Criteria ─────────────────────────────────────────────────────

function evaluatePassFail(questions) {
  const allApiTimes = [];
  let totalSubmitted = 0, totalSucceeded = 0, totalFailed = 0;
  for (const q of questions) {
    const qs = stats.perQuestion[q.id];
    if (!qs) continue;
    allApiTimes.push(...qs.apiTimes);
    totalSubmitted += qs.submitted;
    totalSucceeded += qs.succeeded;
    totalFailed += qs.failed;
  }

  // Criterion 1: API p95 < 2s
  const apiP95 = allApiTimes.length > 0 ? percentile(allApiTimes, 95) : 0;
  stats.passFail.push({
    criterion: 'API p95 (submit_response) < 2000ms',
    threshold: '< 2000ms',
    actual: fmtMs(apiP95),
    pass: apiP95 < 2000,
  });

  // Criterion 2: API p99 < 5s
  const apiP99 = allApiTimes.length > 0 ? percentile(allApiTimes, 99) : 0;
  stats.passFail.push({
    criterion: 'API p99 (submit_response) < 5000ms',
    threshold: '< 5000ms',
    actual: fmtMs(apiP99),
    pass: apiP99 < 5000,
  });

  // Criterion 3: Realtime p95 < 3s
  const rtP95 = timing.realtimeLags.length > 0 ? percentile(timing.realtimeLags, 95) : 0;
  stats.passFail.push({
    criterion: 'Realtime propagation p95 < 3000ms',
    threshold: '< 3000ms',
    actual: timing.realtimeLags.length > 0 ? fmtMs(rtP95) : 'N/A',
    pass: timing.realtimeLags.length === 0 || rtP95 < 3000,
  });

  // Criterion 4: Join success rate >= 95%
  const joinRate = NUM_PLAYERS > 0 ? (stats.playersCreated / NUM_PLAYERS * 100) : 0;
  stats.passFail.push({
    criterion: 'Player join success rate >= 95%',
    threshold: '>= 95%',
    actual: `${joinRate.toFixed(1)}%`,
    pass: joinRate >= 95,
  });

  // Criterion 5: Answer success rate >= 95%
  const answerRate = totalSubmitted > 0 ? (totalSucceeded / totalSubmitted * 100) : 0;
  stats.passFail.push({
    criterion: 'Answer submission success rate >= 95%',
    threshold: '>= 95%',
    actual: `${answerRate.toFixed(1)}% (${totalSucceeded}/${totalSubmitted})`,
    pass: answerRate >= 95,
  });

  // Criterion 6: Data integrity all pass
  const diAllPass = stats.dataIntegrity.length > 0 && stats.dataIntegrity.every(d => d.pass);
  stats.passFail.push({
    criterion: 'Data integrity checks all pass',
    threshold: '100%',
    actual: `${stats.dataIntegrity.filter(d => d.pass).length}/${stats.dataIntegrity.length}`,
    pass: diAllPass,
  });

  // Criterion 7: Edge case critical tests pass
  const criticalEdgeCases = stats.edgeCases.filter(e =>
    ['duplicate-player-name', 'invalid-qr-token', 'submit-invalid-qr', 'submit-null-qr'].includes(e.name)
  );
  const ecAllPass = criticalEdgeCases.length > 0 && criticalEdgeCases.every(e => e.pass);
  stats.passFail.push({
    criterion: 'Critical edge case tests pass',
    threshold: '100%',
    actual: `${criticalEdgeCases.filter(e => e.pass).length}/${criticalEdgeCases.length}`,
    pass: ecAllPass,
  });

  // Criterion 8: Zero scoring RPC errors
  const scoringErrors = timing.steps.filter(s => s.step === 'score-question-rpc' && !s.success).length;
  stats.passFail.push({
    criterion: 'Zero scoring RPC errors',
    threshold: '0',
    actual: String(scoringErrors),
    pass: scoringErrors === 0,
  });

  // ── Admin & Player System Response Time Criteria ──

  // Criterion 9: Admin state transition p95 < 1000ms
  const stateTransitionTimes = timing.steps
    .filter(s => s.step.startsWith('state->'))
    .map(s => s.durationMs);
  const stP95 = stateTransitionTimes.length > 0 ? percentile(stateTransitionTimes, 95) : 0;
  stats.passFail.push({
    criterion: 'Admin state transition p95 < 1000ms',
    threshold: '< 1000ms',
    actual: stateTransitionTimes.length > 0 ? fmtMs(stP95) : 'N/A',
    pass: stateTransitionTimes.length === 0 || stP95 < 1000,
  });

  // Criterion 10: Scoring RPC p95 < 3000ms
  const scoringRpcTimes = timing.steps
    .filter(s => s.step === 'score-question-rpc')
    .map(s => s.durationMs);
  const scP95 = scoringRpcTimes.length > 0 ? percentile(scoringRpcTimes, 95) : 0;
  stats.passFail.push({
    criterion: 'Scoring RPC p95 < 3000ms',
    threshold: '< 3000ms',
    actual: scoringRpcTimes.length > 0 ? fmtMs(scP95) : 'N/A',
    pass: scoringRpcTimes.length === 0 || scP95 < 3000,
  });

  // Criterion 11: Admin fetch operations p95 < 2000ms
  const adminFetchTimes = timing.steps
    .filter(s => ['fetch-leaderboard', 'fetch-response-counts', 'fetch-player-stats'].includes(s.step))
    .map(s => s.durationMs);
  const afP95 = adminFetchTimes.length > 0 ? percentile(adminFetchTimes, 95) : 0;
  stats.passFail.push({
    criterion: 'Admin fetch operations p95 < 2000ms',
    threshold: '< 2000ms',
    actual: adminFetchTimes.length > 0 ? fmtMs(afP95) : 'N/A',
    pass: adminFetchTimes.length === 0 || afP95 < 2000,
  });

  // Criterion 12: Player fetch operations p95 < 2000ms
  const pfP95 = stats.playerFetchTimes.length > 0 ? percentile(stats.playerFetchTimes, 95) : 0;
  stats.passFail.push({
    criterion: 'Player fetch operations p95 < 2000ms',
    threshold: '< 2000ms',
    actual: stats.playerFetchTimes.length > 0 ? fmtMs(pfP95) : 'N/A',
    pass: stats.playerFetchTimes.length === 0 || pfP95 < 2000,
  });

  const passed = stats.passFail.filter(p => p.pass).length;
  const total = stats.passFail.length;
  const allPass = passed === total;

  console.log(`\n  PASS/FAIL: ${passed}/${total} criteria met — ${allPass ? 'ALL PASS' : 'SOME FAILED'}`);
  for (const pf of stats.passFail) {
    console.log(`    ${pf.pass ? 'PASS' : 'FAIL'}  ${pf.criterion}: ${pf.actual} (threshold: ${pf.threshold})`);
  }

  return allPass;
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

  let receivedCount = 0;
  let staleCount = 0;     // lastStateReceivedAt > 0 but < sentAt (received old event, not this one)
  let neverCount = 0;     // lastStateReceivedAt === 0 (never received any event)
  let subscribedCount = 0;

  for (const p of players) {
    if (p.isSubscribed()) subscribedCount++;
    const recv = p.getLastStateReceivedAt();
    if (recv >= sentAt) {
      lags.push(recv - sentAt);
      receivedCount++;
    } else if (recv > 0) {
      staleCount++;
    } else {
      neverCount++;
    }
  }

  // Diagnostic log when not all players received the event
  if (receivedCount < players.length) {
    console.log(`    [RT diag] ${receivedCount}/${players.length} received (subscribed: ${subscribedCount}, stale: ${staleCount}, never: ${neverCount})`);
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
    'API Avg'.padEnd(10) + 'API p95'.padEnd(10) + 'Score RPC'.padEnd(12) + 'RT Lag p50'
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
      fmtMs(qs.apiTimes.length > 0 ? qs.apiTimes.reduce((s, t) => s + t, 0) / qs.apiTimes.length : 0).padEnd(10) +
      fmtMs(percentile(qs.apiTimes, 95)).padEnd(10) +
      fmtMs(qs.scoringMs).padEnd(12) +
      (qs.viewerScoringDelayMs !== null ? fmtMs(qs.viewerScoringDelayMs) : '-').padEnd(14) +
      rtLagP50
    );
  }

  // Overall API timing
  console.log('\n  Overall API (submit_response) Distribution:');
  if (allApiTimes.length > 0) {
    const mean = allApiTimes.reduce((s, t) => s + t, 0) / allApiTimes.length;
    console.log(`    mean: ${fmtMs(mean)}`);
    console.log(`    σ:    ${fmtMs(stdDev(allApiTimes))}`);
    console.log(`    p50:  ${fmtMs(percentile(allApiTimes, 50))}`);
    console.log(`    p90:  ${fmtMs(percentile(allApiTimes, 90))}`);
    console.log(`    p95:  ${fmtMs(percentile(allApiTimes, 95))}`);
    console.log(`    p99:  ${fmtMs(percentile(allApiTimes, 99))}`);
    console.log(`    max:  ${fmtMs(Math.max(...allApiTimes))}`);
    console.log(`    throughput: ${throughput(allApiTimes.length, timing.testEndMs - timing.testStartMs).toFixed(1)} ops/sec`);
  }

  // Admin / System operation timing
  {
    const stTimes = timing.steps.filter(s => s.step.startsWith('state->')).map(s => s.durationMs);
    const scTimes = timing.steps.filter(s => s.step === 'score-question-rpc').map(s => s.durationMs);
    const afTimes = timing.steps.filter(s => ['fetch-leaderboard', 'fetch-response-counts', 'fetch-player-stats'].includes(s.step)).map(s => s.durationMs);
    const pfTimes = stats.playerFetchTimes;

    console.log('\n  System Operation Timing (Admin + Player):');
    if (stTimes.length > 0) console.log(`    State transitions:  p50=${fmtMs(percentile(stTimes, 50))}, p95=${fmtMs(percentile(stTimes, 95))}, max=${fmtMs(Math.max(...stTimes))}`);
    if (scTimes.length > 0) console.log(`    Scoring RPC:        p50=${fmtMs(percentile(scTimes, 50))}, p95=${fmtMs(percentile(scTimes, 95))}, max=${fmtMs(Math.max(...scTimes))}`);
    if (afTimes.length > 0) console.log(`    Admin fetch:        p50=${fmtMs(percentile(afTimes, 50))}, p95=${fmtMs(percentile(afTimes, 95))}, max=${fmtMs(Math.max(...afTimes))}`);
    if (pfTimes.length > 0) console.log(`    Player fetch:       p50=${fmtMs(percentile(pfTimes, 50))}, p95=${fmtMs(percentile(pfTimes, 95))}, max=${fmtMs(Math.max(...pfTimes))}`);
  }

  // Realtime propagation
  if (timing.realtimeLags.length > 0) {
    console.log('\n  Realtime Propagation Lag (all state changes):');
    console.log(`    p50:  ${fmtMs(percentile(timing.realtimeLags, 50))}`);
    console.log(`    p95:  ${fmtMs(percentile(timing.realtimeLags, 95))}`);
    console.log(`    max:  ${fmtMs(Math.max(...timing.realtimeLags))}`);
  }

  // Edge case results
  if (stats.edgeCases.length > 0) {
    console.log('\n  Edge Case Tests:');
    for (const ec of stats.edgeCases) {
      console.log(`    ${ec.pass ? 'PASS' : 'FAIL'}  ${ec.name}: ${ec.actual}`);
    }
  }

  // Data integrity results
  if (stats.dataIntegrity.length > 0) {
    console.log('\n  Data Integrity:');
    for (const di of stats.dataIntegrity) {
      console.log(`    ${di.pass ? 'PASS' : 'FAIL'}  ${di.check}: ${di.detail}`);
    }
  }

  // Pass/Fail criteria
  if (stats.passFail.length > 0) {
    const pfPassed = stats.passFail.filter(p => p.pass).length;
    console.log(`\n  Pass/Fail Criteria: ${pfPassed}/${stats.passFail.length}`);
    for (const pf of stats.passFail) {
      console.log(`    ${pf.pass ? 'PASS' : 'FAIL'}  ${pf.criterion}: ${pf.actual}`);
    }
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
    const apiAvg = qs.apiTimes.length > 0
      ? Math.round(qs.apiTimes.reduce((a, b) => a + b, 0) / qs.apiTimes.length)
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
        <td>${fmtMs(apiAvg)}</td>
        <td>${fmtMs(percentile(qs.apiTimes, 50))}</td>
        <td>${fmtMs(percentile(qs.apiTimes, 95))}</td>
        <td>${qs.apiTimes.length > 0 ? fmtMs(Math.max(...qs.apiTimes)) : '-'}</td>
        <td>${fmtMs(qs.scoringMs)}</td>
        <td>${qs.viewerScoringDelayMs !== null ? fmtMs(qs.viewerScoringDelayMs) : '-'}</td>
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
    <div class="summary-card">
      <div class="label">Edge Cases</div>
      <div class="value ${stats.edgeCases.every(e => e.pass) ? 'green' : 'red'}">${stats.edgeCases.filter(e => e.pass).length}/${stats.edgeCases.length}</div>
    </div>
    <div class="summary-card">
      <div class="label">Data Integrity</div>
      <div class="value ${stats.dataIntegrity.every(d => d.pass) ? 'green' : 'red'}">${stats.dataIntegrity.filter(d => d.pass).length}/${stats.dataIntegrity.length}</div>
    </div>
    <div class="summary-card">
      <div class="label">Throughput</div>
      <div class="value blue">${throughput(allApiTimes.length, timing.testEndMs - timing.testStartMs).toFixed(1)} <span style="font-size:12px;color:#64748b">ops/s</span></div>
    </div>
    <div class="summary-card">
      <div class="label">API Std Dev</div>
      <div class="value orange">${allApiTimes.length > 0 ? fmtMs(stdDev(allApiTimes)) : '-'}</div>
    </div>
    ${(() => {
      const stTimes = timing.steps.filter(s => s.step.startsWith('state->')).map(s => s.durationMs);
      const scTimes = timing.steps.filter(s => s.step === 'score-question-rpc').map(s => s.durationMs);
      const afTimes = timing.steps.filter(s => ['fetch-leaderboard', 'fetch-response-counts', 'fetch-player-stats'].includes(s.step)).map(s => s.durationMs);
      const pfTimes = stats.playerFetchTimes;
      return `
    <div class="summary-card">
      <div class="label">State Transition p50/p95</div>
      <div class="value blue" style="font-size:18px">${stTimes.length > 0 ? fmtMs(percentile(stTimes, 50)) + ' / ' + fmtMs(percentile(stTimes, 95)) : '-'}</div>
    </div>
    <div class="summary-card">
      <div class="label">Scoring RPC p50/p95</div>
      <div class="value purple" style="font-size:18px">${scTimes.length > 0 ? fmtMs(percentile(scTimes, 50)) + ' / ' + fmtMs(percentile(scTimes, 95)) : '-'}</div>
    </div>
    <div class="summary-card">
      <div class="label">Admin Fetch p50/p95</div>
      <div class="value orange" style="font-size:18px">${afTimes.length > 0 ? fmtMs(percentile(afTimes, 50)) + ' / ' + fmtMs(percentile(afTimes, 95)) : '-'}</div>
    </div>
    <div class="summary-card">
      <div class="label">Player Fetch p50/p95</div>
      <div class="value blue" style="font-size:18px">${pfTimes.length > 0 ? fmtMs(percentile(pfTimes, 50)) + ' / ' + fmtMs(percentile(pfTimes, 95)) : '-'}</div>
    </div>`;
    })()}
  </div>

  <!-- ── Pass/Fail Banner ── -->
  ${(() => {
    const pfPassed = stats.passFail.filter(p => p.pass).length;
    const pfTotal = stats.passFail.length;
    const allPass = pfPassed === pfTotal;
    return `
  <div class="section" style="border-left:4px solid ${allPass ? '#34d399' : '#ef4444'};margin-bottom:24px">
    <h2 style="color:${allPass ? '#34d399' : '#f87171'}">${allPass ? 'ALL CRITERIA PASSED' : 'SOME CRITERIA FAILED'} (${pfPassed}/${pfTotal})</h2>
    <table>
      <thead><tr><th style="width:50px">Result</th><th>Criterion</th><th>Threshold</th><th>Actual</th></tr></thead>
      <tbody>${stats.passFail.map(pf => `
        <tr>
          <td class="${pf.pass ? 'pass' : 'fail'}">${pf.pass ? 'PASS' : 'FAIL'}</td>
          <td>${escapeHtml(pf.criterion)}</td>
          <td>${escapeHtml(pf.threshold)}</td>
          <td>${escapeHtml(pf.actual)}</td>
        </tr>`).join('')}
      </tbody>
    </table>
  </div>`;
  })()}

  <!-- ── Tabs ── -->
  <div class="tab-nav">
    <button class="tab-btn active" onclick="showTab('timeline')">Timeline</button>
    <button class="tab-btn" onclick="showTab('questions')">Per-Question</button>
    <button class="tab-btn" onclick="showTab('api')">API Timing</button>
    <button class="tab-btn" onclick="showTab('system')">System Timing</button>
    <button class="tab-btn" onclick="showTab('scoring')">Scoring & Settlement</button>
    <button class="tab-btn" onclick="showTab('realtime')">Realtime Propagation</button>
    <button class="tab-btn" onclick="showTab('operations')">All Operations</button>
    <button class="tab-btn" onclick="showTab('players')">Player Details</button>
    <button class="tab-btn" onclick="showTab('edgecases')">Edge Cases</button>
    <button class="tab-btn" onclick="showTab('integrity')">Data Integrity</button>
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
      <p style="color:#64748b;font-size:12px;margin-bottom:12px">API Avg/p50/p95/Max = system round-trip latency for submit_response (excludes player think time). RT Lag = realtime push delay. Scoring = score_question RPC.</p>
      <div style="overflow-x:auto">
      <table>
        <thead>
          <tr>
            <th>#</th><th>Question</th><th>Submit</th><th>OK</th><th>Fail</th><th>Skip</th>
            <th>API Avg</th><th>API p50</th><th>API p95</th><th>API Max</th>
            <th>Scoring RPC</th><th>Viewer Delay</th><th>Resp Fetch</th><th>RT Lag p50</th><th>RT Lag p95</th><th>State Transitions</th>
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
        <div class="percentile-card"><div class="p-label">Std Dev (σ)</div><div class="p-value">${allApiTimes.length > 0 ? fmtMs(stdDev(allApiTimes)) : '-'}</div></div>
        <div class="percentile-card"><div class="p-label">Total Calls</div><div class="p-value">${allApiTimes.length}</div></div>
        <div class="percentile-card"><div class="p-label">Throughput</div><div class="p-value">${throughput(allApiTimes.length, timing.testEndMs - timing.testStartMs).toFixed(1)} <span style="font-size:10px">ops/s</span></div></div>
      </div>
    </div>
    <div class="section">
      <h2>Per-Question API Latency (p50 / p95)</h2>
      <p style="color:#64748b;font-size:12px;margin-bottom:12px">Blue = p50 (median), Red = p95. Shows how API latency varies across questions under sustained load.</p>
      <div class="chart-container">${qBarSvg}</div>
    </div>
  </div>

  <!-- ── Tab: System Timing ── -->
  <div id="tab-system" class="tab-content">
    ${(() => {
      const stTimes = timing.steps.filter(s => s.step.startsWith('state->')).map(s => s.durationMs);
      const scTimes = timing.steps.filter(s => s.step === 'score-question-rpc').map(s => s.durationMs);
      const afTimes = timing.steps.filter(s => ['fetch-leaderboard', 'fetch-response-counts', 'fetch-player-stats'].includes(s.step)).map(s => s.durationMs);
      const pfTimes = stats.playerFetchTimes;
      const joinTimes = Object.values(stats.playerLogs).filter(l => l.joinSuccess).map(l => l.joinTimeMs);

      const renderGrid = (label, times) => {
        if (times.length === 0) return '<p style="color:#64748b">No data.</p>';
        return '<div class="percentile-grid">' +
          '<div class="percentile-card"><div class="p-label">Count</div><div class="p-value">' + times.length + '</div></div>' +
          '<div class="percentile-card"><div class="p-label">p50</div><div class="p-value">' + fmtMs(percentile(times, 50)) + '</div></div>' +
          '<div class="percentile-card"><div class="p-label">p90</div><div class="p-value">' + fmtMs(percentile(times, 90)) + '</div></div>' +
          '<div class="percentile-card"><div class="p-label">p95</div><div class="p-value">' + fmtMs(percentile(times, 95)) + '</div></div>' +
          '<div class="percentile-card"><div class="p-label">p99</div><div class="p-value">' + fmtMs(percentile(times, 99)) + '</div></div>' +
          '<div class="percentile-card"><div class="p-label">Max</div><div class="p-value">' + fmtMs(Math.max(...times)) + '</div></div>' +
          '<div class="percentile-card"><div class="p-label">Mean</div><div class="p-value">' + fmtMs(times.reduce((s,t)=>s+t,0)/times.length) + '</div></div>' +
          '<div class="percentile-card"><div class="p-label">Std Dev</div><div class="p-value">' + fmtMs(stdDev(times)) + '</div></div>' +
          '</div>';
      };

      return `
    <div class="section">
      <h2>System Response Time Summary</h2>
      <p style="color:#64748b;font-size:12px;margin-bottom:12px">所有系統操作的回應時間（不包含玩家思考時間）。如果這些數值過高，表示伺服器/網路有效能問題。</p>

      <h3 style="margin-top:20px;margin-bottom:8px;color:#94a3b8;font-size:14px">Player Join (join_via_qr RPC)</h3>
      ${renderGrid('join', joinTimes)}

      <h3 style="margin-top:20px;margin-bottom:8px;color:#94a3b8;font-size:14px">Answer Submission API (submit_response RPC)</h3>
      ${renderGrid('submit', allApiTimes)}

      <h3 style="margin-top:20px;margin-bottom:8px;color:#94a3b8;font-size:14px">Admin State Transitions (game_status UPDATE)</h3>
      ${renderGrid('state', stTimes)}

      <h3 style="margin-top:20px;margin-bottom:8px;color:#94a3b8;font-size:14px">Scoring RPC (score_question)</h3>
      ${renderGrid('scoring', scTimes)}

      <h3 style="margin-top:20px;margin-bottom:8px;color:#94a3b8;font-size:14px">Admin Fetch Operations (leaderboard, response counts, player stats)</h3>
      ${renderGrid('admin-fetch', afTimes)}

      <h3 style="margin-top:20px;margin-bottom:8px;color:#94a3b8;font-size:14px">Player Fetch Operations (score fetch, leaderboard)</h3>
      ${renderGrid('player-fetch', pfTimes)}
    </div>`;
    })()}
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

  <!-- ── Tab: Edge Cases ── -->
  <div id="tab-edgecases" class="tab-content">
    <div class="section">
      <h2>Edge Case Tests (${stats.edgeCases.filter(e => e.pass).length}/${stats.edgeCases.length} Passed)</h2>
      <p style="color:#64748b;font-size:12px;margin-bottom:12px">驗證系統對異常輸入的防護：重複暱稱、無效 QR token、重複提交等。</p>
      <table>
        <thead><tr><th style="width:50px">Result</th><th>Test Name</th><th>Description</th><th>Expected</th><th>Actual</th></tr></thead>
        <tbody>${stats.edgeCases.map(ec => `
          <tr>
            <td class="${ec.pass ? 'pass' : 'fail'}">${ec.pass ? 'PASS' : 'FAIL'}</td>
            <td>${escapeHtml(ec.name)}</td>
            <td>${escapeHtml(ec.description)}</td>
            <td style="color:#64748b">${escapeHtml(ec.expected)}</td>
            <td>${escapeHtml(ec.actual)}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>
  </div>

  <!-- ── Tab: Data Integrity ── -->
  <div id="tab-integrity" class="tab-content">
    <div class="section">
      <h2>Data Integrity Validation (${stats.dataIntegrity.filter(d => d.pass).length}/${stats.dataIntegrity.length} Passed)</h2>
      <p style="color:#64748b;font-size:12px;margin-bottom:12px">驗證結算後的數據一致性：is_correct 標記、scored_points 公式、玩家總分等。</p>
      <table>
        <thead><tr><th style="width:50px">Result</th><th>Check</th><th>Detail</th></tr></thead>
        <tbody>${stats.dataIntegrity.map(di => `
          <tr>
            <td class="${di.pass ? 'pass' : 'fail'}">${di.pass ? 'PASS' : 'FAIL'}</td>
            <td>${escapeHtml(di.check)}</td>
            <td>${escapeHtml(di.detail)}</td>
          </tr>`).join('')}
        </tbody>
      </table>
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

  // Launch browser monitors (user page + admin dashboard)
  console.log('  Launching browser monitors...');
  await launchBrowsers(qrToken);

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

  // Subscribe all active players to realtime (wait for SUBSCRIBED confirmation)
  console.log('  Subscribing all players to realtime...');
  const subscribeResults = await Promise.allSettled(
    activePlayers.map(p =>
      p.subscribe((playerName, state, receivedAt) => {
        // This callback fires for every realtime event received by every player
      })
    )
  );
  const subOk = subscribeResults.filter(r => r.status === 'fulfilled').length;
  const subFail = subscribeResults.filter(r => r.status === 'rejected').length;
  if (subFail > 0) {
    const failures = subscribeResults
      .filter(r => r.status === 'rejected')
      .slice(0, 3)
      .map(r => r.reason?.message || r.reason);
    console.warn(`  WARNING: ${subFail}/${activePlayers.length} realtime subscriptions failed. First errors: ${failures.join('; ')}`);
  }
  console.log(`  Realtime subscribed: ${subOk} ok, ${subFail} failed out of ${activePlayers.length} players.`);
  // Extra settle time for WebSocket connections to stabilize
  await sleep(1000);
  phaseEnd('1-player-join');

  // ══════════════════════════════════════════════════════════════════════════════
  // Phase 1.5: Edge case tests
  // ══════════════════════════════════════════════════════════════════════════════
  await runEdgeCaseTests(qrToken, questions);

  // Blanket cleanup: remove ALL edge-case residual data before Phase 2
  console.log('  Cleaning up edge case residual data...');
  await admin.from('responses').delete().like('player_name', 'test_%');
  await admin.from('players').update({ score: 0, test_score: 0 }).like('name', 'test_%');
  console.log('  Edge case residual data cleaned.');

  // Reload admin browser after edge case tests to sync state
  // (edge cases changed game_status via API, admin UI is out of sync)
  if (adminPage) {
    console.log('  Reloading admin browser to sync state...');
    await adminPage.reload({ waitUntil: 'networkidle' });
    // localStorage may auto-login; only fill credentials if login screen is visible
    const loginVisible = await adminPage.locator('#login-screen:not(.hidden)').isVisible().catch(() => false);
    if (loginVisible) {
      await adminPage.fill('#login-username', ADMIN_USERNAME);
      await adminPage.fill('#login-password', ADMIN_PASSWORD);
      await adminPage.click('button[onclick="doLogin()"]');
    }
    await adminPage.waitForSelector('#admin-panel:not(.hidden)', { timeout: 10000 });
    console.log('  Admin browser reloaded and logged in.');
  }

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

    // ── Step 0: Select question in admin browser ──
    if (qi === 0) {
      // First question: select it in the dropdown
      await adminSelectQuestion(q.id);
      console.log(`  [0] Admin selected question ${q.id}`);
    }
    // Subsequent questions are auto-selected by "下一題" button click

    // ── Step 1: Admin clicks "開放作答" → playing ──
    console.log('  [1] Admin -> playing (browser click)');
    const playResult = await adminClickStart();
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

    // ── Step 2+3: Players answer concurrently, admin waits up to 30s ──
    // Fire off all player answers with staggered start (non-blocking), then wait
    // for all to finish OR 30s timeout. Batches start with a small delay between
    // them to avoid thundering herd, but do NOT wait for a batch to complete
    // before starting the next one.
    console.log('  [2] Players answering...');
    const answerT0 = now();
    const answerPromises = [];
    for (let i = 0; i < activePlayers.length; i += 10) {
      const batch = activePlayers.slice(i, i + 10);
      // Each batch starts after a small stagger delay, but all run concurrently
      const batchDelay = (i / 10) * 50;
      for (const p of batch) {
        answerPromises.push(
          sleep(batchDelay).then(() => p.answer(q.id).catch(e => recordError(`answer(${p.name})`, e)))
        );
      }
    }
    const allAnswered = Promise.all(answerPromises);

    // Wait for all players to finish OR 30s timeout
    let allDone = false;
    await Promise.race([
      allAnswered.then(() => { allDone = true; }),
      sleep(ANSWER_TIMEOUT_MS),
    ]);
    const answerDur = now() - answerT0;
    const submitted = qs.submitted + qs.skipped;
    if (allDone) {
      console.log(`  [2+3] All players answered: ${submitted}/${activePlayers.length} (${fmtMs(answerDur)})`);
    } else {
      console.log(`  [2+3] 30s timeout reached, ${submitted}/${activePlayers.length} answered (${fmtMs(answerDur)})`);
    }
    recordStep('question', 'answer-phase', `q=${q.id}, answered=${submitted}/${activePlayers.length}, allDone=${allDone}`, answerDur);

    // ── Step 4: Admin clicks "停止作答" → stopped ──
    console.log('  [4] Admin -> stopped (browser click)');
    const stopResult = await adminClickStop();
    qs.stateTransitions['stopped'] = stopResult.durationMs;

    // Measure realtime for "stopped"
    const stoppedLags = await measureRealtimePropagation(activePlayers, stopResult.sentAt, 5000);
    qs.realtimePropagation.push(...stoppedLags);
    timing.realtimeLags.push(...stoppedLags);

    await sleep(1000);

    // ── Step 5: Admin clicks "公布答案" → revealed ──
    console.log('  [5] Admin -> revealed (browser click)');
    const revealResult = await adminClickReveal();
    qs.stateTransitions['revealed'] = revealResult.durationMs;

    // Measure realtime for "revealed"
    const revealLags = await measureRealtimePropagation(activePlayers, revealResult.sentAt, 5000);
    qs.realtimePropagation.push(...revealLags);
    timing.realtimeLags.push(...revealLags);

    // Fetch response counts (admin browser already does this, also measure via API)
    const respCounts = await fetchResponseCounts(q.id);
    qs.responseCountFetchMs = respCounts.durationMs;
    console.log(`  [5] Response counts: total=${respCounts.total}, fetch=${fmtMs(respCounts.durationMs)}`);

    await sleep(2000);

    // ── Step 6+7: Admin clicks "結算" → scoring RPC + state = scoring ──
    // In the admin UI, doScoring() calls score_question RPC then changeState('scoring')
    console.log('  [6+7] Admin scoring + state->scoring (browser click)');
    const scoringResult = await adminClickScore();
    qs.scoringMs = scoringResult.durationMs;
    qs.stateTransitions['scoring'] = scoringResult.durationMs;
    console.log(`  [6+7] Scoring complete: ${fmtMs(scoringResult.durationMs)}`);

    // Measure realtime for "scoring"
    const scoringLags = await measureRealtimePropagation(activePlayers, scoringResult.sentAt, 5000);
    qs.realtimePropagation.push(...scoringLags);
    timing.realtimeLags.push(...scoringLags);

    // ── Step 7.5: test_viewer scoring DOM verification ──
    if (userPage) {
      try {
        await userPage.waitForSelector('#scoring-ui:not(.hidden)', { timeout: 8000 });
        const scoringTiming = await userPage.evaluate(() => window.__scoringTiming);
        if (scoringTiming && scoringTiming.questionId === q.id) {
          const delay = scoringTiming.delayMs ?? (scoringTiming.scoreTime - scoringTiming.showTime);
          qs.viewerScoringDelayMs = delay;
          recordStep('viewer', 'scoring-ui-delay', `q=${q.id}, delay=${delay}ms`, delay);
          console.log(`  [7.5] test_viewer scoring UI: visible, score delay=${fmtMs(delay)}`);
        } else {
          console.log(`  [7.5] test_viewer scoring UI: visible, but timing data missing or mismatched`);
        }
      } catch (e) {
        console.log(`  [7.5] test_viewer scoring UI: NOT visible within timeout (${e.message})`);
        recordStep('viewer', 'scoring-ui-delay', `q=${q.id}, TIMEOUT`, 8000);
      }
    }

    // ── Step 8: All players fetch their own score (record all responses) ──
    console.log('  [8] Players fetching scores...');
    await sleep(1000);  // let DB settle after score_question batch UPDATE
    const scoreFetchT0 = now();
    const scoreFetches = await staggeredAll(
      activePlayers.map(p => () => p.fetchMyScore(q.id)), 10, 50
    );
    const scoreFetchDur = now() - scoreFetchT0;
    const scoreFetchTimes = scoreFetches.map(r => r.durationMs);
    recordStep('player', 'fetch-score', `q=${q.id}, count=${activePlayers.length}`, scoreFetchDur);
    stats.playerFetchTimes.push(...scoreFetchTimes);
    console.log(`  [8] Score fetch (${activePlayers.length} players): p50=${fmtMs(percentile(scoreFetchTimes, 50))}, p95=${fmtMs(percentile(scoreFetchTimes, 95))}, max=${fmtMs(Math.max(...scoreFetchTimes))}`);

    // ── Step 9: Admin fetches leaderboard ──
    // Admin browser already shows leaderboard (tab auto-switched), also measure via API
    console.log('  [9] Admin fetching leaderboard...');
    const lb = await fetchLeaderboard();
    qs.leaderboardFetchMs = lb.durationMs;
    console.log(`  [9] Leaderboard: ${lb.players.length} players, ${fmtMs(lb.durationMs)}`);

    await sleep(5000);

    // ── Step 10: Admin clicks "下一題" or we're on the last question ──
    if (qi < questions.length - 1) {
      console.log(`  [10] Admin -> next question (browser click)`);
      const waitResult = await adminClickNext();
      qs.stateTransitions['waiting'] = waitResult.durationMs;

      // Measure realtime for "waiting" (next question)
      const waitingLags = await measureRealtimePropagation(activePlayers, waitResult.sentAt, 5000);
      qs.realtimePropagation.push(...waitingLags);
      timing.realtimeLags.push(...waitingLags);

      await sleep(3000);
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

  // Admin clicks "結束遊戲" → ended
  const endResult = await adminClickEnd();
  console.log(`  state->ended (browser click): ${fmtMs(endResult.durationMs)}`);

  // Measure realtime for "ended"
  const endLags = await measureRealtimePropagation(activePlayers, endResult.sentAt, 5000);
  timing.realtimeLags.push(...endLags);
  if (endLags.length > 0) {
    console.log(`  Realtime propagation: ${endLags.length} received, p50=${fmtMs(percentile(endLags, 50))}`);
  }

  // Players fetch final leaderboard (like end-ui) — ALL players concurrently
  console.log('  Players fetching final leaderboard...');
  const endFetchT0 = now();
  const endFetches = await staggeredAll(
    activePlayers.map(p => () => p.fetchEndLeaderboard()), 10, 50
  );
  const endFetchDur = now() - endFetchT0;
  const endFetchTimes = endFetches.map(r => r.durationMs);
  recordStep('player', 'fetch-end-leaderboard', `count=${activePlayers.length}`, endFetchDur);
  stats.playerFetchTimes.push(...endFetchTimes);
  console.log(`  End leaderboard fetch (${activePlayers.length} players): p50=${fmtMs(percentile(endFetchTimes, 50))}, p95=${fmtMs(percentile(endFetchTimes, 95))}, max=${fmtMs(Math.max(...endFetchTimes))}`);

  // Admin fetches final leaderboard + player stats (for PDF export)
  const finalLb = await fetchLeaderboard();
  console.log(`  Admin final leaderboard: ${fmtMs(finalLb.durationMs)}`);
  const playerStats = await fetchPlayerStats();
  console.log(`  Admin player stats (PDF export): ${fmtMs(playerStats.durationMs)}`);

  // ── Data Integrity Validation ──
  await validateDataIntegrity(questions);

  phaseEnd('3-end-game');

  // ══════════════════════════════════════════════════════════════════════════════
  // Phase 4: Cleanup
  // ══════════════════════════════════════════════════════════════════════════════
  phaseStart('4-cleanup');
  console.log('\n[Phase 4] Cleaning up...');
  await Promise.all(activePlayers.map(p => p.cleanup()));
  console.log(`  ${activePlayers.length} player connections closed.`);

  // Close browser monitors and HTTP server
  await closeBrowsers();
  console.log('  Browser monitors closed.');

  phaseEnd('4-cleanup');

  timing.testEndMs = Date.now();

  // Evaluate pass/fail criteria
  const allPass = evaluatePassFail(questions);

  // Print console report
  printReport(questions);

  // Generate HTML report
  generateHtmlReport(questions);

  console.log(`\nLoad test complete. Result: ${allPass ? 'ALL PASS' : 'SOME CRITERIA FAILED'}\n`);
  process.exit(allPass ? 0 : 1);
}

main().catch(err => {
  console.error('\nFATAL:', err);
  closeBrowsers().finally(() => process.exit(1));
});
