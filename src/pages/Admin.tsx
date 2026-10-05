import { Fragment, useMemo, useState } from 'react';
import { Copy, Eye, EyeOff, KeyRound, RefreshCw } from 'lucide-react';
import { Link } from 'react-router-dom';
import Papa from 'papaparse';
import { useApp, useAsync, useRef_ } from '../app/context';
import { repo, isDemo, isLocal } from '../data';
import { SheetSourcesCard } from '../components/SheetSync';
import { PageHeader } from '../components/Layout';
import { Button, Card, ConfirmModal, EmptyState, ErrorBox, Field, Loading, Modal, Pagination, Pill, Table, td, th, inputCls, inputBase, useToast } from '../components/ui';
import { fmtDateTime, fmtRange } from '../lib/metrics';
import { mapAuditRows, DEFAULT_COLUMN_MAP, formatWeekLabel, type MapperResult } from '../../supabase/functions/_shared/mapper';
import type { Employee, Parameter, Period, PortalSettings, Role, Team, TeamMappingRow, TeamMappingResult } from '../lib/types';

const ROLE_NAME: Record<Role, string> = { super_admin: 'Super Admin (QA)', admin: 'Admin (Team Lead)', user: 'User (CAM)' };

// =================================================================== Users & roles
export function UsersPage() {
  const { reloadRef, me } = useApp();
  const ref = useRef_();
  const toast = useToast();
  const [q, setQ] = useState(''); const [role, setRole] = useState(''); const [status, setStatus] = useState('active');
  const [edit, setEdit] = useState<Partial<Employee> | null>(null);
  const [pwFor, setPwFor] = useState<Employee | null>(null);
  const [page, setPage] = useState(1);
  const isHist = (e: Employee) => e.email.endsWith('@cam-email-needed.invalid');
  const list = ref.employees.filter((e) => !isHist(e) && (!q || (e.full_name + e.email).toLowerCase().includes(q.toLowerCase())) && (!role || e.role === role) && (!status || e.status === status));
  const pages = Math.max(1, Math.ceil(list.length / 25));
  const teamName = (id: string | null) => ref.teams.find((t) => t.id === id)?.name ?? '—';
  return (
    <div className="flex flex-col gap-5">
      {isLocal && <p className="rounded bg-info-soft px-3 py-2 text-[13px] text-info">Local review mode runs only on this computer, so invitation emails can’t be sent from here. You can set a temporary password for anyone with <strong>Set password</strong> — they can then sign in on this computer only (useful for checking what a Lead or CAM sees). Once the portal is deployed, the same button lets people sign in from anywhere.</p>}
      <PageHeader title="Users & Roles" subtitle="Only people with an active record here can sign in — either by accepting an invitation or with a temporary password you set. Temporary passwords must be changed at first sign-in."
        actions={<Button onClick={() => setEdit({ role: 'user', status: 'active' })}>Add user</Button>} />
      <div className="flex flex-wrap gap-3">
        <input aria-label="Search" className={inputBase + ' w-64'} placeholder="Search name or email" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
        <select aria-label="Role" className={inputBase + ' w-auto'} value={role} onChange={(e) => setRole(e.target.value)}><option value="">All roles</option>{(Object.keys(ROLE_NAME) as Role[]).map((r) => <option key={r} value={r}>{ROLE_NAME[r]}</option>)}</select>
        <select aria-label="Status" className={inputBase + ' w-auto'} value={status} onChange={(e) => setStatus(e.target.value)}><option value="">Any status</option><option value="active">Active</option><option value="inactive">Deactivated</option></select>
      </div>
      <Card pad={false}>
        <Table>
          <thead><tr><th className={th}>Name</th><th className={th}>Email</th><th className={th}>Role</th><th className={th}>Team</th><th className={th}>Login</th><th className={th}>Status</th><th className={th}></th></tr></thead>
          <tbody>{list.slice((page - 1) * 25, page * 25).map((e) => (
            <tr key={e.id}>
              <td className={td + ' font-medium'}>{e.full_name}</td><td className={td + ' text-muted'}>{e.email}</td><td className={td}>{ROLE_NAME[e.role]}</td>
              <td className={td}>{e.role === 'admin' ? ref.teams.filter((t) => t.lead_id === e.id).map((t) => t.name).join(', ') || '—' : teamName(e.team_id)}</td>
              <td className={td}>{isDemo || e.auth_user_id ? <Pill tone="good">Login ready</Pill> : <Pill>No login yet</Pill>}</td>
              <td className={td}>{e.status === 'active' ? <Pill tone="good">Active</Pill> : <Pill tone="bad">Deactivated</Pill>}</td>
              <td className={td + ' whitespace-nowrap'}>
                <Button size="sm" variant="ghost" onClick={() => setEdit(e)}>Edit</Button>
                {e.id !== me!.id && <Button size="sm" variant="ghost" onClick={async () => {
                  try { await repo.upsertEmployee({ ...e, status: e.status === 'active' ? 'inactive' : 'active' }); await reloadRef(); toast(e.status === 'active' ? 'User deactivated.' : 'User reactivated.'); } catch (x) { toast(String((x as Error).message), 'bad'); }
                }}>{e.status === 'active' ? 'Deactivate' : 'Reactivate'}</Button>}
                {e.id !== me!.id && e.status === 'active' && !e.email.endsWith('.invalid') && <Button size="sm" variant="ghost" onClick={() => setPwFor(e)}><KeyRound className="h-4 w-4" />{e.auth_user_id ? 'Reset password' : 'Set password'}</Button>}
                {!e.auth_user_id && e.status === 'active' && !isLocal && <Button size="sm" variant="ghost" onClick={async () => { try { await repo.inviteUser(e.id); toast(isDemo ? 'Demo: invitation recorded (no email sent).' : `Invitation emailed to ${e.email}.`); } catch (x) { toast((x as Error).message, 'bad'); } }}>Send invite</Button>}
              </td>
            </tr>
          ))}</tbody>
        </Table>
        <Pagination page={page} pages={pages} onPage={setPage} />
      </Card>
      <HistoricalNames />
      {edit && <UserModal value={edit} teams={ref.teams} onClose={() => setEdit(null)} onSaved={async () => { await reloadRef(); setEdit(null); toast('User saved.'); }} />}
      {pwFor && <SetPasswordModal user={pwFor} onClose={() => setPwFor(null)} onSaved={reloadRef} />}
    </div>
  );
}

/** Random temporary password: 14 characters, no look-alikes (0/O, 1/l/I), always has a letter and a digit. */
function generatePassword() {
  const letters = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ', digits = '23456789', all = letters + digits;
  const pick = (set: string) => { const b = new Uint32Array(1); crypto.getRandomValues(b); return set[b[0] % set.length]; };
  for (;;) {
    const pw = Array.from({ length: 14 }, () => pick(all)).join('');
    if (/[A-Za-z]/.test(pw) && /\d/.test(pw)) return pw;
  }
}

/** Super Admin only (the page and the backend both check). The password is shown here once and never stored in readable form. */
function SetPasswordModal({ user, onClose, onSaved }: { user: Employee; onClose: () => void; onSaved: () => Promise<void> }) {
  const toast = useToast();
  const [pw, setPw] = useState(generatePassword);
  const [show, setShow] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [done, setDone] = useState(false);
  const copy = async () => { try { await navigator.clipboard.writeText(pw); toast('Password copied.'); } catch { toast('Copy failed — select the password and copy it manually.', 'bad'); } };
  return (
    <Modal open title={done ? 'Password set' : `${user.auth_user_id ? 'Reset' : 'Set'} password — ${user.full_name}`} onClose={onClose}
      footer={done ? <Button onClick={onClose}>Done</Button> : <>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button loading={busy} onClick={async () => {
          setErr(null); setBusy(true);
          try { await repo.setUserPassword(user.id, pw); await onSaved(); setDone(true); setShow(true); } catch (x) { setErr(x); } finally { setBusy(false); }
        }}>Save password</Button>
      </>}>
      <div className="flex flex-col gap-3 text-[13.5px]">
        {!done ? <p className="text-muted">Sign-in email: <strong className="text-ink">{user.email}</strong>. A strong password has been generated — you can keep it or type your own (at least 10 characters with a letter and a number).{user.auth_user_id ? ' Their current password stops working immediately.' : ''}</p>
          : <p className="rounded bg-good-soft px-3 py-2 text-good">Saved. Share these details with {user.full_name} privately (not in a group chat or email thread). <strong>This is the only time the password is shown</strong> — if it’s lost, just reset it again.</p>}
        <Field label="Temporary password" htmlFor="tmp-pw">
          <div className="flex gap-2">
            <input id="tmp-pw" readOnly={done} type={show ? 'text' : 'password'} autoComplete="off" spellCheck={false} className={inputCls + ' font-mono tracking-wide'} value={pw} onChange={(e) => setPw(e.target.value)} />
            <Button variant="secondary" size="sm" aria-label={show ? 'Hide password' : 'Show password'} onClick={() => setShow((s) => !s)}>{show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}</Button>
            <Button variant="secondary" size="sm" onClick={copy}><Copy className="h-4 w-4" />Copy</Button>
            {!done && <Button variant="ghost" size="sm" aria-label="Generate another" onClick={() => setPw(generatePassword())}><RefreshCw className="h-4 w-4" /></Button>}
          </div>
        </Field>
        <p className="text-[12.5px] text-muted">They’ll be asked to choose their own password the first time they sign in. The portal keeps only a scrambled (hashed) copy, so no one — including QA — can look the password up later.{isLocal ? ' In local review mode they can sign in on this computer only.' : ''}</p>
        <ErrorBox error={err} />
      </div>
    </Modal>
  );
}
/** Archived audits only carry a name ("Akanksha R"). Link each name to the real CAM so their history shows on their dashboard. */
function HistoricalNames() {
  const { reloadRef, bump } = useApp();
  const ref = useRef_();
  const toast = useToast();
  const h = useAsync(() => repo.historicalCams(), [ref.employees.length]);
  const [pick, setPick] = useState<Record<string, string>>({});
  const [confirm, setConfirm] = useState<{ id: string; name: string; into: string } | null>(null);
  const cams = ref.employees.filter((e) => e.role === 'user' && !e.email.endsWith('@cam-email-needed.invalid')).sort((a, b) => a.full_name.localeCompare(b.full_name));
  const rows = h.data ?? [];
  if (!h.loading && !rows.length) return null;
  return (
    <Card title={`Names from archived audits (${rows.length})`} subtitle="These names come from the 2022–2025 archives, which record the CAM’s name rather than their email. Link a name to the CAM it belongs to, and their older audits will show on that CAM’s dashboard. Names you don’t link stay as history only, and they can’t sign in." pad={false}>
      {h.loading ? <Loading /> : (
        <Table>
          <thead><tr><th className={th}>Name in archive</th><th className={th + ' text-right'}>Audits</th><th className={th}>Weeks</th><th className={th}>Link to CAM</th><th className={th}></th></tr></thead>
          <tbody>{rows.map((r) => {
            const sel = pick[r.id] ?? (r.candidates.length === 1 ? r.candidates[0].id : '');
            return (
              <tr key={r.id}>
                <td className={td + ' font-medium'}>{r.name}</td>
                <td className={td + ' text-right tnum'}>{r.tasks}</td>
                <td className={td + ' whitespace-nowrap text-muted'}>{r.first_week ?? '—'} → {r.last_week ?? '—'}</td>
                <td className={td}>
                  <select aria-label={`Link ${r.name}`} className={inputBase + ' w-auto max-w-[260px]'} value={sel} onChange={(e) => setPick({ ...pick, [r.id]: e.target.value })}>
                    <option value="">Keep as history only</option>
                    {r.candidates.length > 0 && <optgroup label="Suggested">{r.candidates.map((c) => <option key={c.id} value={c.id}>{c.name} · {c.email}</option>)}</optgroup>}
                    <optgroup label="All CAMs">{cams.map((c) => <option key={c.id} value={c.id}>{c.full_name} · {c.email}</option>)}</optgroup>
                  </select>
                  {r.candidates.length === 1 && !pick[r.id] && <div className="text-[11.5px] text-muted">Suggested match</div>}
                </td>
                <td className={td}><Button size="sm" variant="secondary" disabled={!sel} onClick={() => setConfirm({ id: r.id, name: r.name, into: sel })}>Link</Button></td>
              </tr>
            );
          })}</tbody>
        </Table>
      )}
      <ConfirmModal open={!!confirm} title="Link archived name" confirmLabel="Link" onClose={() => setConfirm(null)}
        onConfirm={async () => { const r = await repo.mergeEmployee(confirm!.id, confirm!.into); await reloadRef(); bump(); toast(`${r.moved} archived audit(s) moved to ${cams.find((c) => c.id === confirm!.into)?.full_name}.`); }}
        body={<p>Move every archived audit recorded as <strong>“{confirm?.name}”</strong> to <strong>{cams.find((c) => c.id === confirm?.into)?.full_name}</strong>? Future imports of this name will go to the same CAM. This is logged in the audit log.</p>} />
    </Card>
  );
}

function UserModal({ value, teams, onClose, onSaved }: { value: Partial<Employee>; teams: Team[]; onClose: () => void; onSaved: () => void }) {
  const [v, setV] = useState(value); const [busy, setBusy] = useState(false); const [err, setErr] = useState<unknown>(null);
  return (
    <Modal open title={v.id ? 'Edit user' : 'Add user'} onClose={onClose} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button>
      <Button loading={busy} onClick={async () => { setBusy(true); setErr(null); try { await repo.upsertEmployee(v as Employee); onSaved(); } catch (x) { setErr(x); } finally { setBusy(false); } }}>Save</Button></>}>
      <div className="flex flex-col gap-3">
        <Field label="Full name" htmlFor="u-name" required><input id="u-name" className={inputCls} value={v.full_name ?? ''} onChange={(e) => setV({ ...v, full_name: e.target.value })} /></Field>
        <Field label="Company email" htmlFor="u-email" required hint="Must match the CAM Name email used in the audit sheet."><input id="u-email" type="email" className={inputCls} value={v.email ?? ''} onChange={(e) => setV({ ...v, email: e.target.value })} /></Field>
        <Field label="Role" htmlFor="u-role"><select id="u-role" className={inputCls} value={v.role} onChange={(e) => setV({ ...v, role: e.target.value as Role })}>{(Object.keys(ROLE_NAME) as Role[]).map((r) => <option key={r} value={r}>{ROLE_NAME[r]}</option>)}</select></Field>
        {v.role === 'user' && <Field label="Team" htmlFor="u-team" hint="Appeals are routed to this team’s Lead."><select id="u-team" className={inputCls} value={v.team_id ?? ''} onChange={(e) => setV({ ...v, team_id: e.target.value || null })}><option value="">No team</option>{teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></Field>}
        <ErrorBox error={err} />
      </div>
    </Modal>
  );
}

// =================================================================== Teams
export function TeamsPage() {
  const { reloadRef } = useApp();
  const ref = useRef_();
  const toast = useToast();
  const [edit, setEdit] = useState<Partial<Team> | null>(null);
  const [del, setDel] = useState<Team | null>(null);
  const leads = ref.employees.filter((e) => e.role === 'admin' && e.status === 'active');
  const cams = ref.employees.filter((e) => e.role === 'user' && e.status === 'active');
  const unassigned = cams.filter((c) => !c.team_id);
  const move = async (cam: Employee, team: string) => { try { await repo.upsertEmployee({ ...cam, team_id: team || null }); await reloadRef(); toast(`${cam.full_name} moved.`); } catch (x) { toast((x as Error).message, 'bad'); } };
  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Teams & CAM Assignments" subtitle="Each team has one Team Lead. A Lead sees only the CAMs in their team(s), and receives those CAMs’ appeals."
        actions={<Button onClick={() => setEdit({ name: '', lead_id: null })}>Add team</Button>} />
      {unassigned.length > 0 && <div className="rounded-lg border border-warn/40 bg-warn-soft px-4 py-2.5 text-[13px] text-warn">{unassigned.length} active CAM(s) have no team, so their appeals cannot be routed to a Lead: {unassigned.map((c) => c.full_name).join(', ')}.</div>}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {ref.teams.map((t) => {
          const members = cams.filter((c) => c.team_id === t.id);
          return (
            <Card key={t.id} title={t.name} subtitle={(() => { const l = ref.employees.find((e) => e.id === t.lead_id); return l ? `Team Lead: ${l.full_name} · ${l.email}` : 'Team Lead: not assigned'; })()}
              actions={<><Button size="sm" variant="ghost" onClick={() => setEdit(t)}>Edit</Button><Button size="sm" variant="ghost" onClick={() => setDel(t)}>Delete</Button></>}>
              {members.length === 0 ? <p className="text-[13px] text-muted">No CAMs yet.</p> : (
                <ul className="flex flex-col gap-1.5">{members.map((c) => (
                  <li key={c.id} className="flex items-center justify-between gap-2 text-[13px]"><span>{c.full_name}</span>
                    <select aria-label={`Move ${c.full_name}`} className={inputBase + ' h-8 w-auto text-[12.5px]'} value={t.id} onChange={(e) => move(c, e.target.value)}>
                      {ref.teams.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}<option value="">Remove from team</option></select></li>
                ))}</ul>
              )}
              {unassigned.length > 0 && <select aria-label="Add CAM" className={inputCls + ' mt-3'} value="" onChange={(e) => { const c = cams.find((x) => x.id === e.target.value); if (c) move(c, t.id); }}>
                <option value="">+ Add an unassigned CAM</option>{unassigned.map((c) => <option key={c.id} value={c.id}>{c.full_name}</option>)}</select>}
            </Card>
          );
        })}
      </div>
      <MappingImport onDone={reloadRef} />
      {edit && <TeamModal value={edit} leads={leads} onClose={() => setEdit(null)} onSaved={async () => { await reloadRef(); setEdit(null); toast('Team saved.'); }} />}
      <ConfirmModal open={!!del} title="Delete team" confirmLabel="Delete team" danger onClose={() => setDel(null)} onConfirm={async () => { await repo.deleteTeam(del!.id); await reloadRef(); toast('Team deleted.'); }}
        body={<p>Delete <strong>{del?.name}</strong>? Teams with CAMs cannot be deleted — move them first.</p>} />
    </div>
  );
}
/** CSV/XLSX with CAM Email, CAM Name, Lead Email, Lead Name, Team (header names are matched loosely). */
function MappingImport({ onDone }: { onDone: () => Promise<void> }) {
  const toast = useToast();
  const [rows, setRows] = useState<TeamMappingRow[] | null>(null);
  const [res, setRes] = useState<TeamMappingResult | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const pick = (rec: Record<string, string>, ...names: RegExp[]) => {
    const k = Object.keys(rec).find((h) => names.some((n) => n.test(h.trim())));
    return k ? String(rec[k] ?? '').trim() : '';
  };
  const parse = async (f: File) => {
    setErr(null); setRes(null);
    try {
      let recs: Record<string, string>[] = [];
      if (/\.xlsx$/i.test(f.name)) {
        const ExcelJS = (await import('exceljs')).default;
        const wb = new ExcelJS.Workbook(); await wb.xlsx.load(await f.arrayBuffer());
        const ws = wb.worksheets[0]; const hdr: string[] = [];
        ws.getRow(1).eachCell({ includeEmpty: true }, (c, i) => { hdr[i - 1] = String(c.text ?? ''); });
        ws.eachRow((row, n) => { if (n > 1) { const r: Record<string, string> = {}; hdr.forEach((h, i) => { r[h] = String(row.getCell(i + 1).text ?? ''); }); recs.push(r); } });
      } else recs = Papa.parse<Record<string, string>>(await f.text(), { header: true, skipEmptyLines: true }).data;
      const out = recs.map((r) => ({
        cam_email: pick(r, /^cam.*e-?mail/i, /^e-?mail$/i), cam_name: pick(r, /^cam( full)? name$/i, /^cam$/i, /^name$/i),
        lead_email: pick(r, /^(team )?lead.*e-?mail/i, /^tl.*e-?mail/i), lead_name: pick(r, /^(team )?lead( name)?$/i, /^tl$/i), team: pick(r, /^team( name)?$/i),
      })).filter((r) => r.cam_email || r.lead_email);
      if (!out.length) throw new Error('No rows found. The file needs columns like “CAM Email” and “Lead Email”.');
      setRows(out);
    } catch (x) { setErr(x); }
  };
  return (
    <Card title="Import CAM ↔ Team Lead mapping" subtitle="Upload a CSV or Excel file with CAM Email, CAM Name, Lead Email, Lead Name and (optional) Team. Leads get Admin access and are CC’d on their CAMs’ weekly emails.">
      <div className="flex flex-col gap-3 text-[13px]">
        <input aria-label="Mapping file" type="file" accept=".csv,.xlsx" onChange={(e) => { const f = e.target.files?.[0]; if (f) parse(f); }} />
        {rows && <>
          <p><strong className="tnum">{rows.length}</strong> row(s) read · {new Set(rows.map((r) => r.lead_email)).size} Lead(s) · {rows.filter((r) => !r.cam_email || !r.lead_email).length} incomplete</p>
          <div className="max-h-48 overflow-auto rounded border border-line"><Table><thead><tr><th className={th}>CAM</th><th className={th}>CAM email</th><th className={th}>Lead</th><th className={th}>Lead email</th><th className={th}>Team</th></tr></thead>
            <tbody>{rows.slice(0, 50).map((r, i) => <tr key={i}><td className={td}>{r.cam_name}</td><td className={td}>{r.cam_email}</td><td className={td}>{r.lead_name}</td><td className={td}>{r.lead_email || <span className="text-bad">missing</span>}</td><td className={td}>{r.team || <span className="text-faint">Team {r.lead_name}</span>}</td></tr>)}</tbody></Table></div>
          <div><Button loading={busy} onClick={async () => { setBusy(true); setErr(null); try { const r = await repo.importTeamMapping(rows); setRes(r); setRows(null); await onDone(); toast('Team mapping imported.'); } catch (x) { setErr(x); } finally { setBusy(false); } }}>Import mapping</Button></div>
        </>}
        {res && <p className="rounded bg-good-soft px-3 py-2 text-good">{res.rows} rows · {res.new_leads} new Lead(s) · {res.new_teams} new team(s) · {res.new_cams} new CAM(s) · {res.reassigned} CAM(s) moved · {res.rejected} rejected</p>}
        <ErrorBox error={err} />
      </div>
    </Card>
  );
}

function TeamModal({ value, leads, onClose, onSaved }: { value: Partial<Team>; leads: Employee[]; onClose: () => void; onSaved: () => void }) {
  const [v, setV] = useState(value); const [busy, setBusy] = useState(false); const [err, setErr] = useState<unknown>(null);
  return (
    <Modal open title={v.id ? 'Edit team' : 'Add team'} onClose={onClose} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button>
      <Button loading={busy} onClick={async () => { setBusy(true); setErr(null); try { await repo.upsertTeam(v as Team); onSaved(); } catch (x) { setErr(x); } finally { setBusy(false); } }}>Save</Button></>}>
      <div className="flex flex-col gap-3">
        <Field label="Team name" htmlFor="t-name" required><input id="t-name" className={inputCls} value={v.name ?? ''} onChange={(e) => setV({ ...v, name: e.target.value })} /></Field>
        <Field label="Team Lead" htmlFor="t-lead" hint="Only users with the Admin role can lead a team."><select id="t-lead" className={inputCls} value={v.lead_id ?? ''} onChange={(e) => setV({ ...v, lead_id: e.target.value || null })}><option value="">Not assigned</option>{leads.map((l) => <option key={l.id} value={l.id}>{l.full_name}</option>)}</select></Field>
        <ErrorBox error={err} />
      </div>
    </Modal>
  );
}

// =================================================================== Scoring configuration
export function ScoringPage() {
  const { reloadRef } = useApp();
  const ref = useRef_();
  const toast = useToast();
  const [draft, setDraft] = useState<Record<string, Partial<Parameter>>>({});
  const [adding, setAdding] = useState<string | null>(null);
  const [newP, setNewP] = useState({ name: '', max_score: '10', section: '' });
  const [confirm, setConfirm] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const save = async (type: string) => {
    for (const [id, patch] of Object.entries(draft)) {
      const p = ref.parameters.find((x) => x.id === id);
      if (p?.task_type === type) await repo.updateParameter(id, { ...patch, max_score: patch.max_score !== undefined ? Number(patch.max_score) : undefined });
    }
    setDraft((d) => Object.fromEntries(Object.entries(d).filter(([id]) => ref.parameters.find((x) => x.id === id)?.task_type !== type)));
    await reloadRef(); toast('Scoring updated. The change is recorded in the audit log.');
  };
  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="QA Scoring Configuration" subtitle="Parameters and maximum scores per task type, as used by the live audit form. Changes apply to future imports; recorded evaluations keep the maximum that applied when they were audited." />
      <ErrorBox error={err} />
      {ref.taskTypes.map((t) => {
        const ps = ref.parameters.filter((p) => p.task_type === t.code).sort((a, b) => a.sort_order - b.sort_order);
        const val = (p: Parameter) => ({ ...p, ...draft[p.id] });
        const total = ps.filter((p) => val(p).active).reduce((a, p) => a + Number(val(p).max_score), 0);
        const dirty = ps.some((p) => draft[p.id]);
        return (
          <Card key={t.code} title={t.name} subtitle={<>Audit form label: “{t.source_label}” · Active total <strong className={total === 100 ? 'text-good' : 'text-bad'}>{total}</strong> / 100</>}
            actions={<><Button size="sm" variant="secondary" onClick={() => setAdding(t.code)}>Add parameter</Button><Button size="sm" disabled={!dirty} onClick={() => setConfirm(t.code)}>Save changes</Button></>} pad={false}>
            <Table>
              <thead><tr><th className={th}>Parameter</th><th className={th}>Section</th><th className={th + ' text-right'}>Max score</th><th className={th}>Sheet column</th><th className={th}>Active</th></tr></thead>
              <tbody>{ps.map((p) => { const v = val(p); return (
                <tr key={p.id}>
                  <td className={td}><label htmlFor={`pn-${p.id}`} className="sr-only">Name</label><input id={`pn-${p.id}`} className={inputCls} value={v.name} onChange={(e) => setDraft((d) => ({ ...d, [p.id]: { ...d[p.id], name: e.target.value } }))} /></td>
                  <td className={td + ' text-muted'}>{p.section ?? '—'}</td>
                  <td className={td + ' text-right'}><label htmlFor={`pm-${p.id}`} className="sr-only">Max</label><input id={`pm-${p.id}`} type="number" min={1} className={inputBase + ' w-20 text-right'} value={v.max_score} onChange={(e) => setDraft((d) => ({ ...d, [p.id]: { ...d[p.id], max_score: e.target.value as unknown as number } }))} /></td>
                  <td className={td + ' font-mono text-[11.5px] text-muted'}>{p.source_column?.trim() ?? '—'}</td>
                  <td className={td}><input aria-label="Active" type="checkbox" checked={v.active} onChange={(e) => setDraft((d) => ({ ...d, [p.id]: { ...d[p.id], active: e.target.checked } }))} /></td>
                </tr>); })}</tbody>
            </Table>
            {total !== 100 && <p className="px-4 py-2 text-[12.5px] text-bad">Active maximum scores add up to {total}. Task scores are computed as a percentage of applicable points, but the audit form expects 100.</p>}
          </Card>
        );
      })}
      <Card title="Scoring rules applied by the portal">
        <ul className="flex list-disc flex-col gap-1 pl-5 text-[13px] text-muted">
          <li>Task score = sum of earned parameter points ÷ sum of applicable maximum points × 100. Parameters recorded as NA are excluded (not treated as zero).</li>
          <li>Autofail = Yes sets the task score to 0 and is counted separately from point deductions.</li>
          <li>First Contact Resolution is stored as Yes/No and reported as FCR rate; it does not change the score (as in the current audit form).</li>
          <li>Imported rows are rejected if the recorded Score does not match the parameter total, so the portal never disagrees with the sheet.</li>
          <li>Weekly average = mean of task scores in the audit week. Variance is in percentage points.</li>
        </ul>
      </Card>
      <ConfirmModal open={!!confirm} title="Save scoring changes" confirmLabel="Save" onClose={() => setConfirm(null)} onConfirm={async () => { try { await save(confirm!); } catch (x) { setErr(x); throw x; } }}
        body={<p>Scoring changes affect how future imports are validated and are written to the audit log. Existing evaluations are not re-scored.</p>} />
      <Modal open={!!adding} title="Add parameter" onClose={() => setAdding(null)} footer={<><Button variant="secondary" onClick={() => setAdding(null)}>Cancel</Button>
        <Button onClick={async () => { try { await repo.createParameter({ task_type: adding!, name: newP.name, max_score: Number(newP.max_score), section: newP.section || null, sort_order: 99, source_column: null, active: true }); await reloadRef(); setAdding(null); toast('Parameter added.'); } catch (x) { toast((x as Error).message, 'bad'); } }}>Add</Button></>}>
        <div className="flex flex-col gap-3">
          <Field label="Name" htmlFor="np-name" required><input id="np-name" className={inputCls} value={newP.name} onChange={(e) => setNewP({ ...newP, name: e.target.value })} /></Field>
          <Field label="Maximum score" htmlFor="np-max" required><input id="np-max" type="number" className={inputCls} value={newP.max_score} onChange={(e) => setNewP({ ...newP, max_score: e.target.value })} /></Field>
          <Field label="Section (optional)" htmlFor="np-sec"><input id="np-sec" className={inputCls} value={newP.section} onChange={(e) => setNewP({ ...newP, section: e.target.value })} placeholder="e.g. Soft Skills" /></Field>
        </div>
      </Modal>
    </div>
  );
}

// =================================================================== Reporting periods & settings
export function PeriodsPage() {
  const { reloadRef } = useApp();
  const ref = useRef_();
  const toast = useToast();
  const [s, setS] = useState<PortalSettings>(ref.settings);
  const [busy, setBusy] = useState<string | null>(null);
  const [newWeek, setNewWeek] = useState(false);
  const sorted = [...ref.periods].reverse();
  const saveKey = async <K extends keyof PortalSettings>(k: K) => { setBusy(k); try { await repo.updateSetting(k, s[k]); await reloadRef(); toast('Settings saved.'); } catch (x) { toast((x as Error).message, 'bad'); } finally { setBusy(null); } };
  const num = (v: string) => (v === '' ? 0 : Number(v));
  const DOW = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Reporting Periods & Settings" subtitle="Audit weeks are created automatically from the QA Week label on import. Publishing a week releases every CAM’s report at once — no per-CAM date changes." actions={<Button variant="secondary" onClick={() => setNewWeek(true)}>Add audit week</Button>} />
      <Card title="Audit weeks" pad={false}>
        <Table>
          <thead><tr><th className={th}>Week</th><th className={th}>Dates</th><th className={th}>Status</th><th className={th}>Published</th><th className={th}>Auto-publish at</th><th className={th}></th></tr></thead>
          <tbody>{sorted.slice(0, 20).map((p) => (
            <tr key={p.id}>
              <td className={td + ' font-medium'}>{p.label}</td><td className={td + ' text-muted'}>{fmtRange(p.start_date, p.end_date)}</td>
              <td className={td}>{p.status === 'published' ? <Pill tone="good">Published</Pill> : <Pill tone="warn">Draft — QA only</Pill>}</td>
              <td className={td + ' text-muted'}>{fmtDateTime(p.published_at)}</td>
              <td className={td}><label htmlFor={`ap-${p.id}`} className="sr-only">Auto publish</label><input id={`ap-${p.id}`} type="datetime-local" className={inputBase + ' w-auto'} disabled={p.status === 'published'}
                defaultValue={p.auto_publish_at ? p.auto_publish_at.slice(0, 16) : ''} onBlur={async (e) => { if (!e.target.value) return; await repo.upsertPeriod({ ...p, auto_publish_at: new Date(e.target.value).toISOString() }); await reloadRef(); toast('Auto-publish time saved.'); }} /></td>
              <td className={td}><Button size="sm" variant={p.status === 'published' ? 'ghost' : 'primary'} loading={busy === p.id} onClick={async () => {
                setBusy(p.id);
                try { await repo.setPeriodStatus(p.id, p.status === 'published' ? 'draft' : 'published'); await reloadRef(); toast(p.status === 'published' ? `${p.short_label} unpublished.` : `${p.short_label} published. CAMs see it now; use “Email CAMs” to send the weekly emails.`); }
                catch (x) { toast((x as Error).message, 'bad'); } finally { setBusy(null); }
              }}>{p.status === 'published' ? 'Unpublish' : 'Publish'}</Button>
                {p.status === 'published' && <Link to={`/admin/emails?period=${p.id}`} className="ml-2 text-[12.5px] font-medium text-brand hover:underline">Email CAMs</Link>}</td>
            </tr>
          ))}</tbody>
        </Table>
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Targets & colour bands" actions={<Button size="sm" loading={busy === 'qa_target'} onClick={async () => { await saveKey('qa_target'); await saveKey('thresholds'); }}>Save</Button>}>
          <div className="grid grid-cols-2 gap-3">
            <Field label="QA score target (%)" htmlFor="s-target"><input id="s-target" type="number" className={inputCls} value={s.qa_target.score} onChange={(e) => setS({ ...s, qa_target: { ...s.qa_target, score: num(e.target.value) } })} /></Field>
            <Field label="FCR rate target (%)" htmlFor="s-fcr"><input id="s-fcr" type="number" className={inputCls} value={s.qa_target.fcr_rate} onChange={(e) => setS({ ...s, qa_target: { ...s.qa_target, fcr_rate: num(e.target.value) } })} /></Field>
            <Field label="Green from (%)" htmlFor="s-green"><input id="s-green" type="number" className={inputCls} value={s.thresholds.green} onChange={(e) => setS({ ...s, thresholds: { ...s.thresholds, green: num(e.target.value) } })} /></Field>
            <Field label="Amber from (%)" htmlFor="s-amber" hint="Below amber shows red."><input id="s-amber" type="number" className={inputCls} value={s.thresholds.amber} onChange={(e) => setS({ ...s, thresholds: { ...s.thresholds, amber: num(e.target.value) } })} /></Field>
            <Field label="Max autofail rate (%)" htmlFor="s-af"><input id="s-af" type="number" className={inputCls} value={s.qa_target.autofail_rate_max} onChange={(e) => setS({ ...s, qa_target: { ...s.qa_target, autofail_rate_max: num(e.target.value) } })} /></Field>
          </div>
        </Card>
        <Card title="Appeal window & review targets" actions={<Button size="sm" loading={busy === 'appeal_window'} onClick={async () => { await saveKey('appeal_window'); await saveKey('sla'); }}>Save</Button>}>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Appeal window (days after publication)" htmlFor="s-aw"><input id="s-aw" type="number" className={inputCls} value={s.appeal_window.days} onChange={(e) => setS({ ...s, appeal_window: { ...s.appeal_window, days: num(e.target.value) } })} /></Field>
            <Field label="Count" htmlFor="s-bd"><select id="s-bd" className={inputCls} value={s.appeal_window.business_days ? 'b' : 'c'} onChange={(e) => setS({ ...s, appeal_window: { ...s.appeal_window, business_days: e.target.value === 'b' } })}><option value="b">Business days</option><option value="c">Calendar days</option></select></Field>
            <Field label="Max appeals per CAM per week" htmlFor="s-max" hint="Leave empty for no limit. SOP: one per audit cycle."><input id="s-max" type="number" className={inputCls} value={s.appeal_window.max_appeals_per_cam_per_period ?? ''} onChange={(e) => setS({ ...s, appeal_window: { ...s.appeal_window, max_appeals_per_cam_per_period: e.target.value === '' ? null : num(e.target.value) } })} /></Field>
            <Field label="Lead review target (days)" htmlFor="s-lr"><input id="s-lr" type="number" className={inputCls} value={s.sla.lead_review_days} onChange={(e) => setS({ ...s, sla: { ...s.sla, lead_review_days: num(e.target.value) } })} /></Field>
            <Field label="QA review target (days)" htmlFor="s-qr"><input id="s-qr" type="number" className={inputCls} value={s.sla.qa_review_days} onChange={(e) => setS({ ...s, sla: { ...s.sla, qa_review_days: num(e.target.value) } })} /></Field>
            <Field label="Clarification response time (business days)" htmlFor="s-cl"><input id="s-cl" type="number" className={inputCls} value={s.sla.clarification_days} onChange={(e) => setS({ ...s, sla: { ...s.sla, clarification_days: num(e.target.value) } })} /></Field>
          </div>
        </Card>
        <Card title="Weekly reporting schedule" actions={<Button size="sm" loading={busy === 'reporting'} onClick={() => saveKey('reporting')}>Save</Button>}>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Audit week starts on" htmlFor="s-dow" hint="The current audit form uses Thursday–Wednesday weeks."><select id="s-dow" className={inputCls} value={s.reporting.week_start_dow} onChange={(e) => setS({ ...s, reporting: { ...s.reporting, week_start_dow: num(e.target.value) } })}>{DOW.slice(1).map((d, i) => <option key={d} value={i + 1}>{d}</option>)}</select></Field>
            <Field label="Auto-publish weekly" htmlFor="s-apub"><select id="s-apub" className={inputCls} value={s.reporting.auto_publish ? 'y' : 'n'} onChange={(e) => setS({ ...s, reporting: { ...s.reporting, auto_publish: e.target.value === 'y' } })}><option value="n">No — QA publishes manually</option><option value="y">Yes — on schedule</option></select></Field>
            <Field label="Publish on" htmlFor="s-pdow"><select id="s-pdow" className={inputCls} value={s.reporting.auto_publish_dow} onChange={(e) => setS({ ...s, reporting: { ...s.reporting, auto_publish_dow: num(e.target.value) } })}>{DOW.slice(1).map((d, i) => <option key={d} value={i + 1}>{d}</option>)}</select></Field>
            <Field label="at (local time)" htmlFor="s-ptime"><input id="s-ptime" type="time" className={inputCls} value={s.reporting.auto_publish_time} onChange={(e) => setS({ ...s, reporting: { ...s.reporting, auto_publish_time: e.target.value } })} /></Field>
          </div>
          <p className="mt-3 text-[12px] text-muted">Scheduled publishing runs through the <code className="font-mono">publish_due_periods()</code> job (pg_cron). See the deployment guide.</p>
        </Card>
        <Card title="Notifications" actions={<Button size="sm" loading={busy === 'notifications'} onClick={() => saveKey('notifications')}>Save</Button>}>
          <div className="flex flex-col gap-3 text-[13px]">
            <label htmlFor="s-email" className="flex items-center gap-2"><input id="s-email" type="checkbox" checked={s.notifications.email_enabled} onChange={(e) => setS({ ...s, notifications: { ...s.notifications, email_enabled: e.target.checked } })} />Send email notifications (in addition to in-app)</label>
            <Field label="Portal URL used in email links" htmlFor="s-url"><input id="s-url" className={inputCls} value={s.notifications.portal_url} placeholder="https://qa-portal.your-domain.com/#" onChange={(e) => setS({ ...s, notifications: { ...s.notifications, portal_url: e.target.value } })} /></Field>
            <div className="grid gap-1.5 sm:grid-cols-2">
              {['report_published', 'appeal_submitted', 'appeal_forwarded', 'appeal_returned', 'appeal_info_requested', 'appeal_decided', 'score_changed', 'appeal_overdue'].map((k) => (
                <label key={k} htmlFor={`n-${k}`} className="flex items-center gap-2"><input id={`n-${k}`} type="checkbox" checked={s.notifications.in_app[k] !== false} onChange={(e) => setS({ ...s, notifications: { ...s.notifications, in_app: { ...s.notifications.in_app, [k]: e.target.checked } } })} />{k.replace(/_/g, ' ')}</label>
              ))}
            </div>
            <p className="text-[12px] text-muted">Emails contain only the appeal reference, task ID, status and a secure portal link — never scores, feedback or other CAMs’ data. {isDemo && 'Emails are not sent in demo mode.'}</p>
          </div>
        </Card>
      </div>
      {newWeek && <NewWeekModal onClose={() => setNewWeek(false)} onSaved={async () => { await reloadRef(); setNewWeek(false); toast('Audit week added as draft.'); }} weekStart={s.reporting.week_start_dow} periods={ref.periods} />}
    </div>
  );
}
function NewWeekModal({ onClose, onSaved, weekStart, periods }: { onClose: () => void; onSaved: () => void; weekStart: number; periods: Period[] }) {
  const last = periods[periods.length - 1];
  const nextStart = last ? new Date(Date.parse(last.end_date + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
  const [start, setStart] = useState(nextStart);
  const [week, setWeek] = useState(String((last?.week_number ?? 0) + 1));
  const [err, setErr] = useState<unknown>(null);
  const end = new Date(Date.parse(start + 'T00:00:00Z') + 6 * 86400000).toISOString().slice(0, 10);
  const year = Number(start.slice(0, 4));
  const dow = ((new Date(start + 'T00:00:00Z').getUTCDay() + 6) % 7) + 1;
  return (
    <Modal open title="Add audit week" onClose={onClose} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button>
      <Button onClick={async () => { try { await repo.upsertPeriod({ label: formatWeekLabel(Number(week), year, start, end), short_label: `WK-${week}`, year, week_number: Number(week), start_date: start, end_date: end }); onSaved(); } catch (x) { setErr(x); } }}>Add week</Button></>}>
      <div className="flex flex-col gap-3">
        <Field label="Week number" htmlFor="nw-num"><input id="nw-num" type="number" className={inputCls} value={week} onChange={(e) => setWeek(e.target.value)} /></Field>
        <Field label="Start date" htmlFor="nw-start" hint={dow !== weekStart ? 'This date does not match the configured week start day.' : `Ends ${end}`}><input id="nw-start" type="date" className={inputCls} value={start} onChange={(e) => setStart(e.target.value)} /></Field>
        <p className="text-[13px]">Label: <code className="font-mono">{formatWeekLabel(Number(week), year, start, end)}</code></p>
        <ErrorBox error={err} />
      </div>
    </Modal>
  );
}

// =================================================================== Data import
export function ImportPage() {
  const { reloadRef, bump } = useApp();
  const ref = useRef_();
  const toast = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<MapperResult | null>(null);
  const [parsing, setParsing] = useState(false);
  const [publish, setPublish] = useState(false);
  const [tz, setTz] = useState('+05:30');
  const [progress, setProgress] = useState<[number, number] | null>(null);
  const [summary, setSummary] = useState<{ total: number; inserted: number; duplicates: number; rejected: number } | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [batch, setBatch] = useState<string | null>(null);
  const batches = useAsync(() => repo.listImportBatches(), [summary]);
  const rejections = useAsync(() => (batch ? repo.listImportRejections(batch) : Promise.resolve([])), [batch]);
  const liveSrc = ref.settings.data_sources.sources.find((s) => s.kind === 'live' && s.gid);
  const sheetExportUrl = liveSrc ? `https://docs.google.com/spreadsheets/d/${liveSrc.sheet_id}/export?format=csv&gid=${liveSrc.gid}` : null;

  const parse = async (f: File) => {
    setParsing(true); setErr(null); setResult(null); setSummary(null);
    try {
      let records: Record<string, string>[] = [];
      if (/\.xlsx$/i.test(f.name)) {
        const ExcelJS = (await import('exceljs')).default;
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(await f.arrayBuffer());
        const ws = wb.worksheets[0];
        const header: string[] = [];
        ws.getRow(1).eachCell({ includeEmpty: true }, (c, i) => { header[i - 1] = String(c.text ?? ''); });
        ws.eachRow((row, n) => {
          if (n === 1) return;
          const rec: Record<string, string> = {};
          header.forEach((h, i) => { const c = row.getCell(i + 1); const v = c.value instanceof Date ? `${c.value.getUTCMonth() + 1}/${c.value.getUTCDate()}/${c.value.getUTCFullYear()} ${c.value.getUTCHours()}:${String(c.value.getUTCMinutes()).padStart(2, '0')}:${String(c.value.getUTCSeconds()).padStart(2, '0')}` : c.text; rec[h || `col${i}`] = String(v ?? ''); });
          records.push(rec);
        });
      } else {
        const text = await f.text();
        records = Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: true }).data;
      }
      const r = mapAuditRows(records, ref.taskTypes, ref.parameters, { timezoneOffset: tz });
      setResult(r);
    } catch (x) { setErr(x); } finally { setParsing(false); }
  };
  const run = async () => {
    if (!result || !file) return;
    setErr(null); setProgress([0, result.rows.length]);
    try {
      const s = await repo.importEvaluations(result.rows, { source: /\.xlsx$/i.test(file.name) ? 'xlsx' : 'csv', file_name: file.name, publish_new_periods: publish }, (d, t) => setProgress([d, t]));
      setSummary(s); setBatch(s.batch_id); await reloadRef(); bump(); toast(`Import finished: ${s.inserted} added, ${s.duplicates} already present, ${s.rejected} rejected.`);
    } catch (x) { setErr(x); } finally { setProgress(null); }
  };
  const byReason = useMemo(() => {
    const m = new Map<string, number[]>();
    for (const r of result?.rejections ?? []) { const k = r.reason.replace(/"[^"]*"/g, '"…"'); m.set(k, [...(m.get(k) ?? []), r.row_number]); }
    return [...m.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [result]);
  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Data Import & Validation" subtitle="Bring audits in straight from Google Sheets (live form and 2022–2025 archives), or upload a CSV/Excel export. Every row is checked against the scoring rubric of its year before it is saved." />
      <SheetSourcesCard />
      <details className="rounded-lg border border-line bg-surface px-4 py-3 text-[13px]">
        <summary className="cursor-pointer font-medium">No Google connection? Upload a CSV export instead</summary>
        <p className="mt-2 text-muted">Download the tab as CSV (it uses your Google login) and choose the file below{sheetExportUrl ? <>: <a className="text-brand hover:underline" target="_blank" rel="noreferrer noopener" href={sheetExportUrl}>download the live responses tab as CSV</a></> : <> (open the live responses sheet and use File → Download → CSV)</>}. For an archive year, open the archive sheet, pick the tab and use File → Download → CSV.</p>
      </details>
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Card title="1. Choose file">
          <div className="flex flex-col gap-3 text-[13px]">
            <input aria-label="Audit export file" type="file" accept=".csv,.xlsx" onChange={(e) => { const f = e.target.files?.[0] ?? null; setFile(f); if (f) parse(f); }} />
            <Field label="Timezone of the form timestamps" htmlFor="imp-tz" hint="Google Forms records timestamps in the sheet’s timezone."><select id="imp-tz" className={inputCls} value={tz} onChange={(e) => { setTz(e.target.value); if (file) parse(file); }}>
              <option value="+05:30">IST (UTC+05:30)</option><option value="+00:00">UTC</option><option value="-05:00">US Eastern (UTC−05:00)</option><option value="-08:00">US Pacific (UTC−08:00)</option></select></Field>
            <label htmlFor="imp-pub" className="flex items-center gap-2"><input id="imp-pub" type="checkbox" checked={publish} onChange={(e) => setPublish(e.target.checked)} />Publish new weeks immediately (use for historical backfill)</label>
            <details className="text-[12.5px] text-muted"><summary className="cursor-pointer">Expected columns</summary>
              <p className="mt-1">{Object.values(DEFAULT_COLUMN_MAP).join(' · ')} · plus every parameter column of the form (e.g. “[Query resolution (ER) [30]]”) and the Feedback / FCR columns per task type.</p></details>
            {parsing && <Loading label="Reading and validating…" />}
          </div>
        </Card>
        <Card title="2. Validation report">
          {!result ? <p className="text-[13px] text-muted">Choose a file to see how many rows are valid.</p> : result.missingColumns.length ? (
            <ErrorBox error={new Error(`Required columns not found: ${result.missingColumns.join(', ')}`)} />
          ) : (
            <div className="flex flex-col gap-3 text-[13px]">
              <div className="grid grid-cols-3 gap-2 text-center">
                <div className="rounded bg-good-soft p-2"><div className="text-[20px] font-semibold text-good tnum">{result.rows.length}</div><div className="text-[12px]">valid rows</div></div>
                <div className="rounded bg-sunken p-2"><div className="text-[20px] font-semibold tnum">{result.duplicates.length}</div><div className="text-[12px]">duplicates in file</div></div>
                <div className="rounded bg-bad-soft p-2"><div className="text-[20px] font-semibold text-bad tnum">{result.rejections.length}</div><div className="text-[12px]">rejected</div></div>
              </div>
              {byReason.length > 0 && <div><div className="eyebrow mb-1">Rejection reasons</div><ul className="flex flex-col gap-1">{byReason.map(([r, rows]) => <li key={r}><span className="font-medium tnum">{rows.length}×</span> {r} <span className="text-faint">(rows {rows.slice(0, 8).join(', ')}{rows.length > 8 ? '…' : ''})</span></li>)}</ul></div>}
              <p className="text-muted">Rows already in the portal (same DS Task Link + CAM + QA Week) are skipped, so re-importing the full sheet is safe.</p>
              <ErrorBox error={err} />
              <Button disabled={!result.rows.length || !!progress} loading={!!progress} onClick={run}>Import {result.rows.length} valid row(s)</Button>
              {progress && <p className="text-muted tnum">Imported {progress[0]} of {progress[1]}…</p>}
              {summary && <p className="rounded bg-good-soft px-3 py-2 text-good">Saved: {summary.inserted} new · {summary.duplicates} already present · {summary.rejected} rejected by the server.</p>}
            </div>
          )}
          {!result && <ErrorBox error={err} />}
        </Card>
      </div>
      <Card title="Import history" pad={false}>
        {batches.loading ? <Loading /> : (batches.data ?? []).length === 0 ? <div className="p-4"><EmptyState title="No imports yet" /></div> : (
          <Table>
            <thead><tr><th className={th}>When</th><th className={th}>Source</th><th className={th}>File</th><th className={th + ' text-right'}>Rows</th><th className={th + ' text-right'}>Added</th><th className={th + ' text-right'}>Duplicates</th><th className={th + ' text-right'}>Rejected</th><th className={th}></th></tr></thead>
            <tbody>{batches.data!.map((b) => (
              <tr key={b.id}><td className={td + ' whitespace-nowrap'}>{fmtDateTime(b.created_at)}</td><td className={td}>{b.source}</td><td className={td}>{b.file_name ?? '—'}</td>
                <td className={td + ' text-right tnum'}>{b.total_rows}</td><td className={td + ' text-right tnum'}>{b.inserted}</td><td className={td + ' text-right tnum'}>{b.duplicates}</td><td className={td + ' text-right tnum'}>{b.rejected}</td>
                <td className={td}>{b.rejected > 0 && <Button size="sm" variant="ghost" onClick={() => setBatch(b.id)}>View rejections</Button>}</td></tr>
            ))}</tbody>
          </Table>
        )}
      </Card>
      {batch && (rejections.data?.length ?? 0) > 0 && (
        <Card title="Server-side rejections" pad={false}>
          <Table><thead><tr><th className={th}>Row</th><th className={th}>Reason</th></tr></thead><tbody>{rejections.data!.slice(0, 200).map((r, i) => <tr key={i}><td className={td + ' tnum'}>{r.row_number}</td><td className={td}>{r.reason}</td></tr>)}</tbody></Table>
        </Card>
      )}
    </div>
  );
}

// =================================================================== Audit logs
export function AuditLogPage() {
  const [table, setTable] = useState(''); const [action, setAction] = useState(''); const [page, setPage] = useState(1);
  const logs = useAsync(() => repo.listAuditLogs({ limit: 50, offset: (page - 1) * 50, table: table || undefined, action: action || undefined }), [table, action, page]);
  const [open, setOpen] = useState<number | null>(null);
  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Audit Logs" subtitle="Every score change, appeal status change, configuration change and import, with previous and new values." />
      <div className="flex flex-wrap gap-3">
        <select aria-label="Area" className={inputBase + ' w-auto'} value={table} onChange={(e) => { setTable(e.target.value); setPage(1); }}>
          <option value="">All areas</option>{['evaluations', 'appeals', 'employees', 'teams', 'evaluation_parameters', 'settings', 'reporting_periods', 'import_batches', 'appeal_resubmission_grants'].map((t) => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}</select>
        <select aria-label="Action" className={inputBase + ' w-auto'} value={action} onChange={(e) => { setAction(e.target.value); setPage(1); }}>
          <option value="">All actions</option>{['score_adjusted', 'appeal_status', 'insert', 'update', 'delete', 'import', 'invite'].map((t) => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}</select>
      </div>
      <Card pad={false}>
        {logs.loading ? <Loading /> : (
          <Table>
            <thead><tr><th className={th}>When</th><th className={th}>Who</th><th className={th}>Action</th><th className={th}>Area</th><th className={th}>Record</th><th className={th}>Reason</th><th className={th}></th></tr></thead>
            <tbody>{(logs.data ?? []).map((l) => (<Fragment key={l.id}>
              <tr>
                <td className={td + ' whitespace-nowrap text-muted'}>{fmtDateTime(l.created_at)}</td><td className={td}>{l.actor_name ?? 'System'}</td>
                <td className={td}><Pill tone={l.action === 'score_adjusted' ? 'warn' : 'neutral'}>{l.action.replace(/_/g, ' ')}</Pill></td>
                <td className={td}>{l.table_name?.replace(/_/g, ' ')}</td><td className={td + ' font-mono text-[11.5px]'}>{l.record_id?.slice(0, 12)}</td>
                <td className={td + ' max-w-[280px]'}>{l.reason ?? '—'}</td>
                <td className={td}><Button size="sm" variant="ghost" onClick={() => setOpen(open === l.id ? null : l.id)}>{open === l.id ? 'Hide' : 'Details'}</Button></td>
              </tr>
              {open === l.id && <tr><td colSpan={7} className="border-b border-line bg-sunken/50 px-3 py-2">
                <div className="grid gap-3 md:grid-cols-2 text-[11.5px]"><div><div className="eyebrow">Previous</div><pre className="overflow-x-auto whitespace-pre-wrap font-mono">{JSON.stringify(l.previous, null, 2)}</pre></div>
                  <div><div className="eyebrow">New</div><pre className="overflow-x-auto whitespace-pre-wrap font-mono">{JSON.stringify(l.new_value, null, 2)}</pre></div></div></td></tr>}
            </Fragment>))}</tbody>
          </Table>
        )}
        <div className="flex justify-end gap-2 px-3 py-2"><Button size="sm" variant="secondary" disabled={page === 1} onClick={() => setPage(page - 1)}>Newer</Button><Button size="sm" variant="secondary" disabled={(logs.data?.length ?? 0) < 50} onClick={() => setPage(page + 1)}>Older</Button></div>
      </Card>
    </div>
  );
}

