import { useRef, useState } from 'react';
import { Download, Upload, Timer, Play } from 'lucide-react';
import { useApp, useAsync } from '../app/context';
import { repo, isGoogle, isLocal } from '../data';
import { callServer } from '../data/googleRepo';
import type { AutomationStatus } from '../data/googleApi';
import type { SetupFile } from '../data/demoRepo';
import { Button, Card, ConfirmModal, ErrorBox, Pill, useToast } from './ui';
import { fmtDateTime } from '../lib/metrics';

/** Local review: download users/teams/settings. Google version: load that file before the first sync. */
export function SetupTransferCard() {
  const { reloadRef, bump } = useApp();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<SetupFile | null>(null);
  const [err, setErr] = useState<unknown>(null);
  if (!isLocal && !isGoogle) return null;
  if (isLocal) return (
    <Card title="Moving to the Google version?" subtitle="Download your users, roles, teams, archive-name links and settings as one file, then load it into the Google version before its first sync. Passwords and audits are not included — audits are re-read from the sheets.">
      <Button variant="secondary" onClick={async () => {
        try {
          const data = await repo.exportSetup!();
          const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' }));
          const a = document.createElement('a'); a.href = url; a.download = `cs-qa-portal-setup-${new Date().toISOString().slice(0, 10)}.json`; a.click();
          setTimeout(() => URL.revokeObjectURL(url), 5000);
          toast(`Setup file downloaded (${data.employees.length} people, ${data.teams.length} teams).`);
        } catch (x) { setErr(x); }
      }}><Download className="h-4 w-4" />Download setup file</Button>
      <ErrorBox error={err} />
    </Card>
  );
  return (
    <Card title="Bring over your local review setup" subtitle="If you set up users, roles and teams in local review mode, load that setup file here — before the first sync, so archived names link to the same people.">
      <input ref={fileRef} type="file" accept="application/json,.json" className="hidden" aria-label="Setup file" onChange={async (e) => {
        setErr(null);
        const f = e.target.files?.[0]; e.target.value = '';
        if (!f) return;
        try { const data = JSON.parse(await f.text()) as SetupFile; if (data?.kind !== 'csqa-setup') throw new Error('This is not a CS QA Portal setup file'); setPending(data); } catch (x) { setErr(x); }
      }} />
      <Button variant="secondary" onClick={() => fileRef.current?.click()}><Upload className="h-4 w-4" />Load setup file</Button>
      <ErrorBox error={err} />
      <ConfirmModal open={!!pending} title="Replace users and teams?" confirmLabel="Load setup"
        body={<>This replaces the people, teams and settings here with the {pending?.employees.length} people and {pending?.teams.length} teams in the file (exported {pending ? fmtDateTime(pending.exported_at) : ''}). You stay a Super Admin.</>}
        onClose={() => setPending(null)}
        onConfirm={async () => {
          try { const r = await repo.importSetup!(pending!); await reloadRef(); bump(); toast(`Loaded ${r.employees} people and ${r.teams} teams.`); }
          catch (x) { setErr(x); } finally { setPending(null); }
        }} />
    </Card>
  );
}

/** Google version: the 30-minute scheduled job (live sheet sync, auto-publish, overdue reminders). */
export function AutomationCard() {
  const toast = useToast();
  const { reloadRef, bump } = useApp();
  const [v, setV] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const st = useAsync(() => callServer<AutomationStatus>('automationStatus', []), [v]);
  if (!isGoogle) return null;
  const s = st.data;
  return (
    <Card title="Automatic jobs" subtitle="Every 30 minutes Google re-reads the live audit sheet, publishes weeks that are due (a time set below, or auto-publish in Reporting settings), and reminds people about overdue appeals."
      actions={<>
        {!s?.installed && <Button loading={busy === 'on'} onClick={async () => { setBusy('on'); try { await callServer('installAutomation', []); toast('Automatic jobs turned on.'); setV((x) => x + 1); } catch (x) { toast((x as Error).message, 'bad'); } finally { setBusy(null); } }}><Timer className="h-4 w-4" />Turn on</Button>}
        <Button variant="secondary" loading={busy === 'run'} onClick={async () => { setBusy('run'); try { const r = await callServer<string>('runScheduledJobsNow', []); toast(`Done: ${r}`); await reloadRef(); bump(); setV((x) => x + 1); } catch (x) { toast((x as Error).message, 'bad'); } finally { setBusy(null); } }}><Play className="h-4 w-4" />Run now</Button>
      </>}>
      <div className="flex flex-wrap items-center gap-3 text-[13px]">
        {st.loading ? <span className="text-muted">Checking…</span> : s?.installed ? <Pill tone="good">On · every {s.every_minutes} min</Pill> : <Pill tone="warn">Off</Pill>}
        {s?.last_run && <span className="text-muted">Last run {fmtDateTime(s.last_run)}: {s.last_result}</span>}
      </div>
      <ErrorBox error={st.error} />
    </Card>
  );
}
