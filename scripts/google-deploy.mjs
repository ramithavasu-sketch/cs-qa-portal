// One command to put the Google version live (or update it):   npm run google:deploy
//   1. builds the portal page + server into google/
//   2. creates the Apps Script project in your Google account (first time only)
//   3. uploads the code and publishes it as a web app — the link stays the same on every update
// Before the first run:  npm run google:login   (and turn on the Apps Script API — see README)
import { execSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const gdir = join(root, 'google');
const idFile = join(gdir, '.deployment-id');
const sh = (cmd, cwd = gdir) => execSync(cmd, { cwd, encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'] });
const say = (m) => console.log(`\n▶ ${m}`);
const fail = (m) => { console.error(`\n✖ ${m}\n`); process.exit(1); };

mkdirSync(gdir, { recursive: true });

say('Checking you are signed in to Google (clasp)…');
try {
  const who = sh('npx clasp show-authorized-user', root);
  if (/not logged in/i.test(who)) throw new Error(who);
  console.log('  ' + who.trim());
} catch { fail('You are not signed in yet. Run:  npm run google:login   then run  npm run google:deploy  again.'); }

if (!existsSync(join(gdir, '.clasp.json'))) {
  console.log(`
  This folder isn't linked to a CS QA Portal on Google yet, so this would create a NEW portal
  (a new link, with no data).

  Already deployed from another folder? Stop here (type n) and copy these two files from the old
  folder's "google" folder into this one's "google" folder:  .clasp.json  and  .deployment-id
  `);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ans = (await rl.question('  Create a new portal? (y/N) ')).trim().toLowerCase();
  rl.close();
  if (ans !== 'y' && ans !== 'yes') fail('Stopped. Nothing was changed.');
  say('Creating the Apps Script project “CS QA Portal” in your Google Drive (first time only)…');
  try { console.log(sh('npx clasp create-script --type standalone --title "CS QA Portal" --rootDir .')); }
  catch (e) {
    const msg = String(e.stderr || e.message);
    if (/Apps Script API/i.test(msg)) fail('Turn on the Apps Script API first: open https://script.google.com/home/usersettings , switch “Google Apps Script API” on, wait a minute, then run this again.');
    fail(msg);
  }
}

say('Building the portal…');
execSync('npx tsc -b && node scripts/build-google.mjs', { cwd: root, stdio: 'inherit' });

say('Uploading to Google…');
try { console.log(sh('npx clasp push -f')); }
catch (e) { fail(String(e.stderr || e.message)); }

say('Publishing the web app…');
let id = existsSync(idFile) ? readFileSync(idFile, 'utf8').trim() : '';
const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
try {
  const out = id ? sh(`npx clasp create-deployment -i ${id} -d "CS QA Portal ${stamp}"`) : sh(`npx clasp create-deployment -d "CS QA Portal ${stamp}"`);
  console.log(out.trim());
  if (!id) {
    id = (/AKfy[\w-]{20,}/.exec(out) || [])[0] || '';
    if (!id) fail('Deployed, but could not read the deployment id. Run  npx clasp list-deployments  in the google folder and put the AKfy… id into google/.deployment-id');
    writeFileSync(idFile, id + '\n');
  }
} catch (e) { fail(String(e.stderr || e.message)); }

const url = `https://script.google.com/macros/s/${id}/exec`;
console.log(`\n✔ The CS QA Portal is live.\n\n   Portal link:  ${url}\n`);
console.log('   First time: open the link yourself, click “Review permissions” and allow access.');
console.log('   You become the Super Admin automatically. Then add people under Users & Roles.\n');
