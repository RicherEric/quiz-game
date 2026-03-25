/**
 * Edge case tests, data integrity validation, pass/fail criteria,
 * and realtime propagation measurement.
 */
import { NUM_PLAYERS, getGameGroupId } from '../config.mjs';
import { sleep, now, fmtMs, percentile } from '../helpers.mjs';
import { timing, stats, phaseStart, phaseEnd, recordStep, recordError } from '../timing.mjs';
import { admin, newClient } from './admin.mjs';

// ─── Edge Case Tests ──────────────────────────────────────────────────────────

/**
 * Run edge-case tests to verify the system rejects invalid operations.
 * Each test records pass/fail into stats.edgeCases.
 */
export async function runEdgeCaseTests(qrToken, questions) {
  console.log('\n[Phase 1.5] Edge case tests...');
  phaseStart('1.5-edge-cases');

  const gameGroupId = getGameGroupId();
  const edgeClient = newClient();
  const testName = `test_user_001`;     // already exists from Phase 1

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

  // ── Test 3: Submit by non-existent player ──
  {
    const q = questions[0];
    const fakeName = `test_edge_nonexist_${Date.now()}`;
    const t0 = now();
    const { data, error } = await edgeClient.rpc('submit_response', {
      p_player_name: fakeName,
      p_question_id: q.id,
      p_choice: 1,
      p_response_time_ms: 5000,
      p_qr_token: qrToken,
    });
    const dur = now() - t0;
    const pass = !!error;
    stats.edgeCases.push({
      name: 'submit-nonexistent-player',
      description: '未加入的玩家提交答案應被拒絕',
      expected: 'error (Not a verified player)',
      actual: error ? `rejected: ${error.message}` : `allowed (unexpected!)`,
      pass,
    });
    recordStep('edge-case', 'submit-nonexistent-player', '', dur, pass);
    console.log(`  [EC3] Submit by non-existent player: ${pass ? 'PASS' : 'FAIL'} (${fmtMs(dur)})`);
    // Clean up if wrongly inserted
    if (!error) await admin.from('responses').delete().eq('player_name', fakeName);
  }

  // ── Test 4: Submit with null player name ──
  {
    const q = questions[0];
    const t0 = now();
    const { data, error } = await edgeClient.rpc('submit_response', {
      p_player_name: null,
      p_question_id: q.id,
      p_choice: 1,
      p_response_time_ms: 5000,
      p_qr_token: qrToken,
    });
    const dur = now() - t0;
    const pass = !!error;
    stats.edgeCases.push({
      name: 'submit-null-player',
      description: '空玩家名稱提交答案應被拒絕',
      expected: 'error (Not a verified player)',
      actual: error ? `rejected: ${error.message}` : `allowed (unexpected!)`,
      pass,
    });
    recordStep('edge-case', 'submit-null-player', '', dur, pass);
    console.log(`  [EC4] Submit with null player: ${pass ? 'PASS' : 'FAIL'} (${fmtMs(dur)})`);
  }

  // ── Test 5: Double answer submission (same player, same question) ──
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
      p_group_id: gameGroupId,
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
    await admin.rpc('score_question', { p_question_id: q.id, p_correct_answer: q.answer || 1, p_group_id: gameGroupId });
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
    await admin.from('player_scores').update({ score: 0 }).like('player_name', 'test_%');
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
export async function validateDataIntegrity(questions) {
  console.log('\n  [Data Integrity] Validating...');
  phaseStart('data-integrity');

  const gameGroupId = getGameGroupId();

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
    if (Math.abs(r.scored_points - expectedScore) > 1) {
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
  const { data: allPlayerScores, error: pe } = await admin
    .from('player_scores')
    .select('player_name, score')
    .eq('group_id', gameGroupId);

  // Map to unified format for comparison
  const allPlayers = (allPlayerScores || [])
    .filter(ps => ps.player_name.startsWith('test_') && ps.player_name !== 'test_viewer')
    .map(ps => ({ name: ps.player_name, totalScore: ps.score }));

  if (pe || !allPlayerScores) {
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
    const actual = p.totalScore || 0;
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

export function evaluatePassFail(questions) {
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
    ['duplicate-player-name', 'invalid-qr-token', 'submit-nonexistent-player', 'submit-null-player'].includes(e.name)
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

  // Criterion 13: Player question preload p95 < 3000ms
  const preloadTimes = stats.preloadTimes || [];
  const plP95 = preloadTimes.length > 0 ? percentile(preloadTimes, 95) : 0;
  stats.passFail.push({
    criterion: 'Player question preload p95 < 3000ms',
    threshold: '< 3000ms',
    actual: preloadTimes.length > 0 ? fmtMs(plP95) : 'N/A',
    pass: preloadTimes.length === 0 || plP95 < 3000,
  });

  // Criterion 14: Player revealed-state response fetch p95 < 3000ms
  const revFetchTimes = stats.revealedFetchTimes || [];
  const rvP95 = revFetchTimes.length > 0 ? percentile(revFetchTimes, 95) : 0;
  stats.passFail.push({
    criterion: 'Player revealed fetch (responses) p95 < 3000ms',
    threshold: '< 3000ms',
    actual: revFetchTimes.length > 0 ? fmtMs(rvP95) : 'N/A',
    pass: revFetchTimes.length === 0 || rvP95 < 3000,
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
export async function measureRealtimePropagation(players, sentAt, timeoutMs = 5000) {
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
