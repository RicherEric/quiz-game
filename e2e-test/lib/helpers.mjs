/**
 * Utility functions: sleep, retry, percentile, formatting, etc.
 */

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const randomInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
export const randomSleep = (min, max) => sleep(randomInt(min, max));
export const now = () => performance.now();

/**
 * Retry wrapper for Supabase RPC/query calls.
 * Retries on 502/503/504 errors (Cloudflare gateway errors) with exponential backoff.
 */
export async function withRetry(fn, { maxRetries = 3, baseDelayMs = 1000, label = '' } = {}) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const result = await fn();
    const errMsg = result.error?.message || '';
    const is5xx = /50[234]|bad gateway|service unavailable|gateway timeout/i.test(errMsg);
    if (!result.error || !is5xx || attempt === maxRetries) return result;
    const delay = baseDelayMs * Math.pow(2, attempt) + randomInt(0, 500);
    if (label) console.log(`  RETRY [${label}] attempt ${attempt + 1}/${maxRetries} after ${delay}ms`);
    await sleep(delay);
  }
}

export function weightedChoice() {
  const weights = [0.35, 0.30, 0.20, 0.15];
  const r = Math.random();
  let cum = 0;
  for (let i = 0; i < weights.length; i++) {
    cum += weights[i];
    if (r < cum) return i + 1;
  }
  return 4;
}

export function padNum(n, len = 3) {
  return String(n).padStart(len, '0');
}

export function percentile(arr, p) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

export function fmtMs(ms) {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  return `${ms.toFixed(0)}ms`;
}

export function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function stdDev(arr) {
  if (arr.length < 2) return 0;
  const mean = arr.reduce((s, v) => s + v, 0) / arr.length;
  const variance = arr.reduce((s, v) => s + (v - mean) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(variance);
}

export function throughput(count, durationMs) {
  if (durationMs <= 0) return 0;
  return count / (durationMs / 1000);
}

export async function staggeredAll(tasks, batchSize = 10, delayMs = 50) {
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
