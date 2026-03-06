/**
 * E2E Load Test: 100 Concurrent Players + 1 Admin
 *
 * Simulates a real quiz game session:
 * - 1 admin controls the game flow
 * - 100 players join, listen for state changes, and submit answers
 * - Human-like random delays and behaviors
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

/** Weighted random choice (simulates herd-mentality bias). */
function weightedChoice() {
  const weights = [0.35, 0.30, 0.20, 0.15]; // options 1-4
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
  return `${ms.toFixed(0)}ms`;
}

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── Stats Collector ───────────────────────────────────────────────────────────

const stats = {
  playersCreated: 0,
  playersFailed: 0,
  errors: [],
  perQuestion: {},   // questionId -> { submitted, succeeded, failed, skipped, responseTimes, apiTimes }
  playerLogs: {},    // playerName -> { joinTimeMs, joinSuccess, answers: [{questionId, choice, responseTimeMs, apiTimeMs, skipped, success}] }
  dbOps: [],         // { operation, table, durationMs, success }
  testStartTime: 0,
  testEndTime: 0,
};

function initQuestionStats(qId) {
  if (!stats.perQuestion[qId]) {
    stats.perQuestion[qId] = {
      submitted: 0,
      succeeded: 0,
      failed: 0,
      skipped: 0,
      responseTimes: [],
      apiTimes: [],
    };
  }
}

function recordError(context, error) {
  const msg = `[${context}] ${error?.message || error}`;
  stats.errors.push(msg);
  console.error(`  ERROR ${msg}`);
}

function trackDbOp(operation, table, durationMs, success) {
  stats.dbOps.push({ operation, table, durationMs, success });
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
  const t0 = Date.now();
  const { data, error } = await admin
    .from('users')
    .select('id')
    .eq('username', ADMIN_USERNAME)
    .eq('password', ADMIN_PASSWORD)
    .maybeSingle();
  trackDbOp('admin-login', 'users', Date.now() - t0, !error && !!data);

  if (error || !data) {
    throw new Error(`Admin login failed: ${error?.message || 'invalid credentials'}`);
  }
  console.log('  Admin logged in successfully.');
}

async function cleanTestData() {
  // Delete test responses
  let t0 = Date.now();
  const { error: e1 } = await admin
    .from('responses')
    .delete()
    .like('player_name', 'test_%');
  trackDbOp('clean-responses', 'responses', Date.now() - t0, !e1);
  if (e1) recordError('clean-responses', e1);

  // Delete test players
  t0 = Date.now();
  const { error: e2 } = await admin
    .from('players')
    .delete()
    .like('name', 'test_%');
  trackDbOp('clean-players', 'players', Date.now() - t0, !e2);
  if (e2) recordError('clean-players', e2);

  // Reset game status
  t0 = Date.now();
  const { error: e3 } = await admin
    .from('game_status')
    .update({ state: 'waiting', current_q_id: 1, start_time: 0 })
    .eq('id', 1);
  trackDbOp('reset-game-status', 'game_status', Date.now() - t0, !e3);
  if (e3) recordError('reset-game-status', e3);

  console.log('  Old test data cleaned.');
}

async function fetchQuestions() {
  const t0 = Date.now();
  const { data, error } = await admin
    .from('questions')
    .select('*')
    .order('id', { ascending: true });
  trackDbOp('fetch-questions', 'questions', Date.now() - t0, !error && !!data);
  if (error) throw new Error(`Failed to fetch questions: ${error.message}`);
  if (!data || data.length === 0) throw new Error('No questions found in database.');
  return data;
}

async function updateGameStatus(state, currentQId) {
  const payload = { state, start_time: Date.now() };
  if (currentQId !== undefined) payload.current_q_id = currentQId;

  const t0 = Date.now();
  const { error } = await admin
    .from('game_status')
    .update(payload)
    .eq('id', 1);
  trackDbOp(`update-game-status(${state})`, 'game_status', Date.now() - t0, !error);
  if (error) recordError(`update-game-status(${state})`, error);
}

async function adminScoreQuestion(questionId, correctAnswer, points) {
  const t0 = Date.now();
  const { data: responses, error } = await admin
    .from('responses')
    .select('*')
    .eq('question_id', questionId);
  trackDbOp('fetch-responses-for-scoring', 'responses', Date.now() - t0, !error);

  if (error) {
    recordError(`fetch-responses(q${questionId})`, error);
    return;
  }

  for (const r of responses || []) {
    const isCorrect = r.choice === correctAnswer && r.choice !== 0;

    const t1 = Date.now();
    const { error: ue } = await admin
      .from('responses')
      .update({ is_correct: isCorrect })
      .eq('id', r.id);
    trackDbOp('score-update-response', 'responses', Date.now() - t1, !ue);
    if (ue) recordError(`update-response(${r.id})`, ue);

    if (isCorrect) {
      const remainingMs = Math.max(0, COUNTDOWN_MS - (r.response_time_ms || COUNTDOWN_MS));
      const score = Math.round(points * (1 + (remainingMs / COUNTDOWN_MS) * 0.75));

      const t2 = Date.now();
      const { data: player } = await admin
        .from('players')
        .select('score')
        .eq('name', r.player_name)
        .single();
      trackDbOp('score-fetch-player', 'players', Date.now() - t2, !!player);

      if (player) {
        const t3 = Date.now();
        const { error: se } = await admin
          .from('players')
          .update({ score: player.score + score })
          .eq('name', r.player_name);
        trackDbOp('score-update-player', 'players', Date.now() - t3, !se);
        if (se) recordError(`update-player-score(${r.player_name})`, se);
      }
    }
  }
}

// ─── Player Simulation ─────────────────────────────────────────────────────────

/**
 * Creates a single simulated player.
 * Returns an object with methods to act on behalf of the player.
 */
function createPlayer(index) {
  const name = `test_user_${padNum(index)}`;
  const client = newClient();
  let currentState = null;
  let channel = null;

  // Initialize per-player log
  stats.playerLogs[name] = { joinTimeMs: 0, joinSuccess: false, answers: [] };

  return {
    name,

    /** Register player in the database. */
    async join() {
      await randomSleep(0, 2000);
      const t0 = Date.now();
      const { error } = await client.from('players').insert({ name });
      const joinTime = Date.now() - t0;

      stats.playerLogs[name].joinTimeMs = joinTime;
      trackDbOp('player-join', 'players', joinTime, !error);

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

    /** Subscribe to game_status changes via Realtime. */
    subscribe() {
      channel = client
        .channel(`player-${name}`)
        .on(
          'postgres_changes',
          { event: 'UPDATE', schema: 'public', table: 'game_status', filter: 'id=eq.1' },
          (payload) => {
            currentState = payload.new;
          }
        )
        .subscribe();
    },

    /** Submit an answer for the given question. */
    async answer(questionId) {
      initQuestionStats(questionId);
      const qs = stats.perQuestion[questionId];

      // 10% chance of not answering (will be auto-submitted as choice=0)
      if (Math.random() < 0.1) {
        qs.skipped++;
        stats.playerLogs[name].answers.push({
          questionId, choice: null, responseTimeMs: 0, apiTimeMs: 0, skipped: true, success: false,
        });
        return;
      }

      // Random thinking time 1-12 seconds
      const thinkTime = randomInt(1000, 12000);
      await sleep(thinkTime);

      // Random click-to-submit delay
      await randomSleep(200, 800);

      const choice = weightedChoice();
      const responseTimeMs = thinkTime + randomInt(200, 800);

      const t0 = Date.now();
      const { error } = await client.from('responses').insert({
        player_name: name,
        question_id: questionId,
        choice,
        is_correct: null,
        response_time_ms: responseTimeMs,
      });
      const apiTime = Date.now() - t0;

      qs.submitted++;
      qs.apiTimes.push(apiTime);
      trackDbOp('player-answer', 'responses', apiTime, !error);

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

    /** Unsubscribe and clean up. */
    async cleanup() {
      if (channel) {
        await client.removeChannel(channel);
      }
    },

    getState() {
      return currentState;
    },
  };
}

// ─── Console Report ─────────────────────────────────────────────────────────────

function printReport(questions) {
  console.log('\n' + '='.repeat(70));
  console.log('  LOAD TEST REPORT');
  console.log('='.repeat(70));

  console.log(`\n  Players: ${stats.playersCreated} joined / ${stats.playersFailed} failed / ${NUM_PLAYERS} total`);

  const allApiTimes = [];

  console.log('\n  Per-Question Results:');
  console.log('  ' + '-'.repeat(66));
  console.log(
    '  ' +
    'Q#'.padEnd(5) +
    'Submitted'.padEnd(12) +
    'OK'.padEnd(8) +
    'Fail'.padEnd(8) +
    'Skip'.padEnd(8) +
    'Avg RT'.padEnd(12) +
    'API p50'.padEnd(12) +
    'API p95'
  );
  console.log('  ' + '-'.repeat(66));

  for (const q of questions) {
    const qs = stats.perQuestion[q.id];
    if (!qs) continue;

    allApiTimes.push(...qs.apiTimes);

    const avgRT =
      qs.responseTimes.length > 0
        ? Math.round(qs.responseTimes.reduce((a, b) => a + b, 0) / qs.responseTimes.length)
        : 0;

    const idx = questions.indexOf(q) + 1;
    console.log(
      '  ' +
      `Q${idx}`.padEnd(5) +
      String(qs.submitted).padEnd(12) +
      String(qs.succeeded).padEnd(8) +
      String(qs.failed).padEnd(8) +
      String(qs.skipped).padEnd(8) +
      fmtMs(avgRT).padEnd(12) +
      fmtMs(percentile(qs.apiTimes, 50)).padEnd(12) +
      fmtMs(percentile(qs.apiTimes, 95))
    );
  }

  console.log('\n  API Response Time Distribution (all questions combined):');
  if (allApiTimes.length > 0) {
    console.log(`    p50:  ${fmtMs(percentile(allApiTimes, 50))}`);
    console.log(`    p95:  ${fmtMs(percentile(allApiTimes, 95))}`);
    console.log(`    p99:  ${fmtMs(percentile(allApiTimes, 99))}`);
    console.log(`    max:  ${fmtMs(Math.max(...allApiTimes))}`);
  } else {
    console.log('    No API calls recorded.');
  }

  console.log(`\n  Total errors: ${stats.errors.length}`);
  if (stats.errors.length > 0) {
    console.log('  Error details:');
    for (const e of stats.errors.slice(0, 20)) {
      console.log(`    - ${e}`);
    }
    if (stats.errors.length > 20) {
      console.log(`    ... and ${stats.errors.length - 20} more`);
    }
  }

  console.log('\n' + '='.repeat(70));
}

// ─── HTML Report ────────────────────────────────────────────────────────────────

function generateHtmlReport(questions) {
  const testDuration = ((stats.testEndTime - stats.testStartTime) / 1000).toFixed(1);
  const startTimeStr = new Date(stats.testStartTime).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });

  // ── Collect aggregated API times ──
  const allApiTimes = [];
  for (const q of questions) {
    const qs = stats.perQuestion[q.id];
    if (qs) allApiTimes.push(...qs.apiTimes);
  }

  // ── Per-question rows ──
  let questionRows = '';
  questions.forEach((q, qi) => {
    const qs = stats.perQuestion[q.id];
    if (!qs) return;
    const avgRT = qs.responseTimes.length > 0
      ? Math.round(qs.responseTimes.reduce((a, b) => a + b, 0) / qs.responseTimes.length)
      : 0;
    const failClass = qs.failed > 0 ? ' class="fail"' : '';
    questionRows += `
      <tr>
        <td>Q${qi + 1}</td>
        <td>${escapeHtml(q.question?.slice(0, 60) || '')}</td>
        <td>${qs.submitted}</td>
        <td>${qs.succeeded}</td>
        <td${failClass}>${qs.failed}</td>
        <td>${qs.skipped}</td>
        <td>${avgRT}ms</td>
        <td>${fmtMs(percentile(qs.apiTimes, 50))}</td>
        <td>${fmtMs(percentile(qs.apiTimes, 95))}</td>
        <td>${qs.apiTimes.length > 0 ? fmtMs(Math.max(...qs.apiTimes)) : '-'}</td>
      </tr>`;
  });

  // ── DB operations summary ──
  const dbOpGroups = {};
  stats.dbOps.forEach((op) => {
    const key = op.operation;
    if (!dbOpGroups[key]) {
      dbOpGroups[key] = { count: 0, totalMs: 0, times: [], failed: 0, table: op.table };
    }
    dbOpGroups[key].count++;
    dbOpGroups[key].totalMs += op.durationMs;
    dbOpGroups[key].times.push(op.durationMs);
    if (!op.success) dbOpGroups[key].failed++;
  });

  let dbRows = '';
  const allDbTimes = stats.dbOps.map((op) => op.durationMs);
  Object.entries(dbOpGroups)
    .sort((a, b) => b[1].count - a[1].count)
    .forEach(([name, g]) => {
      const avg = Math.round(g.totalMs / g.count);
      const failClass = g.failed > 0 ? ' class="fail"' : '';
      dbRows += `
      <tr>
        <td>${escapeHtml(name)}</td>
        <td>${g.table}</td>
        <td>${g.count}</td>
        <td>${avg}ms</td>
        <td>${fmtMs(percentile(g.times, 50))}</td>
        <td>${fmtMs(percentile(g.times, 95))}</td>
        <td>${fmtMs(Math.max(...g.times))}</td>
        <td${failClass}>${g.failed}</td>
      </tr>`;
    });

  // ── Per-player rows ──
  let playerRows = '';
  const playerNames = Object.keys(stats.playerLogs).sort();
  playerNames.forEach((name) => {
    const log = stats.playerLogs[name];
    const answered = log.answers.filter((a) => !a.skipped);
    const skippedCount = log.answers.filter((a) => a.skipped).length;
    const failedCount = answered.filter((a) => !a.success).length;
    const successCount = answered.filter((a) => a.success).length;
    const apiTimes = answered.filter((a) => a.apiTimeMs > 0).map((a) => a.apiTimeMs);
    const avgApi = apiTimes.length > 0
      ? Math.round(apiTimes.reduce((s, t) => s + t, 0) / apiTimes.length)
      : 0;
    const maxApi = apiTimes.length > 0 ? Math.max(...apiTimes) : 0;

    const joinClass = log.joinSuccess ? 'pass' : 'fail';
    const failClass = failedCount > 0 ? ' class="fail"' : '';

    // Per-answer detail
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
          <td>${a.skipped ? '-' : a.responseTimeMs + 'ms'}</td>
          <td>${a.skipped ? '-' : a.apiTimeMs + 'ms'}</td>
          <td class="${cls}">${status}</td>
        </tr>`;
    });

    playerRows += `
      <tr class="player-row" data-player="${escapeHtml(name)}">
        <td>${escapeHtml(name)}</td>
        <td class="${joinClass}">${log.joinSuccess ? 'OK' : 'FAIL'}</td>
        <td>${log.joinTimeMs}ms</td>
        <td>${successCount}</td>
        <td>${skippedCount}</td>
        <td${failClass}>${failedCount}</td>
        <td>${avgApi}ms</td>
        <td>${maxApi}ms</td>
      </tr>
      <tr class="detail-row">
        <td colspan="8">
          <table class="detail-table">
            <thead><tr><th>Question</th><th>Choice</th><th>Response Time</th><th>DB Response</th><th>Status</th></tr></thead>
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
  const totalDbOps = stats.dbOps.length;
  const failedDbOps = stats.dbOps.filter((op) => !op.success).length;
  const passRate = allApiTimes.length > 0
    ? ((1 - stats.errors.length / Math.max(1, allApiTimes.length)) * 100).toFixed(1)
    : '0.0';

  const html = `<!DOCTYPE html>
<html lang="zh-TW">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>E2E Load Test Report</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Microsoft JhengHei', sans-serif; background: #f0f2f5; color: #333; }

    .header { background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%); color: #fff; padding: 32px 40px; }
    .header h1 { font-size: 28px; margin-bottom: 8px; }
    .header .subtitle { opacity: 0.8; font-size: 14px; }

    .container { max-width: 1400px; margin: 0 auto; padding: 24px; }

    .summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-bottom: 24px; }
    .summary-card { background: #fff; border-radius: 12px; padding: 20px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
    .summary-card .label { font-size: 12px; color: #888; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 4px; }
    .summary-card .value { font-size: 28px; font-weight: 700; }
    .summary-card .value.green { color: #27ae60; }
    .summary-card .value.red { color: #e74c3c; }
    .summary-card .value.blue { color: #2980b9; }
    .summary-card .value.orange { color: #f39c12; }

    .section { background: #fff; border-radius: 12px; padding: 24px; margin-bottom: 24px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
    .section h2 { font-size: 18px; margin-bottom: 16px; padding-bottom: 8px; border-bottom: 2px solid #f0f2f5; }

    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th { background: #f8f9fa; text-align: left; padding: 10px 12px; font-weight: 600; color: #555; border-bottom: 2px solid #e9ecef; }
    td { padding: 8px 12px; border-bottom: 1px solid #f0f2f5; }
    tr:hover { background: #f8f9fa; }

    .pass { color: #27ae60; font-weight: 600; }
    .fail { color: #e74c3c; font-weight: 600; }
    .skip { color: #f39c12; font-weight: 600; }

    .player-row { cursor: pointer; }
    .player-row:hover { background: #e8f4fd !important; }
    .player-row td:first-child::before { content: '\\25B6 '; font-size: 10px; color: #aaa; }
    .player-row.expanded td:first-child::before { content: '\\25BC '; }

    .detail-row { display: none; }
    .detail-row.show { display: table-row; }
    .detail-row > td { padding: 0 12px 12px 32px; background: #fafbfc; }

    .detail-table { margin-top: 8px; font-size: 12px; }
    .detail-table th { background: #e9ecef; padding: 6px 10px; }
    .detail-table td { padding: 5px 10px; }

    .percentile-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; margin-top: 12px; }
    .percentile-card { text-align: center; padding: 12px; background: #f8f9fa; border-radius: 8px; }
    .percentile-card .p-label { font-size: 11px; color: #888; text-transform: uppercase; }
    .percentile-card .p-value { font-size: 22px; font-weight: 700; color: #2c3e50; margin-top: 2px; }

    .filter-bar { display: flex; gap: 12px; margin-bottom: 12px; align-items: center; flex-wrap: wrap; }
    .filter-bar input { padding: 6px 12px; border: 1px solid #ddd; border-radius: 6px; font-size: 13px; }
    .filter-bar select { padding: 6px 12px; border: 1px solid #ddd; border-radius: 6px; font-size: 13px; }
    .filter-bar label { font-size: 13px; color: #666; }

    .error-section { border-left: 4px solid #e74c3c; }
    .error-section h2 { color: #e74c3c; }

    .badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; }
    .badge-green { background: #d4edda; color: #155724; }
    .badge-red { background: #f8d7da; color: #721c24; }

    .footer { text-align: center; padding: 16px; color: #999; font-size: 12px; }

    @media (max-width: 768px) {
      .header { padding: 20px; }
      .container { padding: 12px; }
      .summary-grid { grid-template-columns: repeat(2, 1fr); }
      table { font-size: 11px; }
      th, td { padding: 6px 8px; }
    }
  </style>
</head>
<body>

<div class="header">
  <h1>E2E Load Test Report</h1>
  <div class="subtitle">${startTimeStr} &nbsp;|&nbsp; Duration: ${testDuration}s &nbsp;|&nbsp; ${NUM_PLAYERS} Players &nbsp;|&nbsp; ${questions.length} Questions</div>
</div>

<div class="container">

  <!-- ── Summary Cards ── -->
  <div class="summary-grid">
    <div class="summary-card">
      <div class="label">Players Joined</div>
      <div class="value green">${stats.playersCreated} <span style="font-size:14px;color:#888">/ ${NUM_PLAYERS}</span></div>
    </div>
    <div class="summary-card">
      <div class="label">Join Failures</div>
      <div class="value ${stats.playersFailed > 0 ? 'red' : 'green'}">${stats.playersFailed}</div>
    </div>
    <div class="summary-card">
      <div class="label">Total DB Operations</div>
      <div class="value blue">${totalDbOps}</div>
    </div>
    <div class="summary-card">
      <div class="label">DB Failures</div>
      <div class="value ${failedDbOps > 0 ? 'red' : 'green'}">${failedDbOps}</div>
    </div>
    <div class="summary-card">
      <div class="label">API p50 / p95</div>
      <div class="value blue" style="font-size:22px">${allApiTimes.length > 0 ? fmtMs(percentile(allApiTimes, 50)) + ' / ' + fmtMs(percentile(allApiTimes, 95)) : '-'}</div>
    </div>
    <div class="summary-card">
      <div class="label">Errors</div>
      <div class="value ${stats.errors.length > 0 ? 'red' : 'green'}">${stats.errors.length}</div>
    </div>
  </div>

  <!-- ── Per-Question Results ── -->
  <div class="section">
    <h2>Per-Question Results</h2>
    <table>
      <thead>
        <tr>
          <th>#</th>
          <th>Question</th>
          <th>Submitted</th>
          <th>OK</th>
          <th>Failed</th>
          <th>Skipped</th>
          <th>Avg Response</th>
          <th>DB p50</th>
          <th>DB p95</th>
          <th>DB Max</th>
        </tr>
      </thead>
      <tbody>${questionRows}
      </tbody>
    </table>
  </div>

  <!-- ── DB Response Time Distribution ── -->
  <div class="section">
    <h2>DB Response Time Distribution</h2>
    <p style="color:#888;font-size:13px;margin-bottom:12px">All Supabase API calls (player answers) combined. Measured as round-trip from client to Supabase REST API (includes network + DB processing).</p>
    <div class="percentile-grid">
      <div class="percentile-card">
        <div class="p-label">p50 (Median)</div>
        <div class="p-value">${allApiTimes.length > 0 ? fmtMs(percentile(allApiTimes, 50)) : '-'}</div>
      </div>
      <div class="percentile-card">
        <div class="p-label">p90</div>
        <div class="p-value">${allApiTimes.length > 0 ? fmtMs(percentile(allApiTimes, 90)) : '-'}</div>
      </div>
      <div class="percentile-card">
        <div class="p-label">p95</div>
        <div class="p-value">${allApiTimes.length > 0 ? fmtMs(percentile(allApiTimes, 95)) : '-'}</div>
      </div>
      <div class="percentile-card">
        <div class="p-label">p99</div>
        <div class="p-value">${allApiTimes.length > 0 ? fmtMs(percentile(allApiTimes, 99)) : '-'}</div>
      </div>
      <div class="percentile-card">
        <div class="p-label">Max</div>
        <div class="p-value">${allApiTimes.length > 0 ? fmtMs(Math.max(...allApiTimes)) : '-'}</div>
      </div>
      <div class="percentile-card">
        <div class="p-label">Total Calls</div>
        <div class="p-value">${allApiTimes.length}</div>
      </div>
    </div>
  </div>

  <!-- ── DB Operations Breakdown ── -->
  <div class="section">
    <h2>DB Operations Breakdown</h2>
    <p style="color:#888;font-size:13px;margin-bottom:12px">Timing for every Supabase REST API call, grouped by operation type.</p>
    <table>
      <thead>
        <tr>
          <th>Operation</th>
          <th>Table</th>
          <th>Count</th>
          <th>Avg</th>
          <th>p50</th>
          <th>p95</th>
          <th>Max</th>
          <th>Failures</th>
        </tr>
      </thead>
      <tbody>${dbRows}
      </tbody>
    </table>
  </div>

  <!-- ── Player Details ── -->
  <div class="section">
    <h2>Player Details <span style="font-size:13px;color:#888;font-weight:normal">(click a row to expand)</span></h2>
    <div class="filter-bar">
      <label>Filter:</label>
      <input type="text" id="playerFilter" placeholder="Search player name..." oninput="filterPlayers()">
      <select id="playerStatusFilter" onchange="filterPlayers()">
        <option value="all">All Players</option>
        <option value="failed">Has Failures</option>
        <option value="ok">All OK</option>
      </select>
    </div>
    <table id="playerTable">
      <thead>
        <tr>
          <th>Player</th>
          <th>Join</th>
          <th>Join Time</th>
          <th>Answered</th>
          <th>Skipped</th>
          <th>Failed</th>
          <th>Avg DB</th>
          <th>Max DB</th>
        </tr>
      </thead>
      <tbody>${playerRows}
      </tbody>
    </table>
  </div>

  <!-- ── Errors ── -->
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
    <p style="color:#27ae60;font-weight:600">No errors recorded.</p>
  </div>`}

</div>

<div class="footer">
  Generated by quiz-game E2E Load Test &nbsp;|&nbsp; ${startTimeStr}
</div>

<script>
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
    const rows = document.querySelectorAll('#playerTable tbody .player-row');
    rows.forEach(row => {
      const name = row.getAttribute('data-player').toLowerCase();
      const failTd = row.children[5];
      const failCount = parseInt(failTd.textContent) || 0;
      const joinTd = row.children[1];
      const joinFailed = joinTd.classList.contains('fail');

      let show = name.includes(text);
      if (status === 'failed') show = show && (failCount > 0 || joinFailed);
      if (status === 'ok') show = show && failCount === 0 && !joinFailed;

      row.style.display = show ? '' : 'none';
      const detail = row.nextElementSibling;
      if (detail && detail.classList.contains('detail-row')) {
        if (!show) detail.classList.remove('show');
      }
    });
  }
</script>

</body>
</html>`;

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `test-report-${timestamp}.html`;
  writeFileSync(filename, html, 'utf-8');
  console.log(`\n  HTML report saved: ${filename}`);
  return filename;
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n========== E2E Load Test: 100 Players + Admin ==========\n');

  stats.testStartTime = Date.now();

  // ── Phase 0: Init ──────────────────────────────────────────────────────────
  console.log('[Phase 0] Initializing...');
  await adminLogin();
  await cleanTestData();
  const questions = await fetchQuestions();
  console.log(`  Found ${questions.length} questions.\n`);

  // ── Phase 1: Players join ──────────────────────────────────────────────────
  console.log(`[Phase 1] ${NUM_PLAYERS} players joining...`);
  const players = Array.from({ length: NUM_PLAYERS }, (_, i) => createPlayer(i + 1));

  const joinResults = await Promise.all(players.map((p) => p.join()));
  const activePlayers = players.filter((_, i) => joinResults[i]);
  console.log(`  ${activePlayers.length} players joined successfully.`);

  // Subscribe all active players to realtime
  for (const p of activePlayers) {
    p.subscribe();
  }
  await sleep(2000); // Let subscriptions settle
  console.log('  All players subscribed to realtime.\n');

  // ── Phase 2: Question loop ─────────────────────────────────────────────────
  for (let qi = 0; qi < questions.length; qi++) {
    const q = questions[qi];
    const qNum = qi + 1;
    initQuestionStats(q.id);

    console.log(`[Phase 2] Question ${qNum}/${questions.length} (id=${q.id}): ${q.question?.slice(0, 40)}...`);

    // 1. Admin opens answering
    console.log('  Admin -> playing');
    await updateGameStatus('playing', q.id);

    // 2. Wait for realtime propagation
    await randomSleep(1000, 2000);

    // 3. All players answer concurrently
    console.log('  Players answering...');
    await Promise.all(activePlayers.map((p) => p.answer(q.id)));

    // 4. Wait for countdown to end (simulate remaining time)
    const waitSec = 15;
    console.log(`  Waiting ${waitSec}s for countdown...`);
    await sleep(waitSec * 1000);

    // 5. Admin stops answering
    console.log('  Admin -> stopped');
    await updateGameStatus('stopped');

    // 6. Wait for auto-submit
    await sleep(2000);

    // 7. Admin scores
    console.log('  Admin scoring...');
    const correctAnswer = q.answer || 1;
    const points = q.points || 1000;
    await adminScoreQuestion(q.id, correctAnswer, points);

    // 8. Admin switches to scoring state
    console.log('  Admin -> scoring');
    await updateGameStatus('scoring');

    // 9. Simulate viewing leaderboard
    await randomSleep(3000, 5000);

    // 10. Admin moves to next question (or stays if last)
    if (qi < questions.length - 1) {
      const nextQ = questions[qi + 1];
      console.log(`  Admin -> waiting (next q=${nextQ.id})`);
      await updateGameStatus('waiting', nextQ.id);
      await sleep(1000);
    }

    const qs = stats.perQuestion[q.id];
    console.log(
      `  Done: ${qs.submitted} submitted, ${qs.succeeded} ok, ${qs.failed} fail, ${qs.skipped} skip\n`
    );
  }

  // ── Phase 3: End game ──────────────────────────────────────────────────────
  console.log('[Phase 3] Ending game...');
  await updateGameStatus('ended');

  // Cleanup all player subscriptions
  console.log('  Cleaning up player connections...');
  await Promise.all(activePlayers.map((p) => p.cleanup()));

  stats.testEndTime = Date.now();

  // Print console report
  printReport(questions);

  // Generate HTML report
  generateHtmlReport(questions);

  console.log('\nLoad test complete.\n');
  process.exit(0);
}

main().catch((err) => {
  console.error('\nFATAL:', err);
  process.exit(1);
});
