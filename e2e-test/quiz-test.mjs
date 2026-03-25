/**
 * E2E Load Test: 70 Concurrent Players + Admin Browser + 1 test_viewer
 *
 * Admin browser is launched automatically (logged in, navigated to admin.html).
 * You operate the admin page manually; the test waits for each state change,
 * then triggers player actions automatically.
 *
 * Flow per question:
 *   1. Console prompts you to perform an admin action
 *   2. Test polls game_status until the expected state is reached
 *   3. Players respond automatically (answer, fetch scores, etc.)
 *
 * Usage: node quiz-test.mjs
 */

import { NUM_PLAYERS, ANSWER_TIMEOUT_MS } from './lib/config.mjs';
import { sleep, now, fmtMs, percentile, staggeredAll } from './lib/helpers.mjs';
import { timing, stats, initQStats, recordStep, recordError, phaseStart, phaseEnd } from './lib/timing.mjs';
import { launchBrowsers, closeBrowsers, getUserPage } from './lib/browser.mjs';
import {
  admin, adminLogin, cleanTestData, fetchQrToken, fetchQuestions,
  waitForState, getCurrentState,
  fetchResponseCounts, fetchLeaderboard, fetchPlayerStats,
} from './lib/quiz/admin.mjs';
import { createPlayer } from './lib/quiz/player.mjs';
import { runEdgeCaseTests, validateDataIntegrity, evaluatePassFail, measureRealtimePropagation } from './lib/quiz/validators.mjs';
import { printReport, generateHtmlReport } from './lib/quiz/report.mjs';

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n========== E2E Load Test: ${NUM_PLAYERS} Players + Admin Browser (Detailed Timing) ==========\n`);

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

  // Launch admin + test_viewer browsers
  console.log('  Launching browsers (admin + test_viewer)...');
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

  // ══════════════════════════════════════════════════════════════════════════════
  // Phase 2: Question loop (Admin manual, Players automated)
  // ══════════════════════════════════════════════════════════════════════════════
  phaseStart('2-question-loop');

  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║  Admin 手動模式：請在 admin.html 操作遊戲流程              ║');
  console.log('║  測試會自動偵測狀態變更並觸發玩家行為                      ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  for (let qi = 0; qi < questions.length; qi++) {
    const q = questions[qi];
    const qNum = qi + 1;
    initQStats(q.id);
    const qs = stats.perQuestion[q.id];
    const phaseName = `2-Q${qNum}`;
    phaseStart(phaseName);

    console.log(`\n[Q${qNum}/${questions.length}] id=${q.id}: ${(q.question || '').slice(0, 40)}...`);

    // ── Step 1: Wait for admin to click "開放作答" → playing ──
    console.log('  ⏳ 等待 Admin 點擊「開放作答」...');
    const playResult = await waitForState('playing', { expectedQId: q.id });
    qs.stateTransitions['playing'] = playResult.durationMs;
    console.log(`  [1] Admin -> playing (detected in ${fmtMs(playResult.durationMs)})`);

    // Measure realtime propagation for "playing"
    const playingLags = await measureRealtimePropagation(activePlayers, playResult.sentAt, 5000);
    qs.realtimePropagation.push(...playingLags);
    timing.realtimeLags.push(...playingLags);
    if (playingLags.length > 0) {
      console.log(`  [1] Realtime propagation: ${playingLags.length} received, p50=${fmtMs(percentile(playingLags, 50))}, p95=${fmtMs(percentile(playingLags, 95))}`);
    }

    // Wait for propagation to settle
    await sleep(500);

    // ── Step 2+3: Players answer concurrently ──
    console.log('  [2] Players answering...');
    const answerT0 = now();
    let answerAborted = false;
    const answerPromises = [];
    for (let i = 0; i < activePlayers.length; i += 10) {
      const batch = activePlayers.slice(i, i + 10);
      const batchDelay = (i / 10) * 200;
      for (const p of batch) {
        answerPromises.push(
          sleep(batchDelay).then(() => {
            if (answerAborted) { qs.skipped++; return; }
            return p.answer(q.id, () => answerAborted).catch(e => recordError(`answer(${p.name})`, e));
          })
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

    // Abort orphaned promises to prevent snowball effect on subsequent questions
    if (!allDone) {
      answerAborted = true;
      // Grace period for in-flight RPCs (already past the abort check) to complete
      await Promise.race([allAnswered, sleep(5000)]);
    }

    const answerDur = now() - answerT0;
    const submitted = qs.submitted + qs.skipped;
    if (allDone) {
      console.log(`  [2+3] All players answered: ${submitted}/${activePlayers.length} (${fmtMs(answerDur)})`);
    } else {
      console.log(`  [2+3] ⚠ Timeout: ${submitted}/${activePlayers.length} answered, ${qs.skipped} aborted (${fmtMs(answerDur)})`);
    }
    recordStep('question', 'answer-phase', `q=${q.id}, answered=${submitted}/${activePlayers.length}, allDone=${allDone}`, answerDur);

    // ── Step 4: Wait for admin to click "停止作答" → stopped ──
    console.log('  ⏳ 等待 Admin 點擊「停止作答」...');
    const stopResult = await waitForState('stopped');
    qs.stateTransitions['stopped'] = stopResult.durationMs;
    console.log(`  [4] Admin -> stopped (detected in ${fmtMs(stopResult.durationMs)})`);

    // Measure realtime for "stopped"
    const stoppedLags = await measureRealtimePropagation(activePlayers, stopResult.sentAt, 5000);
    qs.realtimePropagation.push(...stoppedLags);
    timing.realtimeLags.push(...stoppedLags);

    // ── Step 5: Wait for admin to click "公布答案" → revealed ──
    console.log('  ⏳ 等待 Admin 點擊「公布答案」...');
    const revealResult = await waitForState('revealed');
    qs.stateTransitions['revealed'] = revealResult.durationMs;
    console.log(`  [5] Admin -> revealed (detected in ${fmtMs(revealResult.durationMs)})`);

    // Measure realtime for "revealed"
    const revealLags = await measureRealtimePropagation(activePlayers, revealResult.sentAt, 5000);
    qs.realtimePropagation.push(...revealLags);
    timing.realtimeLags.push(...revealLags);

    // Fetch response counts
    const respCounts = await fetchResponseCounts(q.id);
    qs.responseCountFetchMs = respCounts.durationMs;
    console.log(`  [5] Response counts: total=${respCounts.total}, fetch=${fmtMs(respCounts.durationMs)}`);

    // ── Step 6+7: Wait for admin to click "結算" → scoring ──
    console.log('  ⏳ 等待 Admin 點擊「結算」...');
    const scoringResult = await waitForState('scoring');
    qs.scoringMs = scoringResult.durationMs;
    qs.stateTransitions['scoring'] = scoringResult.durationMs;
    console.log(`  [6+7] Admin -> scoring (detected in ${fmtMs(scoringResult.durationMs)})`);

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

    // ── Step 9: Fetch leaderboard ──
    console.log('  [9] Fetching leaderboard...');
    const lb = await fetchLeaderboard();
    qs.leaderboardFetchMs = lb.durationMs;
    console.log(`  [9] Leaderboard: ${lb.players.length} players, ${fmtMs(lb.durationMs)}`);

    // ── Step 10: Wait for admin to click "下一題" or last question ──
    if (qi < questions.length - 1) {
      console.log(`  ⏳ 等待 Admin 點擊「下一題」...`);
      const waitResult = await waitForState('waiting');
      qs.stateTransitions['waiting'] = waitResult.durationMs;
      console.log(`  [10] Admin -> waiting (detected in ${fmtMs(waitResult.durationMs)})`);

      // Measure realtime for "waiting" (next question)
      const waitingLags = await measureRealtimePropagation(activePlayers, waitResult.sentAt, 5000);
      qs.realtimePropagation.push(...waitingLags);
      timing.realtimeLags.push(...waitingLags);
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

  // Wait for admin to click "結束遊戲" → ended
  console.log('  ⏳ 等待 Admin 點擊「結束遊戲」...');
  const endResult = await waitForState('ended');
  console.log(`  state->ended (detected in ${fmtMs(endResult.durationMs)})`);

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
  console.log(`  Final leaderboard: ${fmtMs(finalLb.durationMs)}`);
  const playerStats = await fetchPlayerStats();
  console.log(`  Player stats (PDF export): ${fmtMs(playerStats.durationMs)}`);

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
