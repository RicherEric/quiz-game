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

import { NUM_PLAYERS, ANSWER_TIMEOUT_MS, ADMIN_USERNAME, ADMIN_PASSWORD } from './lib/config.mjs';
import { sleep, now, fmtMs, percentile, staggeredAll } from './lib/helpers.mjs';
import { timing, stats, initQStats, recordStep, recordError, phaseStart, phaseEnd } from './lib/timing.mjs';
import { launchBrowsers, closeBrowsers, getAdminPage, getUserPage } from './lib/browser.mjs';
import {
  admin, adminLogin, cleanTestData, fetchQrToken, fetchQuestions,
  adminSelectQuestion, adminClickStart, adminClickStop, adminClickReveal,
  adminClickScore, adminClickNext, adminClickEnd,
  fetchResponseCounts, fetchLeaderboard, fetchPlayerStats,
} from './lib/quiz/admin.mjs';
import { createPlayer } from './lib/quiz/player.mjs';
import { runEdgeCaseTests, validateDataIntegrity, evaluatePassFail, measureRealtimePropagation } from './lib/quiz/validators.mjs';
import { printReport, generateHtmlReport } from './lib/quiz/report.mjs';

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

  // Join in batches to avoid overwhelming Supabase (502 errors)
  const BATCH_SIZE = 20;
  const BATCH_DELAY_MS = 500;
  const joinResults = new Array(players.length).fill(false);
  const joinT0 = now();
  for (let i = 0; i < players.length; i += BATCH_SIZE) {
    const batch = players.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(batch.map(p => p.join()));
    batchResults.forEach((r, j) => { joinResults[i + j] = r; });
    if (i + BATCH_SIZE < players.length) await sleep(BATCH_DELAY_MS);
  }
  const joinDur = now() - joinT0;
  recordStep('join', 'all-players-join', `${NUM_PLAYERS} batched(${BATCH_SIZE})`, joinDur);

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
  await admin.from('player_scores').update({ score: 0 }).like('player_name', 'test_%');
  console.log('  Edge case residual data cleaned.');

  // Reload admin browser after edge case tests to sync state
  // (edge cases changed game_status via API, admin UI is out of sync)
  const adminPage = getAdminPage();
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
    // Ensure 作答監控 tab is active
    await adminPage.click('#btn-tab-stats');
    await adminPage.waitForSelector('#tab-stats:not(.hidden)', { timeout: 5000 });
    console.log('  Admin browser reloaded and logged in (作答監控).');
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
    console.log('  [2] Players answering...');
    const answerT0 = now();
    const answerPromises = [];
    for (let i = 0; i < activePlayers.length; i += 10) {
      const batch = activePlayers.slice(i, i + 10);
      const batchDelay = (i / 10) * 200;
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
    const userPage = getUserPage();
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

    // ── Step 8: Players get scores — broadcast first, RPC fallback ──
    console.log('  [8] Players checking scores (broadcast + fallback)...');
    await sleep(1000);  // simulate the 1s fallback timeout in index.html

    const broadcastHitPlayers = [];
    const fallbackPlayers = [];
    for (const p of activePlayers) {
      if (p.getPendingScore(q.id)) {
        broadcastHitPlayers.push(p);
      } else {
        fallbackPlayers.push(p);
      }
    }
    stats.scoreBroadcastHits += broadcastHitPlayers.length;
    stats.scoreBroadcastMisses += fallbackPlayers.length;
    qs.scoreBroadcastHits = broadcastHitPlayers.length;
    qs.scoreFallbackCount = fallbackPlayers.length;

    const scoreFetchT0 = now();
    let scoreFetchTimes = [];
    if (fallbackPlayers.length > 0) {
      const scoreFetches = await staggeredAll(
        fallbackPlayers.map(p => () => p.fetchMyScore(q.id)), 10, 50
      );
      scoreFetchTimes = scoreFetches.map(r => r.durationMs);
      stats.playerFetchTimes.push(...scoreFetchTimes);
    }
    const scoreFetchDur = now() - scoreFetchT0;
    recordStep('player', 'fetch-score', `q=${q.id}, broadcast=${broadcastHitPlayers.length}, fallback=${fallbackPlayers.length}`, scoreFetchDur);
    console.log(`  [8] Score: ${broadcastHitPlayers.length} via broadcast, ${fallbackPlayers.length} fallback RPC${scoreFetchTimes.length > 0 ? `, RPC p50=${fmtMs(percentile(scoreFetchTimes, 50))}, p95=${fmtMs(percentile(scoreFetchTimes, 95))}` : ''}`);

    // ── Step 9: Admin fetches leaderboard ──
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
