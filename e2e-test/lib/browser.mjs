/**
 * HTTP server + browser launch/close for monitoring.
 * Both admin and test_viewer browsers are launched automatically.
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { SITE_URL, E2E_DIR } from './config.mjs';

let httpServer = null;
let serverPort = 0;
let adminBrowser = null;
let _adminPage = null;
let userBrowser = null;
let _userPage = null;
let diceUserBrowser = null;
let diceAdminBrowser = null;
let _diceAdminPage = null;
let _diceUserPage = null;

export function getAdminPage() { return _adminPage; }
export function getUserPage() { return _userPage; }
export function getDiceAdminPage() { return _diceAdminPage; }
export function getDiceUserPage() { return _diceUserPage; }

export function startHttpServer() {
  return new Promise((resolve) => {
    const projectRoot = join(E2E_DIR, '..');
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

export async function launchBrowsers(qrToken) {
  let baseUrl;
  if (SITE_URL) {
    baseUrl = SITE_URL;
    console.log(`  Using remote site: ${baseUrl}`);
  } else {
    const port = await startHttpServer();
    baseUrl = `http://localhost:${port}`;
  }

  // ── Admin browser: desktop viewport, login via admin-home then navigate ──
  adminBrowser = await chromium.launch({ headless: false });
  const adminCtx = await adminBrowser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  _adminPage = await adminCtx.newPage();
  await _adminPage.goto(`${baseUrl}/admin-home.html`);
  const { ADMIN_USERNAME, ADMIN_PASSWORD } = await import('./config.mjs');
  await _adminPage.fill('#login-username', ADMIN_USERNAME);
  await _adminPage.fill('#login-password', ADMIN_PASSWORD);
  await _adminPage.click('button[onclick="doLogin()"]');
  await _adminPage.waitForSelector('#home-panel:not(.hidden)', { timeout: 10000 });
  await _adminPage.goto(`${baseUrl}/admin.html`);
  await _adminPage.waitForSelector('#admin-panel:not(.hidden)', { timeout: 10000 });
  // Auto-accept all confirm/alert dialogs so manual clicks work in Playwright
  _adminPage.on('dialog', dialog => dialog.accept());
  console.log('  Admin browser opened (logged in)');

  // ── User browser: mobile viewport, stays open throughout ──
  userBrowser = await chromium.launch({ headless: false });
  const userCtx = await userBrowser.newContext({
    viewport: { width: 390, height: 844 },
  });
  _userPage = await userCtx.newPage();
  // Auto-accept alerts so they don't block Playwright (e.g. join errors)
  let lastDialog = '';
  _userPage.on('dialog', dialog => {
    lastDialog = dialog.message();
    console.log(`  [user-page dialog] ${lastDialog}`);
    dialog.accept();
  });
  await _userPage.goto(`${baseUrl}/index.html?token=${qrToken}`);
  // Wait for login UI to be ready
  await _userPage.waitForSelector('#login-ui:not(.hidden)', { timeout: 10000 });
  await _userPage.fill('#p-name', 'test_viewer');
  await _userPage.click('button[onclick="join()"]');
  // Retry join if it fails (e.g. transient network error or stale duplicate)
  try {
    await _userPage.waitForSelector('#waiting-ui:not(.hidden)', { timeout: 10000 });
  } catch (_e) {
    console.log(`  User join failed (dialog: "${lastDialog}"), retrying...`);
    // Clear sessionStorage and retry
    await _userPage.evaluate(() => sessionStorage.clear());
    await _userPage.goto(`${baseUrl}/index.html?token=${qrToken}`);
    await _userPage.waitForSelector('#login-ui:not(.hidden)', { timeout: 10000 });
    await _userPage.fill('#p-name', 'test_viewer');
    await _userPage.click('button[onclick="join()"]');
    await _userPage.waitForSelector('#waiting-ui:not(.hidden)', { timeout: 15000 });
  }
  console.log('  User browser opened (test_viewer joined)');
}

export async function launchDiceBrowsers(qrToken) {
  let baseUrl;
  if (SITE_URL) {
    baseUrl = SITE_URL;
    console.log(`  Using remote site: ${baseUrl}`);
  } else {
    if (!httpServer) {
      const port = await startHttpServer();
      baseUrl = `http://localhost:${port}`;
    } else {
      baseUrl = `http://localhost:${serverPort}`;
    }
  }

  // ── User browser: mobile viewport, dice player page ──
  diceUserBrowser = await chromium.launch({ headless: false });
  const userCtx = await diceUserBrowser.newContext({
    viewport: { width: 390, height: 844 },
  });
  _diceUserPage = await userCtx.newPage();
  await _diceUserPage.goto(`${baseUrl}/dice.html?token=${qrToken}`);
  await _diceUserPage.fill('#p-name', 'test_viewer');
  await _diceUserPage.click('button[onclick="join()"]');
  await _diceUserPage.waitForSelector('#waiting-ui:not(.hidden)', { timeout: 10000 });
  console.log('  Dice user browser opened (test_viewer joined)');

  // ── Admin browser: desktop viewport, login via admin-home then navigate ──
  diceAdminBrowser = await chromium.launch({ headless: false });
  const adminCtx = await diceAdminBrowser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  _diceAdminPage = await adminCtx.newPage();
  await _diceAdminPage.goto(`${baseUrl}/admin-home.html`);
  const { ADMIN_USERNAME, ADMIN_PASSWORD } = await import('./config.mjs');
  await _diceAdminPage.fill('#login-username', ADMIN_USERNAME);
  await _diceAdminPage.fill('#login-password', ADMIN_PASSWORD);
  await _diceAdminPage.click('button[onclick="doLogin()"]');
  await _diceAdminPage.waitForSelector('#home-panel:not(.hidden)', { timeout: 10000 });
  // Navigate to dice-admin
  await _diceAdminPage.goto(`${baseUrl}/dice-admin.html`);
  await _diceAdminPage.waitForSelector('#tab-control', { timeout: 10000 });
  console.log('  Dice admin browser opened (logged in)');
}

export async function closeBrowsers() {
  if (adminBrowser) { try { await adminBrowser.close(); } catch {} }
  if (userBrowser) { try { await userBrowser.close(); } catch {} }
  if (diceUserBrowser) { try { await diceUserBrowser.close(); } catch {} }
  if (diceAdminBrowser) { try { await diceAdminBrowser.close(); } catch {} }
  if (httpServer) { httpServer.close(); }
}
