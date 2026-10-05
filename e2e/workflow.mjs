// End-to-end appeal workflow through the UI: CAM submits -> Lead forwards -> QA approves -> score recalculated.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
const html = readFileSync(new URL('../dist-demo/index.html', import.meta.url));
const srv = createServer((q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end(html); }).listen(4174);
const browser = await chromium.launch({ executablePath: process.env.PW_EXEC });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
const page = await ctx.newPage();
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
const B = 'http://localhost:4174/#';
const login = async (email) => {
  await page.goto(B + '/login'); await page.evaluate(() => sessionStorage.clear()); await page.reload(); await page.waitForSelector('#login-email');
  await page.fill('#login-email', email); await page.fill('#login-password', 'Demo@2026'); await page.click('button[type=submit]');
  await page.waitForSelector('main h1');
};
const assert = (c, m) => { if (!c) { console.log('FAIL', m); process.exitCode = 1; } else console.log('ok ', m); };

let camEmail, lead;
for (const [c, l] of [['sofia.alvarez', 'kavya.menon'], ['zara.hussain', 'omar.haddad'], ['priya.natarajan', 'omar.haddad'], ['lena.fischer', 'daniel.brooks'], ['noah.bennett', 'omar.haddad']]) {
  await login(`${c}@demo.csqa.test`);
  await page.goto(B + '/evaluations'); await page.waitForTimeout(600);
  await page.selectOption('#ev-only', 'deducted'); await page.waitForTimeout(300);
  const n = await page.locator('main tbody tr a:has-text("Details")').count();
  if (n) { camEmail = c; lead = l; await page.locator('main tbody tr a:has-text("Details")').first().click(); break; }
}
assert(!!camEmail, 'found a CAM task with deductions: ' + camEmail);
await page.waitForSelector('text=Scores by parameter');
const before = (await page.locator('tr:has-text("Task score") td').nth(2).textContent()).trim();
await page.click('button:has-text("Raise Appeal")');
const box = page.locator('[role=dialog] input[type=checkbox]').first();
// choose first parameter that is deducted: find label containing a score like 0/
const labels = page.locator('[role=dialog] label:has(input[type=checkbox])');
const cnt = await labels.count(); let chosen = null;
for (let i = 0; i < cnt; i++) { const t = await labels.nth(i).textContent(); const m = /(\d+)\/(\d+)\s*$/.exec(t.trim()); if (m && Number(m[1]) < Number(m[2])) { await labels.nth(i).locator('input').check(); chosen = t; break; } }
if (!chosen) { await box.check(); chosen = await labels.first().textContent(); }
assert(!!chosen, 'selected deducted parameter ' + chosen);
await page.fill('#ap-reason', 'The task notes show this step was completed on time; please see the attached screenshot.');
await page.click('[role=dialog] button:has-text("Submit to Team Lead")');
await page.waitForSelector('text=Appeal APL-');
const ref = (await page.locator('main h1').textContent()).replace('Appeal ', '');
assert(await page.locator('text=Pending Lead Review').first().isVisible(), `appeal ${ref} pending lead review`);
const appealUrl = page.url();

// another CAM cannot open it
await login('ava.thompson@demo.csqa.test');
await page.goto(appealUrl); await page.waitForTimeout(500);
assert(await page.locator('text=Appeal not available').isVisible(), 'other CAM cannot open the appeal');
// wrong lead cannot review
await login(lead === 'daniel.brooks' ? 'kavya.menon@demo.csqa.test' : 'daniel.brooks@demo.csqa.test');
await page.goto(appealUrl); await page.waitForTimeout(500);
assert(await page.locator('text=Appeal not available').isVisible(), 'other team lead cannot open the appeal');
// QA cannot decide yet
await login('maya.raman@demo.csqa.test');
await page.goto(appealUrl); await page.waitForTimeout(500);
assert(!(await page.locator('text=Record final decision').isVisible()), 'QA has no decision form before lead review');

await login(`${lead}@demo.csqa.test`);
await page.goto(appealUrl); await page.waitForSelector('text=Your review');
await page.fill('#lead-comment', 'Verified the task notes, the step was done.');
await page.fill('#lead-note', 'Internal: fine.');
await page.click('button:has-text("Forward to QA")');
await page.waitForSelector('text=Pending QA Review');
assert(true, 'lead forwarded');

await login('maya.raman@demo.csqa.test');
await page.goto(appealUrl); await page.waitForSelector('text=Record final decision');
await page.locator('input[type=radio][id$="-approved"]').first().check();
const rev = page.locator('input[id^="rev-"]').first();
const max = await rev.getAttribute('max'); await rev.fill(max);
await page.fill('#qa-res', 'Approved — evidence confirms the step was completed.');
await page.click('button:has-text("Record final decision")');
await page.waitForSelector('text=Decision: Approved');
assert(true, 'QA approved');
await page.click('a:has-text("Open evaluation")');
await page.waitForSelector('text=Score change history');
const after = (await page.locator('tr:has-text("Task score") td').nth(2).textContent()).trim();
assert(before !== after, `score recalculated ${before} -> ${after}`);

await login(`${camEmail}@demo.csqa.test`);
await page.goto(appealUrl); await page.waitForTimeout(500);
assert(!(await page.locator('text=Internal: fine.').isVisible()), 'CAM does not see internal note');
assert(await page.locator('text=Approved — evidence confirms').first().isVisible(), 'CAM sees QA resolution');
await page.screenshot({ path: 'e2e/shots/cam-appeal-decided.png', fullPage: true });
console.log('page errors', errs);
await browser.close(); srv.close();
