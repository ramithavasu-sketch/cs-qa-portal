import { useEffect, useRef, useState } from 'react';
import { RefreshCw, Link2 } from 'lucide-react';
import { useApp, useAsync, useRef_ } from '../app/context';
import { repo, isDemo, isLocal, isGoogle } from '../data';
import { callServer } from '../data/googleRepo';
import { Button, Card, ErrorBox, Field, Pill, Table, td, th, inputCls, useToast } from './ui';
import { GOOGLE_CLIENT_ID, hasGoogleToken, syncSources, type SourceResult } from '../lib/googleSheets';
import { fmtDateTime } from '../lib/metrics';
import type { DataSource } from '../../supabase/functions/_shared/rubric';

const LAST_KEY = 'csqa-last-sheet-sync';
const AUTO_KEY = 'csqa-auto-sheet-sync';
const readLast = (): Record<string, { at: string; text: string }> => { try { return JSON.parse(localStorage.getItem(LAST_KEY) ?? '{}'); } catch { return {}; } };

/** Runs a Google Sheets sync with whatever the current backend supports. */
export function useSheetSync() {
  const { reloadRef, bump } = useApp();
  const ref = useRef_();
  const [running, setRunning] = useState<string | null>(null);
  const run = async (scope: 'live' | 'all', interactive: boolean): Promise<{ label: string; text: string; error?: string }[]> => {
    const sources = ref.settings.data_sources.sources.filter((s) => s.enabled && (scope === 'all' || s.kind === 'live'));
    setRunning(scope);
    try {
      let rows: { label: string; text: string; error?: string }[];
      if (isGoogle) {
        // one sheet per request, so each stays inside Google's 6-minute limit
        rows = [];
        for (const src of sources) {
          const step = `(${rows.length + 1} of ${sources.length})`;
          const t0 = Date.now();
          setRunning(`Starting ${src.label}… ${step}`);
          // show what Google is doing while we wait (the first sync of a big sheet can take a few minutes)
          const poll = setInterval(async () => {
            try {
              const pr = await callServer<{ at: string; msg: string } | null>('syncProgress', []);
              const secs = Math.round((Date.now() - t0) / 1000);
              if (pr && Date.parse(pr.at) >= t0 - 5000) setRunning(`${pr.msg} ${step} · ${secs} s`);
              else setRunning(`Waiting for Google… ${step} · ${secs} s`);
            } catch { /* keep waiting */ }
          }, 4000);
          try {
            const [r] = await repo.syncGoogleSheet([src.id]).finally(() => clearInterval(poll));
            rows.push({ label: src.label, error: r?.error, text: !r ? 'Not synced' : r.error ? r.error : `${r.inserted ?? 0} new · ${r.duplicates ?? 0} already loaded · ${r.rejected ?? 0} rejected` });
          } catch (e) { rows.push({ label: src.label, error: String((e as Error).message), text: String((e as Error).message) }); }
        }
      } else if (repo.mode === 'supabase') {
        const res = await repo.syncGoogleSheet(scope);
        rows = res.map((r) => ({ label: sources.find((s) => s.id === r.source)?.label ?? r.source, error: r.error,
          text: r.error ? r.error : `${r.inserted ?? 0} new · ${r.duplicates ?? 0} already loaded · ${r.rejected ?? 0} rejected` }));
      } else if (isLocal) {
        const res: SourceResult[] = await syncSources(sources, ref.taskTypes, ref.parameters,
          (rowsToImport, label) => repo.importEvaluations(rowsToImport, { source: 'google_sheets', file_name: label, publish_new_periods: true }),
          { interactive, onStep: (m) => setRunning(m) });
        rows = res.map((r) => ({ label: r.source.label, error: r.error,
          text: r.error ? r.error : `${r.inserted ?? 0} new · ${r.alreadyPresent ?? 0} already loaded · ${(r.rejected ?? 0) + (r.rejectedByMapper ?? 0)} rejected · ${r.duplicatesInSheet ?? 0} duplicate rows in the sheet` }));
      } else throw new Error('The demo uses fictional data only, so it cannot read your Google Sheets.');
      const last = readLast();
      for (const r of rows) last[r.label] = { at: new Date().toISOString(), text: r.text };
      try { localStorage.setItem(LAST_KEY, JSON.stringify(last)); } catch { /* ignore */ }
      await reloadRef(); bump();
      return rows;
    } finally { setRunning(null); }
  };
  return { run, running };
}

/** While the portal is open in local review mode, re-reads the live sheet every N minutes. */
export function AutoSheetSync() {
  const ref = useRef_();
  const { run } = useSheetSync();
  const busy = useRef(false);
  useEffect(() => {
    if (!isLocal) return;
    const every = Math.max(5, ref.settings.data_sources.auto_sync_minutes || 30) * 60_000;
    const t = setInterval(async () => {
      let on = false; try { on = localStorage.getItem(AUTO_KEY) === 'on'; } catch { /* ignore */ }
      if (!on || busy.current || !hasGoogleToken()) return;
      busy.current = true;
      try { await run('live', false); } catch { /* shown next time the user opens Data Import */ } finally { busy.current = false; }
    }, every);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref.settings.data_sources.auto_sync_minutes]);
  return null;
}

export function SheetSourcesCard() {
  const ref = useRef_();
  const { reloadRef } = useApp();
  const toast = useToast();
  const { run, running } = useSheetSync();
  const [err, setErr] = useState<unknown>(null);
  const [results, setResults] = useState<{ label: string; text: string; error?: string }[] | null>(null);
  const [auto, setAuto] = useState(() => { try { return localStorage.getItem(AUTO_KEY) === 'on'; } catch { return false; } });
  const [adding, setAdding] = useState(false);
  const [newUrl, setNewUrl] = useState(''); const [newTab, setNewTab] = useState(''); const [newKind, setNewKind] = useState<'live' | 'archive'>('archive');
  const sources = ref.settings.data_sources.sources;
  const last = readLast();
  const canConnect = repo.mode === 'supabase' || isGoogle || (isLocal && !!GOOGLE_CLIENT_ID);
  // Supabase: audits usually arrive from the Apps Script in the sheet (sheet push); show when that last happened.
  const batches = useAsync(() => (repo.mode === 'supabase' ? repo.listImportBatches() : Promise.resolve([])), []);
  const lastPush = (batches.data ?? []).find((b) => b.source === 'google_sheets');

  const go = async (scope: 'live' | 'all') => {
    setErr(null); setResults(null);
    try {
      const r = await run(scope, true);
      if (repo.mode === 'supabase' && r.length === 0) throw new Error('Nothing was synced.');
      setResults(r);
      toast(r.some((x) => x.error) ? 'Sync finished with problems — see below.' : 'Google Sheets synced.', r.some((x) => x.error) ? 'bad' : 'good');
    } catch (x) {
      const msg = x instanceof Error ? x.message : String(x);
      setErr(repo.mode === 'supabase' && /not configured/i.test(msg)
        ? new Error('This portal receives audits from the script inside your Google Sheet, not from this button. To sync now: open the sheet → Extensions → Apps Script → choose pushToPortal → Run. (This button only works if a Google service account is set up.)')
        : x);
    }
  };
  const save = async (next: DataSource[]) => { await repo.updateSetting('data_sources', { ...ref.settings.data_sources, sources: next }); await reloadRef(); };

  return (
    <Card title="Google Sheets (direct connection)" subtitle="The portal reads the audit sheets straight from Google. Audits that are already loaded are skipped, so syncing again is always safe."
      actions={<>
        <Button loading={!!running} disabled={!canConnect || !!running} onClick={() => go('live')}><RefreshCw className="h-4 w-4" />Sync live sheet now</Button>
        <Button variant="secondary" disabled={!canConnect || !!running} onClick={() => go('all')}>Sync live + archives</Button>
      </>}>
      <div className="flex flex-col gap-3 text-[13px]">
        {isDemo && <p className="rounded bg-warn-soft px-3 py-2 text-warn">The demo only has fictional data, so it can’t connect to your sheets.</p>}
        {isLocal && !GOOGLE_CLIENT_ID && (
          <div className="rounded border border-warn/40 bg-warn-soft px-3 py-2 text-warn">
            <strong>One-time setup needed:</strong> add a Google OAuth Client ID to your <code className="font-mono">.env</code> file as <code className="font-mono">VITE_GOOGLE_CLIENT_ID=…</code> and restart with <code className="font-mono">npm run local</code>. Steps are in the README (“Connect Google Sheets directly”). Until then, use the CSV upload below.
          </div>
        )}
        {isLocal && GOOGLE_CLIENT_ID && <p className="text-muted">Uses your own Google account (read-only). Google asks you to sign in the first time in each session.</p>}
        {repo.mode === 'supabase' && (
          <div className="rounded border border-info/40 bg-info-soft/50 px-3 py-2 text-[13px]">
            <strong>How audits arrive:</strong> the script in your Google Sheet sends new audits every 30 minutes (see the README, “sync without a service account”).
            To sync immediately, open the sheet → <em>Extensions → Apps Script</em> → run <code className="font-mono">pushToPortal</code>.
            <div className="mt-1 text-muted">Last received from the sheet: {lastPush ? <strong className="text-ink">{fmtDateTime(lastPush.created_at)}</strong> : 'not yet'}{lastPush ? ` · ${lastPush.inserted} new, ${lastPush.duplicates} already loaded, ${lastPush.rejected} rejected` : ''}</div>
          </div>
        )}
        {isGoogle && <p className="text-muted">Google reads the sheets as the portal owner, so every sheet must be shared with that account (Viewer is enough). The first sync of the live sheet can take a few minutes — progress shows below while it runs. New live weeks arrive as <strong>drafts</strong> — publish them on Reporting &amp; Settings. Archives are published at once. Turn on <em>Automatic jobs</em> there to re-sync the live sheet every 30 minutes.</p>}
        {running && running.length > 6 && <p className="text-info">{running}</p>}
        <Table>
          <thead><tr><th className={th}>Sheet / tab</th><th className={th}>Type</th><th className={th}>Last sync (this browser)</th><th className={th}>Use</th></tr></thead>
          <tbody>{sources.map((src) => (
            <tr key={src.id}>
              <td className={td}><a className="text-brand hover:underline" target="_blank" rel="noreferrer noopener" href={`https://docs.google.com/spreadsheets/d/${src.sheet_id}/edit${src.gid ? `#gid=${src.gid}` : ''}`}>{src.label}</a>
                <div className="text-[12px] text-muted">{src.gid ? `tab gid ${src.gid}` : `tab “${src.tab}”`}</div></td>
              <td className={td}>{src.kind === 'live' ? <Pill tone="brand">Live</Pill> : <Pill>Archive</Pill>}</td>
              <td className={td + ' text-[12.5px]'}>{last[src.label] ? <>{fmtDateTime(last[src.label].at)}<div className="text-muted">{last[src.label].text}</div></> : <span className="text-faint">Not yet</span>}</td>
              <td className={td}><input aria-label={`Use ${src.label}`} type="checkbox" checked={src.enabled} onChange={(e) => save(sources.map((x) => (x.id === src.id ? { ...x, enabled: e.target.checked } : x)))} /></td>
            </tr>
          ))}</tbody>
        </Table>
        {isLocal && <label htmlFor="auto-sync" className="flex items-center gap-2"><input id="auto-sync" type="checkbox" checked={auto} onChange={(e) => { setAuto(e.target.checked); try { localStorage.setItem(AUTO_KEY, e.target.checked ? 'on' : 'off'); } catch { /* ignore */ } }} />
          Re-sync the live sheet every {ref.settings.data_sources.auto_sync_minutes} minutes while the portal is open (after you’ve connected once)</label>}
        {results && <ul className="flex flex-col gap-1 rounded bg-sunken p-3">{results.map((r) => <li key={r.label} className={r.error ? 'text-bad' : ''}><strong>{r.label}:</strong> {r.text}</li>)}</ul>}
        <ErrorBox error={err} />
        {!adding ? <div><Button size="sm" variant="ghost" onClick={() => setAdding(true)}><Link2 className="h-4 w-4" />Add another sheet or tab</Button></div> : (
          <div className="grid gap-2 rounded border border-line p-3 sm:grid-cols-[2fr_1fr_1fr_auto] sm:items-end">
            <Field label="Google Sheet link" htmlFor="ns-url"><input id="ns-url" className={inputCls} value={newUrl} onChange={(e) => setNewUrl(e.target.value)} placeholder="https://docs.google.com/spreadsheets/d/…/edit#gid=…" /></Field>
            <Field label="Tab name (if no gid in link)" htmlFor="ns-tab"><input id="ns-tab" className={inputCls} value={newTab} onChange={(e) => setNewTab(e.target.value)} /></Field>
            <Field label="Type" htmlFor="ns-kind"><select id="ns-kind" className={inputCls} value={newKind} onChange={(e) => setNewKind(e.target.value as 'live' | 'archive')}><option value="archive">Archive (import once)</option><option value="live">Live (sync every time)</option></select></Field>
            <Button onClick={async () => {
              const id = /\/d\/([a-zA-Z0-9-_]+)/.exec(newUrl)?.[1]; const gid = /[#&?]gid=(\d+)/.exec(newUrl)?.[1];
              if (!id) return setErr(new Error('Paste the full Google Sheets link.'));
              if (!gid && !newTab.trim()) return setErr(new Error('The link has no #gid= — enter the tab name instead.'));
              await save([...sources, { id: `src-${Date.now()}`, label: newTab.trim() || `Sheet ${id.slice(0, 6)} · gid ${gid}`, kind: newKind, sheet_id: id, gid: gid ?? undefined, tab: gid ? undefined : newTab.trim(), enabled: true }]);
              setAdding(false); setNewUrl(''); setNewTab(''); setErr(null);
            }}>Add</Button>
          </div>
        )}
      </div>
    </Card>
  );
}
