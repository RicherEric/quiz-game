/**
 * Console report + HTML report generation.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NUM_PLAYERS, E2E_DIR } from '../config.mjs';
import { fmtMs, percentile, escapeHtml, stdDev, throughput } from '../helpers.mjs';
import { timing, stats } from '../timing.mjs';

// ─── Console Report ────────────────────────────────────────────────────────────

export function printReport(questions) {
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
    const bcTotal = stats.scoreBroadcastHits + stats.scoreBroadcastMisses;
    if (bcTotal > 0) console.log(`    Score broadcast:    ${stats.scoreBroadcastHits}/${bcTotal} hit (${Math.round(stats.scoreBroadcastHits / bcTotal * 100)}%), ${stats.scoreBroadcastMisses} fallback RPC`);
    if (pfTimes.length > 0) console.log(`    Player fetch (fb):  p50=${fmtMs(percentile(pfTimes, 50))}, p95=${fmtMs(percentile(pfTimes, 95))}, max=${fmtMs(Math.max(...pfTimes))}`);
    const plTimes = stats.preloadTimes || [];
    if (plTimes.length > 0) console.log(`    Question preload:   p50=${fmtMs(percentile(plTimes, 50))}, p95=${fmtMs(percentile(plTimes, 95))}, max=${fmtMs(Math.max(...plTimes))}`);
    const rvTimes = stats.revealedFetchTimes || [];
    if (rvTimes.length > 0) console.log(`    Revealed fetch:     p50=${fmtMs(percentile(rvTimes, 50))}, p95=${fmtMs(percentile(rvTimes, 95))}, max=${fmtMs(Math.max(...rvTimes))}`);
    if (stats.pollingCount) console.log(`    Polling queries:    ${stats.pollingCount} total during test`);
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

export function generateHtmlReport(questions) {
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
        <td>${qs.scoreBroadcastHits}/${qs.scoreBroadcastHits + qs.scoreFallbackCount}</td>
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
    </div>
    <div class="summary-card">
      <div class="label">Score Broadcast Hit</div>
      <div class="value ${(stats.scoreBroadcastHits + stats.scoreBroadcastMisses) > 0 && stats.scoreBroadcastHits / (stats.scoreBroadcastHits + stats.scoreBroadcastMisses) >= 0.8 ? 'green' : 'orange'}" style="font-size:18px">${(stats.scoreBroadcastHits + stats.scoreBroadcastMisses) > 0 ? Math.round(stats.scoreBroadcastHits / (stats.scoreBroadcastHits + stats.scoreBroadcastMisses) * 100) + '%' : '-'} <span style="font-size:12px;color:#64748b">(${stats.scoreBroadcastHits}/${stats.scoreBroadcastHits + stats.scoreBroadcastMisses})</span></div>
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
            <th>Scoring RPC</th><th>Viewer Delay</th><th>Score BC/FB</th><th>Resp Fetch</th><th>RT Lag p50</th><th>RT Lag p95</th><th>State Transitions</th>
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

      <h3 style="margin-top:20px;margin-bottom:8px;color:#94a3b8;font-size:14px">Player Fetch Operations (fallback RPC + end leaderboard)</h3>
      <p style="color:#64748b;font-size:12px;margin-bottom:8px">Score broadcast hit: ${stats.scoreBroadcastHits}/${stats.scoreBroadcastHits + stats.scoreBroadcastMisses} (${(stats.scoreBroadcastHits + stats.scoreBroadcastMisses) > 0 ? Math.round(stats.scoreBroadcastHits / (stats.scoreBroadcastHits + stats.scoreBroadcastMisses) * 100) : 0}%). Only broadcast-miss players call get_my_score RPC (like real index.html behavior).</p>
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
  const filename = join(E2E_DIR, `test-report-${timestamp}.html`);
  writeFileSync(filename, html, 'utf-8');
  console.log(`\n  HTML report saved: ${filename}`);
  return filename;
}
