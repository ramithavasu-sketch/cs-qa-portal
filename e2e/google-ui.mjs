// Google version in a real browser: google/index.html is served with a stand-in for google.script.run
// that forwards to google/Code.js running in the simulated Apps Script runtime (gas-sim.mjs).
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { createGas } from './gas-sim.mjs';

const LIVE = '/home/claude/research/live.csv';
if (!existsSync(LIVE)) { console.log('skipped: real sheet exports are not available here'); process.exit(0); }
// Real sheet IDs come from the environment (they are not kept in the public source).
const LIVE_ID = process.env.VITE_LIVE_SHEET_ID ?? 'live-sheet-id', LIVE_GID = process.env.VITE_LIVE_SHEET_GID ?? '0', ARCHIVE_ID = process.env.VITE_ARCHIVE_SHEET_ID ?? 'archive-sheet-id';
const OWNER = 'qa.owner@example.com';
const gas = createGas({ owner: OWNER, sheets: { [LIVE_ID]: [{ gid: Number(LIVE_GID), title: 'Form Responses 1', csv: LIVE }] } });

const SHIM = `<script>
(function(){
  function mk(ok, fail){ return new Proxy({}, { get: function(_, k){
    if (k === 'withSuccessHandler') return function(fn){ return mk(fn, fail); };
    if (k === 'withFailureHandler') return function(fn){ return mk(ok, fn); };
    return function(payload){
      fetch('/api/' + k, { method: 'POST', body: payload, headers: { 'x-as': sessionStorage.getItem('as') || '' } })
        .then(function(r){ return r.text().then(function(t){ if (r.ok) { ok && ok(t); } else { fail && fail(new Error(t)); } }); });
    };
  }}); }
  window.google = { script: { run: mk(null, null), url: { getLocation: function(cb){ var p = {}; new URLSearchParams(location.search).forEach(function(v,k){ p[k]=v; }); setTimeout(function(){ cb({ parameter: p, hash: '' }); }, 0); } } } };
})();
</script>`;
const page0 = readFileSync(new URL('../google/index.html', import.meta.url), 'utf8');
const html = page0.replace('<head>', '<head>' + SHIM);
const srv = createServer((q, r) => {
  if (q.method === 'POST' && q.url === '/api/api') {
    let body = ''; q.on('data', (c) => (body += c)); q.on('end', () => {
      try { gas.as(String(q.headers['x-as'] || OWNER)); const out = gas.rawApi(body); r.writeHead(200, { 'content-type': 'text/plain' }); r.end(out); }
      catch (e) { r.writeHead(500); r.end(e instanceof Error ? e.message : String(e)); }
    });
    return;
  }
  r.writeHead(200, { 'content-type': 'text/html' }); r.end(html);
}).listen(4181);

let fails = 0;
const ok = (c, m) => { if (c) console.log('ok  ', m); else { fails++; console.log('FAIL', m); } };
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const ctx = await b.newContext({ viewport: { width: 1400, height: 1000 } });
const p = await ctx.newPage();
const errs = []; p.on('pageerror', (e) => errs.push(e.message));
const B = 'http://localhost:4181/';
const as = async (email, path = '') => { await p.goto(B + path); await p.evaluate((e) => sessionStorage.setItem('as', e), email); await p.goto(B + path); };
const body = () => p.textContent('body');

await as(OWNER);
await p.waitForSelector('text=QA administration', { timeout: 30000 });
ok(true, 'owner opens the portal and is signed in by Google (no sign-in form)');
ok((await body()).includes('Signed in with Google'), 'sidebar shows the Google account instead of Sign out');
await p.click('text=Data Import'); await p.waitForSelector('text=Google Sheets (direct connection)');
ok((await body()).includes('Bring over your local review setup'), 'setup-file card is shown before the first sync');
let t = Date.now();
await p.click('button:has-text("Sync live sheet now")');
await p.waitForSelector('text=Google Sheets synced', { timeout: 120000 });
ok((await p.locator('ul.rounded li').first().textContent()).includes('11594 new'), `live sheet synced from the page (${Date.now() - t} ms)`);
await p.click('text=Dashboard'); await p.waitForTimeout(2500);
ok(/Tasks Audited/i.test(await body()), 'QA dashboard shows real data');
await p.click('text=Reporting & Settings'); await p.waitForSelector('text=Automatic jobs');
await p.click('button:has-text("Turn on")'); await p.waitForSelector('text=every 30 min');
ok(gas.triggers.length === 1, 'automatic jobs turned on from the page');
await p.click('text=Users & Roles'); await p.waitForSelector('text=Everyone signs in with their company Google account');
ok(await p.locator('button:has-text("Set password")').count() === 0, 'no passwords in the Google version');
ok(await p.locator('text=Google sign-in').count() > 0 && await p.locator('button:has-text("Send invite")').count() > 0, 'users show Google sign-in and a Send invite button');

// a CAM and a Lead (Lead gets a test email)
gas.as(OWNER);
const emps = gas.call('getEmployees'), teams = gas.call('getTeams');
const team = teams.find((tm) => emps.filter((e) => e.team_id === tm.id && e.role === 'user').length >= 2);
gas.call('upsertEmployee', { ...emps.find((e) => e.id === team.lead_id), email: 'test.lead@example.com' });
const cam = emps.find((e) => e.team_id === team.id && e.role === 'user' && e.status === 'active');

await as(cam.email);
await p.waitForSelector('text=Dashboard', { timeout: 30000 }); await p.waitForTimeout(2000);
ok(await p.locator('text=QA administration').count() === 0, 'CAM sees no admin menu');
ok((await body()).includes(cam.full_name), 'CAM dashboard is theirs');
await p.goto(B + '#/admin/users'); await p.waitForTimeout(800);
ok((await body()).includes('You don’t have access to this page'), 'CAM cannot open Users & Roles');

await as('test.lead@example.com');
await p.waitForSelector('text=Dashboard', { timeout: 30000 }); await p.waitForTimeout(2000);
ok(await p.locator('text=QA administration').count() === 0 && /Team/i.test(await body()), 'Lead gets the team dashboard');

await as('new.person@example.com');
await p.waitForSelector('text=You don’t have access yet', { timeout: 30000 });
ok((await body()).includes('new.person@example.com'), 'someone not added sees a clear no-access page with their email');

await as(OWNER, '?p=/appeals');
await p.waitForSelector('h1:has-text("QA Appeal Review Queue")', { timeout: 30000 });
ok(true, 'email links (…/exec?p=/appeals) open the right page');
ok(errs.length === 0, 'no page errors ' + errs.slice(0, 3).join(' | '));
await p.screenshot({ path: '/tmp/claude-0/google-appeals.png' });
await b.close(); srv.close();
console.log(fails ? `${fails} FAILED` : 'all passed');
process.exitCode = fails ? 1 : 0;
