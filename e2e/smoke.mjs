// Clicks through the demo build as each role, collecting console errors and screenshots.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync } from 'node:fs';
const html = readFileSync(new URL('../dist-demo/index.html', import.meta.url));
const srv = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(html); }).listen(4173);
mkdirSync('e2e/shots', { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.PW_EXEC || undefined });
const errors = [];
async function session(email, pages, viewport = { width: 1400, height: 1000 }, tag = '') {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`[${email}] ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`[${email}] PAGEERROR ${e.message}`));
  await page.goto('http://localhost:4173/#/login');
  await page.fill('#login-email', email);
  await page.fill('#login-password', 'Demo@2026');
  await page.click('button[type=submit]');
  await page.waitForSelector('main h1', { timeout: 15000 });
  for (const [path, name] of pages) {
    await page.goto('http://localhost:4173/#' + path);
    await page.waitForTimeout(900);
    const h1 = await page.locator('main h1').first().textContent().catch(() => '(none)');
    console.log(`${email.split('@')[0]} ${path} -> ${h1}`);
    await page.screenshot({ path: `e2e/shots/${email.split('.')[0]}${tag}-${name}.png`, fullPage: true });
  }
  await ctx.close();
}
await session('ava.thompson@demo.csqa.test', [['/', 'dash'], ['/evaluations', 'evals'], ['/appeals', 'appeals'], ['/reports', 'reports'], ['/parameters', 'params'], ['/admin/users', 'forbidden'], ['/downloads','downloads'], ['/notifications','notifs']]);
await session('daniel.brooks@demo.csqa.test', [['/', 'dash'], ['/appeals', 'appeals']]);
await session('maya.raman@demo.csqa.test', [['/', 'dash'], ['/appeals', 'appeals'], ['/admin/users', 'users'], ['/admin/teams', 'teams'], ['/admin/scoring', 'scoring'], ['/admin/periods', 'periods'], ['/admin/import', 'import'], ['/admin/audit', 'audit']]);
await session('ava.thompson@demo.csqa.test', [['/', 'dash']], { width: 390, height: 844 }, '-mobile');
console.log('ERRORS', errors.length); errors.slice(0, 20).forEach((e) => console.log(e));
await browser.close(); srv.close();
