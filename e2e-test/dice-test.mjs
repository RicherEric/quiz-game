/**
 * Dice E2E Load Test: 100 Concurrent Players + 1 Admin
 *
 * Simulates a complete dice (魚蝦蟹) game session with detailed timing:
 * - 1 admin controls the game flow (start betting, stop, roll, resolve, next round)
 * - 100 players join, place bets via RPC, receive results via Realtime broadcast
 * - Measures every step: join, bet submission, resolve RPC, realtime propagation
 * - Generates console + HTML report with SVG charts
 *
 * Usage: node dice-test.mjs
 */

import { NUM_DICE_PLAYERS, NUM_ROUNDS, BETTING_TIMEOUT_MS, getDiceRoomId } from './lib/config.mjs';
import { sleep, now, fmtMs, percentile, staggeredAll } from './lib/helpers.mjs';
import { timing, stats, initQStats, recordStep, recordError, phaseStart, phaseEnd } from './lib/timing.mjs';
import { launchDiceBrowsers, closeBrowsers } from './lib/browser.mjs';
import {
  diceAdmin, cleanDiceTestData, fetchDiceRoomId, fetchDiceQrToken,
  fetchBetStats, fetchDiceLeaderboard, adminResolveViaRPC,
  adminSelectRoom, adminClickStartBetting, adminClickStopBetting,
  adminClickRollRandom, adminClickNextRound, adminClickEndGame,
} from './lib/dice/admin.mjs';
import { createDicePlayer } from './lib/dice/player.mjs';
import {
  runDiceEdgeCaseTests, validateDiceDataIntegrity,
  evaluateDicePassFail, measureDiceRealtimePropagation,
} from './lib/dice/validators.mjs';
import { printDiceReport, generateDiceHtmlReport } from './lib/dice/report.mjs';

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n========== Dice E2E Load Test: 100 Players + Admin ==========\n');

  timing.testStartMs = Date.now();

  // ══════════════════════════════════════════════════════════════════════════
  // Phase 0: Setup
  // ══════════════════════════════════════════════════════════════════════════
  phaseStart('0-setup');
  console.log('[Phase 0] Initializing...');

  const roomId = await fetchDiceRoomId();
  console.log(`  Room ID: ${roomId}`);

  await cleanDiceTestData();

  const qrToken = await fetchDiceQrToken(roomId);
  console.log(`  QR token loaded.`);

  // Launch browser monitors
  console.log('  Launching browser monitors...');
  await launchDiceBrowsers(qrToken);

  // Admin selects room in UI
  await adminSelectRoom(roomId);

  phaseEnd('0-setup');

  // ══════════════════════════════════════════════════════════════════════════
  // Phase 1: Players Join
  // ══════════════════════════════════════════════════════════════════════════
  phaseStart('1-player-join');
  console.log(`\n[Phase 1] ${NUM_DICE_PLAYERS} dice players joining...`);

  const players = Array.from({ length: NUM_DICE_PLAYERS }, (_, i) => createDicePlayer(i + 1, qrToken));

  // Join in batches of 20
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
  recordStep('join', 'all-dice-players-join', `${NUM_DICE_PLAYERS} batched(${BATCH_SIZE})`, joinDur);

  const activePlayers = players.filter((_, i) => joinResults[i]);
  console.log(`  ${activePlayers.length} players joined (total: ${fmtMs(joinDur)})`);

  // Join time distribution
  const joinTimes = Object.values(stats.playerLogs).filter(l => l.joinSuccess).map(l => l.joinTimeMs);
  if (joinTimes.length > 0) {
    console.log(`  Join time: p50=${fmtMs(percentile(joinTimes, 50))}, p95=${fmtMs(percentile(joinTimes, 95))}, max=${fmtMs(Math.max(...joinTimes))}`);
  }

  // Subscribe all active players to realtime
  console.log('  Subscribing all players to realtime...');
  const subscribeResults = await Promise.allSettled(
    activePlayers.map(p =>
      p.subscribe((playerName, state, receivedAt) => {
        // callback fires for every realtime event
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
  await sleep(1000);
  phaseEnd('1-player-join');

  // ══════════════════════════════════════════════════════════════════════════
  // Phase 1.5: Edge Case Tests
  // ══════════════════════════════════════════════════════════════════════════
  await runDiceEdgeCaseTests(qrToken);

  // ══════════════════════════════════════════════════════════════════════════
  // Phase 2: Round Loop (×3 rounds)
  // ══════════════════════════════════════════════════════════════════════════
  phaseStart('2-round-loop');
  for (let round = 1; round <= NUM_ROUNDS; round++) {
    const roundKey = `round_${round}`;
    initQStats(roundKey);
    const qs = stats.perQuestion[roundKey];
    qs.realtimePropagation = [];
    const phaseName = `2-R${round}`;
    phaseStart(phaseName);

    console.log(`\n[R${round}/${NUM_ROUNDS}] Round ${round}`);

    // ── Step 1: Admin "開放押注" → betting ──
    console.log('  [1] Admin -> betting (browser click)');
    const bettingResult = await adminClickStartBetting();
    qs.stateTransitions = qs.stateTransitions || {};
    qs.stateTransitions['betting'] = bettingResult.durationMs;

    // Measure realtime propagation
    const bettingLags = await measureDiceRealtimePropagation(activePlayers, bettingResult.sentAt, 5000);
    qs.realtimePropagation.push(...bettingLags);
    timing.realtimeLags.push(...bettingLags);
    if (bettingLags.length > 0) {
      console.log(`  [1] Realtime propagation: ${bettingLags.length} received, p50=${fmtMs(percentile(bettingLags, 50))}, p95=${fmtMs(percentile(bettingLags, 95))}`);
    }

    await sleep(500);

    // ── Step 2: 100 players place bets ──
    console.log('  [2] Players placing bets...');
    const betT0 = now();
    const betPromises = [];
    for (let i = 0; i < activePlayers.length; i += 10) {
      const batch = activePlayers.slice(i, i + 10);
      const batchDelay = (i / 10) * 50;
      for (const p of batch) {
        betPromises.push(
          sleep(batchDelay).then(() => p.placeBets(roomId, round).catch(e => recordError(`bet(${p.name})`, e)))
        );
      }
    }

    const allBetted = Promise.all(betPromises);
    let allDone = false;
    await Promise.race([
      allBetted.then(() => { allDone = true; }),
      sleep(BETTING_TIMEOUT_MS),
    ]);
    const betDur = now() - betT0;
    console.log(`  [2] Betting phase: ${qs.submitted} bets from ${activePlayers.length} players (${fmtMs(betDur)})${allDone ? '' : ' (TIMEOUT)'}`);
    recordStep('round', 'betting-phase', `round=${round}, bets=${qs.submitted}, allDone=${allDone}`, betDur);

    // ── Step 3: Admin "停止押注" → stopped ──
    console.log('  [3] Admin -> stopped (browser click)');
    const stopResult = await adminClickStopBetting();
    qs.stateTransitions['stopped'] = stopResult.durationMs;

    const stoppedLags = await measureDiceRealtimePropagation(activePlayers, stopResult.sentAt, 5000);
    qs.realtimePropagation.push(...stoppedLags);
    timing.realtimeLags.push(...stoppedLags);

    await sleep(500);

    // ── Step 4: Admin "擲骰（隨機）" → rolling → resolved ──
    console.log('  [4] Admin -> roll random (browser click, includes animation)');
    const rollResult = await adminClickRollRandom();
    qs.stateTransitions['resolved'] = rollResult.durationMs;
    qs.scoringMs = rollResult.durationMs;
    console.log(`  [4] Roll + resolve: ${fmtMs(rollResult.durationMs)}`);

    const resolvedLags = await measureDiceRealtimePropagation(activePlayers, rollResult.sentAt, 5000);
    qs.realtimePropagation.push(...resolvedLags);
    timing.realtimeLags.push(...resolvedLags);

    // ── Step 5: Players check results (broadcast cache or RPC fallback) ──
    console.log('  [5] Players checking results (broadcast + fallback)...');
    await sleep(1500);  // wait for broadcast propagation

    const broadcastHitPlayers = [];
    const fallbackPlayers = [];
    for (const p of activePlayers) {
      if (p.getPendingResult(round)) {
        broadcastHitPlayers.push(p);
      } else {
        fallbackPlayers.push(p);
      }
    }
    stats.scoreBroadcastHits += broadcastHitPlayers.length;
    stats.scoreBroadcastMisses += fallbackPlayers.length;
    qs.scoreBroadcastHits = broadcastHitPlayers.length;
    qs.scoreFallbackCount = fallbackPlayers.length;

    let resultFetchTimes = [];
    if (fallbackPlayers.length > 0) {
      const fetches = await staggeredAll(
        fallbackPlayers.map(p => () => p.fetchMyResult(roomId, round)), 10, 50
      );
      resultFetchTimes = fetches.map(r => r.durationMs);
      stats.playerFetchTimes.push(...resultFetchTimes);
    }
    console.log(`  [5] Results: ${broadcastHitPlayers.length} via broadcast, ${fallbackPlayers.length} fallback RPC${resultFetchTimes.length > 0 ? `, RPC p50=${fmtMs(percentile(resultFetchTimes, 50))}` : ''}`);

    // ── Step 6: Admin fetch bet stats + leaderboard ──
    console.log('  [6] Admin fetching stats...');
    const betStatsResult = await fetchBetStats(roomId, round);
    const lbResult = await fetchDiceLeaderboard(roomId);
    console.log(`  [6] Bet stats: ${fmtMs(betStatsResult.durationMs)}, Leaderboard: ${lbResult.players.length} players (${fmtMs(lbResult.durationMs)})`);

    await sleep(3000);

    // ── Step 7: Admin "下一局" (except last round) ──
    if (round < NUM_ROUNDS) {
      console.log(`  [7] Admin -> next round (browser click)`);
      const nextResult = await adminClickNextRound();
      qs.stateTransitions['waiting'] = nextResult.durationMs;

      const waitingLags = await measureDiceRealtimePropagation(activePlayers, nextResult.sentAt, 5000);
      qs.realtimePropagation.push(...waitingLags);
      timing.realtimeLags.push(...waitingLags);

      await sleep(2000);
    }

    console.log(`  Done: ${qs.submitted} bets, ${qs.succeeded} ok, ${qs.failed} fail`);
    phaseEnd(phaseName);
  }
  phaseEnd('2-round-loop');

  // ══════════════════════════════════════════════════════════════════════════
  // Phase 3: End Game
  // ══════════════════════════════════════════════════════════════════════════
  phaseStart('3-end-game');
  console.log('\n[Phase 3] Ending game...');

  const endResult = await adminClickEndGame();
  console.log(`  state->ended (browser click): ${fmtMs(endResult.durationMs)}`);

  const endLags = await measureDiceRealtimePropagation(activePlayers, endResult.sentAt, 5000);
  timing.realtimeLags.push(...endLags);
  if (endLags.length > 0) {
    console.log(`  Realtime propagation: ${endLags.length} received, p50=${fmtMs(percentile(endLags, 50))}`);
  }

  // Players fetch final leaderboard
  console.log('  Players fetching final leaderboard...');
  const endFetchT0 = now();
  const endFetches = await staggeredAll(
    activePlayers.map(p => () => p.fetchEndLeaderboard(roomId)), 10, 50
  );
  const endFetchDur = now() - endFetchT0;
  const endFetchTimes = endFetches.map(r => r.durationMs);
  recordStep('player', 'fetch-end-leaderboard', `count=${activePlayers.length}`, endFetchDur);
  stats.playerFetchTimes.push(...endFetchTimes);
  console.log(`  End leaderboard fetch: p50=${fmtMs(percentile(endFetchTimes, 50))}, p95=${fmtMs(percentile(endFetchTimes, 95))}`);

  // Admin fetch final leaderboard
  const finalLb = await fetchDiceLeaderboard(roomId);
  console.log(`  Admin final leaderboard: ${finalLb.players.length} players (${fmtMs(finalLb.durationMs)})`);

  // Data integrity validation
  await validateDiceDataIntegrity(NUM_ROUNDS);

  phaseEnd('3-end-game');

  // ══════════════════════════════════════════════════════════════════════════
  // Phase 4: Cleanup
  // ══════════════════════════════════════════════════════════════════════════
  phaseStart('4-cleanup');
  console.log('\n[Phase 4] Cleaning up...');
  await Promise.all(activePlayers.map(p => p.cleanup()));
  console.log(`  ${activePlayers.length} player connections closed.`);

  await closeBrowsers();
  console.log('  Browser monitors closed.');

  phaseEnd('4-cleanup');

  timing.testEndMs = Date.now();

  // Evaluate pass/fail criteria
  const allPass = evaluateDicePassFail(NUM_ROUNDS);

  // Print console report
  printDiceReport(NUM_ROUNDS);

  // Generate HTML report
  generateDiceHtmlReport(NUM_ROUNDS);

  console.log(`\nDice load test complete. Result: ${allPass ? 'ALL PASS' : 'SOME CRITERIA FAILED'}\n`);
  process.exit(allPass ? 0 : 1);
}

main().catch(err => {
  console.error('\nFATAL:', err);
  closeBrowsers().finally(() => process.exit(1));
});
