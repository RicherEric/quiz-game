/**
 * Dice E2E test: Console report + HTML report generation.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NUM_DICE_PLAYERS, E2E_DIR } from '../config.mjs';
import { fmtMs, percentile, escapeHtml, stdDev, throughput } from '../helpers.mjs';
import { timing, stats } from '../timing.mjs';

// ─── Console Report ─────────────────────────────────────────────────────────

export function printDiceReport(numRounds) {
  console.log('\n' + '='.repeat(72));
  console.log('  DICE E2E LOAD TEST REPORT');
  console.log('='.repeat(72));

  const totalDur = (timing.testEndMs - timing.testStartMs) / 1000;
  console.log(`\n  Total duration: ${totalDur.toFixed(1)}s`);
  console.log(`  Players: ${stats.playersCreated} joined / ${stats.playersFailed} failed / ${NUM_DICE_PLAYERS} total`);

  // Phase durations
  console.log('\n  Phase Durations:');
  for (const [name, p] of Object.entries(timing.phases)) {
    const dur = (p.endMs - p.startMs) / 1000;
    console.log(`    ${name.padEnd(30)} ${dur.toFixed(2)}s`);
  }

  // Per-round summary
  const allApiTimes = [];
  console.log('\n  Per-Round Summary:');
  console.log('  ' + '-'.repeat(72));
  console.log(
    '  ' + 'R#'.padEnd(5) + 'Bets'.padEnd(8) + 'OK'.padEnd(6) + 'Fail'.padEnd(6) +
    'API Avg'.padEnd(10) + 'API p95'.padEnd(10) + 'Resolve'.padEnd(12) + 'RT Lag p50'
  );
  console.log('  ' + '-'.repeat(72));

  for (let r = 1; r <= numRounds; r++) {
    const roundKey = `round_${r}`;
    const qs = stats.perQuestion[roundKey];
    if (!qs) continue;
    allApiTimes.push(...qs.apiTimes);
    const rtLagP50 = qs.realtimePropagation?.length > 0 ? fmtMs(percentile(qs.realtimePropagation, 50)) : '-';
    const resolveStep = timing.steps.find(s => s.step === 'dice-resolve-rpc' && s.detail.includes(`round=${r}`));
    const resolveMs = resolveStep ? fmtMs(resolveStep.durationMs) : '-';
    console.log(
      '  ' + `R${r}`.padEnd(5) +
      String(qs.submitted).padEnd(8) +
      String(qs.succeeded).padEnd(6) +
      String(qs.failed).padEnd(6) +
      fmtMs(qs.apiTimes.length > 0 ? qs.apiTimes.reduce((s, t) => s + t, 0) / qs.apiTimes.length : 0).padEnd(10) +
      fmtMs(percentile(qs.apiTimes, 95)).padEnd(10) +
      resolveMs.padEnd(12) +
      rtLagP50
    );
  }

  // Overall API timing
  console.log('\n  Overall API (dice_place_bet) Distribution:');
  if (allApiTimes.length > 0) {
    const mean = allApiTimes.reduce((s, t) => s + t, 0) / allApiTimes.length;
    console.log(`    mean: ${fmtMs(mean)}`);
    console.log(`    p50:  ${fmtMs(percentile(allApiTimes, 50))}`);
    console.log(`    p95:  ${fmtMs(percentile(allApiTimes, 95))}`);
    console.log(`    p99:  ${fmtMs(percentile(allApiTimes, 99))}`);
    console.log(`    max:  ${fmtMs(Math.max(...allApiTimes))}`);
    console.log(`    throughput: ${throughput(allApiTimes.length, timing.testEndMs - timing.testStartMs).toFixed(1)} ops/sec`);
  }

  // System operation timing
  {
    const stTimes = timing.steps
      .filter(s => ['click-start-betting', 'click-stop-betting', 'click-next-round'].includes(s.step))
      .map(s => s.durationMs);
    const rrTimes = timing.steps.filter(s => s.step === 'dice-resolve-rpc').map(s => s.durationMs);
    const afTimes = timing.steps
      .filter(s => ['fetch-bet-stats', 'fetch-dice-leaderboard'].includes(s.step))
      .map(s => s.durationMs);
    const pfTimes = stats.playerFetchTimes;

    console.log('\n  System Operation Timing:');
    if (stTimes.length > 0) console.log(`    State transitions:  p50=${fmtMs(percentile(stTimes, 50))}, p95=${fmtMs(percentile(stTimes, 95))}`);
    if (rrTimes.length > 0) console.log(`    Resolve RPC:        p50=${fmtMs(percentile(rrTimes, 50))}, p95=${fmtMs(percentile(rrTimes, 95))}`);
    if (afTimes.length > 0) console.log(`    Admin fetch:        p50=${fmtMs(percentile(afTimes, 50))}, p95=${fmtMs(percentile(afTimes, 95))}`);
    const bcTotal = stats.scoreBroadcastHits + stats.scoreBroadcastMisses;
    if (bcTotal > 0) console.log(`    Result broadcast:   ${stats.scoreBroadcastHits}/${bcTotal} hit (${Math.round(stats.scoreBroadcastHits / bcTotal * 100)}%), ${stats.scoreBroadcastMisses} fallback`);
    if (pfTimes.length > 0) console.log(`    Player fetch (fb):  p50=${fmtMs(percentile(pfTimes, 50))}, p95=${fmtMs(percentile(pfTimes, 95))}`);
  }

  // Realtime propagation
  if (timing.realtimeLags.length > 0) {
    console.log('\n  Realtime Propagation Lag:');
    console.log(`    p50:  ${fmtMs(percentile(timing.realtimeLags, 50))}`);
    console.log(`    p95:  ${fmtMs(percentile(timing.realtimeLags, 95))}`);
    console.log(`    max:  ${fmtMs(Math.max(...timing.realtimeLags))}`);
  }

  // Edge cases
  if (stats.edgeCases.length > 0) {
    console.log('\n  Edge Case Tests:');
    for (const ec of stats.edgeCases) {
      console.log(`    ${ec.pass ? 'PASS' : 'FAIL'}  ${ec.name}: ${ec.actual}`);
    }
  }

  // Data integrity
  if (stats.dataIntegrity.length > 0) {
    console.log('\n  Data Integrity:');
    for (const di of stats.dataIntegrity) {
      console.log(`    ${di.pass ? 'PASS' : 'FAIL'}  ${di.check}: ${di.detail}`);
    }
  }

  // Pass/Fail
  if (stats.passFail.length > 0) {
    const pfPassed = stats.passFail.filter(p => p.pass).length;
    console.log(`\n  Pass/Fail Criteria: ${pfPassed}/${stats.passFail.length}`);
    for (const pf of stats.passFail) {
      console.log(`    ${pf.pass ? 'PASS' : 'FAIL'}  ${pf.criterion}: ${pf.actual}`);
    }
  }

  // Errors
  console.log(`\n  Total errors: ${stats.errors.length}`);
  if (stats.errors.length > 0) {
    for (const e of stats.errors.slice(0, 15)) console.log(`    - ${e}`);
    if (stats.errors.length > 15) console.log(`    ... and ${stats.errors.length - 15} more`);
  }

  console.log('\n' + '='.repeat(72));
}

// ─── HTML Report ────────────────────────────────────────────────────────────

export function generateDiceHtmlReport(numRounds) {
  const testDuration = ((timing.testEndMs - timing.testStartMs) / 1000).toFixed(1);
  const startTimeStr = new Date(timing.testStartMs).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });

  // Collect all API times
  const allApiTimes = [];
  for (let r = 1; r <= numRounds; r++) {
    const qs = stats.perQuestion[`round_${r}`];
    if (qs) allApiTimes.push(...qs.apiTimes);
  }

  // Phase timeline data
  const phaseEntries = Object.entries(timing.phases)
    .filter(([, p]) => p.endMs > 0)
    .map(([name, p]) => ({ name, duration: p.endMs - p.startMs, start: p.startMs }));
  const minStart = phaseEntries.length > 0 ? Math.min(...phaseEntries.map(p => p.start)) : 0;

  // SVG Timeline
  const timelineWidth = 900;
  const barHeight = 28;
  const labelWidth = 200;
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

  // SVG Per-round API chart
  const qBarWidth = 900;
  const qBarItemH = 36;
  const qBarChartH = numRounds * qBarItemH + 40;
  const allMaxApi = allApiTimes.length > 0 ? Math.max(...allApiTimes) : 1;
  const qScale = (qBarWidth - 200) / allMaxApi;

  let qBarSvg = `<svg width="${qBarWidth}" height="${qBarChartH}" xmlns="http://www.w3.org/2000/svg" style="font-family:monospace;font-size:12px">`;
  for (let r = 1; r <= numRounds; r++) {
    const qs = stats.perQuestion[`round_${r}`];
    if (!qs || qs.apiTimes.length === 0) continue;
    const y = (r - 1) * qBarItemH + 10;
    const p50 = percentile(qs.apiTimes, 50);
    const p95 = percentile(qs.apiTimes, 95);
    qBarSvg += `<text x="4" y="${y + 20}" fill="#ccc">R${r}</text>`;
    qBarSvg += `<rect x="40" y="${y + 2}" width="${Math.max(2, p95 * qScale)}" height="${qBarItemH - 8}" rx="3" fill="#ef4444" opacity="0.4"/>`;
    qBarSvg += `<rect x="40" y="${y + 2}" width="${Math.max(2, p50 * qScale)}" height="${qBarItemH - 8}" rx="3" fill="#3b82f6" opacity="0.8"/>`;
    qBarSvg += `<text x="${40 + Math.max(2, p95 * qScale) + 6}" y="${y + 20}" fill="#aaa">p50=${fmtMs(p50)} p95=${fmtMs(p95)}</text>`;
  }
  qBarSvg += '</svg>';

  // Summary cards
  const apiP50 = allApiTimes.length > 0 ? fmtMs(percentile(allApiTimes, 50)) : '-';
  const apiP95 = allApiTimes.length > 0 ? fmtMs(percentile(allApiTimes, 95)) : '-';
  const rtP50 = timing.realtimeLags.length > 0 ? fmtMs(percentile(timing.realtimeLags, 50)) : '-';
  const rtP95 = timing.realtimeLags.length > 0 ? fmtMs(percentile(timing.realtimeLags, 95)) : '-';
  const pfPassed = stats.passFail.filter(p => p.pass).length;
  const pfTotal = stats.passFail.length;
  const pfColor = pfPassed === pfTotal ? '#10b981' : '#ef4444';

  // Per-round table rows
  let roundTableRows = '';
  for (let r = 1; r <= numRounds; r++) {
    const qs = stats.perQuestion[`round_${r}`];
    if (!qs) continue;
    const resolveStep = timing.steps.find(s => s.step === 'dice-resolve-rpc' && s.detail.includes(`round=${r}`));
    roundTableRows += `<tr>
      <td>R${r}</td>
      <td>${qs.submitted}</td>
      <td>${qs.succeeded}</td>
      <td>${qs.failed}</td>
      <td>${qs.apiTimes.length > 0 ? fmtMs(qs.apiTimes.reduce((s, t) => s + t, 0) / qs.apiTimes.length) : '-'}</td>
      <td>${fmtMs(percentile(qs.apiTimes, 95))}</td>
      <td>${resolveStep ? fmtMs(resolveStep.durationMs) : '-'}</td>
      <td>${qs.realtimePropagation?.length > 0 ? fmtMs(percentile(qs.realtimePropagation, 50)) : '-'}</td>
    </tr>`;
  }

  // Edge case rows
  let edgeCaseRows = '';
  for (const ec of stats.edgeCases) {
    edgeCaseRows += `<tr class="${ec.pass ? '' : 'fail-row'}">
      <td>${ec.pass ? 'PASS' : 'FAIL'}</td>
      <td>${escapeHtml(ec.name)}</td>
      <td>${escapeHtml(ec.description)}</td>
      <td>${escapeHtml(ec.expected)}</td>
      <td>${escapeHtml(ec.actual)}</td>
    </tr>`;
  }

  // Data integrity rows
  let diRows = '';
  for (const di of stats.dataIntegrity) {
    diRows += `<tr class="${di.pass ? '' : 'fail-row'}">
      <td>${di.pass ? 'PASS' : 'FAIL'}</td>
      <td>${escapeHtml(di.check)}</td>
      <td>${escapeHtml(di.detail)}</td>
    </tr>`;
  }

  // Pass/fail rows
  let pfRows = '';
  for (const pf of stats.passFail) {
    pfRows += `<tr class="${pf.pass ? '' : 'fail-row'}">
      <td>${pf.pass ? 'PASS' : 'FAIL'}</td>
      <td>${escapeHtml(pf.criterion)}</td>
      <td>${escapeHtml(pf.threshold)}</td>
      <td>${escapeHtml(pf.actual)}</td>
    </tr>`;
  }

  // Error rows
  let errorRows = '';
  for (const e of stats.errors.slice(0, 50)) {
    errorRows += `<tr><td>${escapeHtml(e)}</td></tr>`;
  }

  const html = `<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8">
<title>Dice E2E Load Test Report</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #0f172a; color: #e2e8f0; font-family: 'Segoe UI', system-ui, sans-serif; padding: 24px; }
  h1 { text-align: center; margin-bottom: 8px; color: #f59e0b; }
  .subtitle { text-align: center; color: #94a3b8; margin-bottom: 24px; }
  .cards { display: flex; flex-wrap: wrap; gap: 16px; margin-bottom: 24px; justify-content: center; }
  .card { background: #1e293b; border-radius: 12px; padding: 16px 24px; min-width: 160px; text-align: center; }
  .card .value { font-size: 28px; font-weight: bold; }
  .card .label { color: #94a3b8; font-size: 13px; margin-top: 4px; }
  .tabs { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 16px; justify-content: center; }
  .tab-btn { background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 8px 16px; color: #e2e8f0; cursor: pointer; }
  .tab-btn.active { background: #f59e0b; color: #0f172a; border-color: #f59e0b; font-weight: bold; }
  .tab-content { display: none; }
  .tab-content.active { display: block; }
  .section { background: #1e293b; border-radius: 12px; padding: 20px; margin-bottom: 16px; overflow-x: auto; }
  .section h2 { color: #f59e0b; margin-bottom: 12px; font-size: 18px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { padding: 8px 12px; text-align: left; border-bottom: 1px solid #334155; }
  th { color: #f59e0b; font-weight: 600; }
  .fail-row { background: rgba(239, 68, 68, 0.15); }
  .pass { color: #10b981; font-weight: bold; }
  .fail { color: #ef4444; font-weight: bold; }
</style>
</head>
<body>
<h1>Dice E2E Load Test Report</h1>
<p class="subtitle">${startTimeStr} | Duration: ${testDuration}s | ${NUM_DICE_PLAYERS} players | ${numRounds} rounds</p>

<div class="cards">
  <div class="card"><div class="value">${stats.playersCreated}</div><div class="label">Players Joined</div></div>
  <div class="card"><div class="value">${stats.playersFailed}</div><div class="label">Join Failures</div></div>
  <div class="card"><div class="value">${apiP50} / ${apiP95}</div><div class="label">API p50 / p95</div></div>
  <div class="card"><div class="value">${rtP50} / ${rtP95}</div><div class="label">RT Lag p50 / p95</div></div>
  <div class="card"><div class="value" style="color:${pfColor}">${pfPassed}/${pfTotal}</div><div class="label">Pass/Fail</div></div>
</div>

<div class="tabs">
  <button class="tab-btn active" onclick="showTab('timeline')">Timeline</button>
  <button class="tab-btn" onclick="showTab('per-round')">Per-Round</button>
  <button class="tab-btn" onclick="showTab('api')">API Timing</button>
  <button class="tab-btn" onclick="showTab('edge-cases')">Edge Cases</button>
  <button class="tab-btn" onclick="showTab('data-integrity')">Data Integrity</button>
  <button class="tab-btn" onclick="showTab('pass-fail')">Pass/Fail</button>
  <button class="tab-btn" onclick="showTab('errors')">Errors (${stats.errors.length})</button>
</div>

<div id="tab-timeline" class="tab-content active">
  <div class="section">
    <h2>Phase Timeline</h2>
    ${timelineSvg}
  </div>
</div>

<div id="tab-per-round" class="tab-content">
  <div class="section">
    <h2>Per-Round Summary</h2>
    <table>
      <tr><th>Round</th><th>Bets</th><th>OK</th><th>Fail</th><th>API Avg</th><th>API p95</th><th>Resolve</th><th>RT p50</th></tr>
      ${roundTableRows}
    </table>
  </div>
</div>

<div id="tab-api" class="tab-content">
  <div class="section">
    <h2>API Latency (dice_place_bet) — p50 (blue) / p95 (red)</h2>
    ${qBarSvg}
  </div>
</div>

<div id="tab-edge-cases" class="tab-content">
  <div class="section">
    <h2>Edge Case Tests</h2>
    <table>
      <tr><th>Result</th><th>Name</th><th>Description</th><th>Expected</th><th>Actual</th></tr>
      ${edgeCaseRows}
    </table>
  </div>
</div>

<div id="tab-data-integrity" class="tab-content">
  <div class="section">
    <h2>Data Integrity</h2>
    <table>
      <tr><th>Result</th><th>Check</th><th>Detail</th></tr>
      ${diRows}
    </table>
  </div>
</div>

<div id="tab-pass-fail" class="tab-content">
  <div class="section">
    <h2>Pass/Fail Criteria</h2>
    <table>
      <tr><th>Result</th><th>Criterion</th><th>Threshold</th><th>Actual</th></tr>
      ${pfRows}
    </table>
  </div>
</div>

<div id="tab-errors" class="tab-content">
  <div class="section">
    <h2>Errors (${stats.errors.length})</h2>
    ${stats.errors.length > 0 ? `<table><tr><th>Error</th></tr>${errorRows}</table>` : '<p style="color:#94a3b8">No errors recorded.</p>'}
    ${stats.errors.length > 50 ? `<p style="color:#94a3b8;margin-top:8px">... and ${stats.errors.length - 50} more</p>` : ''}
  </div>
</div>

<script>
function showTab(id) {
  document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));
  document.getElementById('tab-' + id).classList.add('active');
  event.target.classList.add('active');
}
</script>
</body>
</html>`;

  const filename = `dice-report-${Date.now()}.html`;
  const filepath = join(E2E_DIR, filename);
  writeFileSync(filepath, html, 'utf-8');
  console.log(`\n  HTML report saved: ${filepath}`);
}
