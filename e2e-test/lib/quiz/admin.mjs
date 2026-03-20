/**
 * Admin Supabase operations + browser automation (Playwright clicks).
 */
import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_KEY, ADMIN_USERNAME, ADMIN_PASSWORD, getGameGroupId, setGameGroupId } from '../config.mjs';
import { sleep, now, fmtMs, withRetry } from '../helpers.mjs';
import { recordStep, recordError } from '../timing.mjs';
import { getAdminPage } from '../browser.mjs';

// ─── Supabase Client Factory ───────────────────────────────────────────────────

export function newClient() {
  return createClient(SUPABASE_URL, SUPABASE_KEY, {
    realtime: { params: { eventsPerSecond: 10 } },
  });
}

// ─── Admin Client ──────────────────────────────────────────────────────────────

export const admin = newClient();

// ─── Admin Browser Automation ──────────────────────────────────────────────────

export async function adminSelectQuestion(questionId) {
  const adminPage = getAdminPage();
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

export async function adminClickStart() {
  const adminPage = getAdminPage();
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

export async function adminClickStop() {
  const adminPage = getAdminPage();
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

export async function adminClickReveal() {
  const adminPage = getAdminPage();
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

export async function adminClickScore() {
  const adminPage = getAdminPage();
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

export async function adminClickNext() {
  const adminPage = getAdminPage();
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

export async function adminClickEnd() {
  const adminPage = getAdminPage();
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

// ─── Admin Supabase Operations ─────────────────────────────────────────────────

export async function adminLogin() {
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

export async function cleanTestData() {
  const t0 = now();

  const { error: e1 } = await admin.from('responses').delete().like('player_name', 'test_%');
  if (e1) recordError('clean-responses', e1);

  const { error: e1b } = await admin.from('player_scores').delete().like('player_name', 'test_%');
  if (e1b) recordError('clean-player-scores', e1b);

  const { error: e2 } = await admin.from('players').delete().like('name', 'test_%');
  if (e2) recordError('clean-players', e2);

  const { error: e3 } = await admin.from('game_status').update({ state: 'waiting', current_q_id: 1, start_time: 0 }).eq('id', 1);
  if (e3) recordError('reset-game-status', e3);

  const dur = now() - t0;
  recordStep('setup', 'clean-test-data', '', dur);
  console.log(`  Old test data cleaned (${fmtMs(dur)})`);
}

export async function fetchQrToken() {
  const t0 = now();
  const { data, error } = await admin.from('qr_tokens').select('token').limit(1).single();
  const dur = now() - t0;
  recordStep('setup', 'fetch-qr-token', '', dur, !error && !!data);
  if (error || !data) throw new Error(`Failed to fetch QR token: ${error?.message || 'no token'}`);
  return data.token;
}

export async function fetchGameGroupId() {
  const { data } = await admin.from('game_status').select('current_group_id').eq('id', 1).single();
  return data?.current_group_id || null;
}

export async function fetchQuestions() {
  const t0 = now();
  // Read current group_id to filter questions the same way admin.html does
  const gameGroupId = await fetchGameGroupId();
  setGameGroupId(gameGroupId);
  let query = admin.from('questions').select('*');
  if (gameGroupId) {
    query = query.eq('group_id', gameGroupId);
  }
  const { data, error } = await query
    .order('sort_order', { ascending: true })
    .order('id', { ascending: true });
  const dur = now() - t0;
  recordStep('setup', 'fetch-questions', `${data?.length || 0} questions (group_id=${gameGroupId})`, dur, !error && !!data);
  if (error) throw new Error(`Failed to fetch questions: ${error.message}`);
  if (!data || data.length === 0) throw new Error(`No questions found for group_id=${gameGroupId}.`);
  console.log(`  ${data.length} questions loaded (group_id=${gameGroupId}, ${fmtMs(dur)})`);
  return data;
}

export async function updateGameStatus(state, currentQId) {
  const gameGroupId = getGameGroupId();
  const payload = { state, start_time: Date.now() };
  if (currentQId !== undefined) payload.current_q_id = currentQId;

  const sentAt = Date.now();  // capture BEFORE update for accurate realtime lag
  const t0 = now();
  const { error } = await withRetry(
    () => admin.from('game_status').update(payload).eq('id', 1),
    { maxRetries: 2, baseDelayMs: 1000, label: `update-game-status(${state})` }
  );
  const dur = now() - t0;
  const detail = currentQId !== undefined ? `q=${currentQId}` : '';
  recordStep('admin', `state->${state}`, detail, dur, !error);
  if (error) recordError(`update-game-status(${state})`, error);
  return { durationMs: dur, sentAt };
}

/**
 * Score a question using the same RPC the real admin uses.
 */
export async function adminScoreViaRPC(questionId, correctAnswer) {
  const gameGroupId = getGameGroupId();
  const t0 = now();
  const { data, error } = await withRetry(
    () => admin.rpc('score_question', {
      p_question_id: questionId,
      p_correct_answer: correctAnswer,
      p_group_id: gameGroupId,
    }),
    { maxRetries: 2, baseDelayMs: 1000, label: `score-question-rpc(q${questionId})` }
  );
  const dur = now() - t0;
  recordStep('admin', 'score-question-rpc', `q=${questionId}, correct=${correctAnswer}`, dur, !error);
  if (error) recordError(`score-question-rpc(q${questionId})`, error);
  return { durationMs: dur, correctCount: data?.correct_count ?? 0 };
}

/**
 * Fetch response counts per choice (like admin.html revealed state).
 */
export async function fetchResponseCounts(questionId) {
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
export async function fetchLeaderboard() {
  const gameGroupId = getGameGroupId();
  const t0 = now();
  const { data, error } = await admin.from('player_scores')
    .select('player_name, score')
    .eq('group_id', gameGroupId)
    .order('score', { ascending: false });
  const dur = now() - t0;
  recordStep('admin', 'fetch-leaderboard', `${data?.length || 0} players`, dur, !error);
  return { durationMs: dur, players: data || [] };
}

/**
 * Fetch player_stats RPC (like admin.html PDF export).
 */
export async function fetchPlayerStats() {
  const gameGroupId = getGameGroupId();
  const t0 = now();
  const { data, error } = await admin.rpc('get_player_stats', { p_group_id: gameGroupId });
  const dur = now() - t0;
  recordStep('admin', 'fetch-player-stats', `${data?.length || 0} rows`, dur, !error);
  return { durationMs: dur, data: data || [] };
}
