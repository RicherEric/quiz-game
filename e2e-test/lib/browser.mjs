/**
 * HTTP server + browser launch/close for monitoring.
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { SITE_URL, ADMIN_USERNAME, ADMIN_PASSWORD, E2E_DIR } from './config.mjs';
import { sleep } from './helpers.mjs';

let httpServer = null;
let serverPort = 0;
let userBrowser = null;
let adminBrowser = null;
let _adminPage = null;
let _userPage = null;

export function getAdminPage() { return _adminPage; }
export function getUserPage() { return _userPage; }

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

  // ── User browser: mobile viewport, stays open throughout ──
  userBrowser = await chromium.launch({ headless: false });
  const userCtx = await userBrowser.newContext({
    viewport: { width: 390, height: 844 },
  });
  _userPage = await userCtx.newPage();
  await _userPage.goto(`${baseUrl}/index.html?token=${qrToken}`);
  await _userPage.fill('#p-name', 'test_viewer');
  await _userPage.click('button[onclick="join()"]');
  await _userPage.waitForSelector('#waiting-ui:not(.hidden)', { timeout: 10000 });
  console.log('  User browser opened (test_viewer joined)');

  // ── Admin browser: desktop viewport, real-time monitoring ──
  adminBrowser = await chromium.launch({ headless: false });
  const adminCtx = await adminBrowser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  _adminPage = await adminCtx.newPage();
  await _adminPage.goto(`${baseUrl}/admin.html`);
  await _adminPage.fill('#login-username', ADMIN_USERNAME);
  await _adminPage.fill('#login-password', ADMIN_PASSWORD);
  await _adminPage.click('button[onclick="doLogin()"]');
  await _adminPage.waitForSelector('#admin-panel:not(.hidden)', { timeout: 10000 });
  console.log('  Admin browser opened (logged in)');
}

export async function closeBrowsers() {
  if (userBrowser) { try { await userBrowser.close(); } catch {} }
  if (adminBrowser) { try { await adminBrowser.close(); } catch {} }
  if (httpServer) { httpServer.close(); }
}
