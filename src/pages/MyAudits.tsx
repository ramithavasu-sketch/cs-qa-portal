import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApp, useRef_ } from '../app/context';
import { useScopeData } from '../app/useScope';
import { PageHeader } from '../components/Layout';
import { PeriodPicker, usePeriodSelection } from '../components/PeriodPicker';
import { Card, EmptyState, ErrorBox, Kpi, Loading, ScoreBadge, StatusBadge, Table, td, th, Variance, inputBase } from '../components/ui';
import { EvaluationsTable } from '../components/shared';
import { fmtDate, fmtPct, isResolvedAppeal, summarize, variance } from '../lib/metrics';
import type { Evaluation } from '../lib/types';

/** Audits a QA evaluator performed: volume, scores given, and how their audits fared on appeal. */
export default function MyAuditsPage() {
  const { me } = useApp();
  const ref = useRef_();
  const [sel, setSel, periods] = usePeriodSelection(true);
  const data = useScopeData(sel, undefined, 0); // this page shows the selected period only
  const isSuper = me!.role === 'super_admin';
  const myEmail = me!.email.toLowerCase();
  const evaluators = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of data.all) if (e.evaluator_email) m.set(e.evaluator_email.toLowerCase(), e.evaluator_name ?? e.evaluator_email);
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [data.all]);
  const [who, setWho] = useState(myEmail);
  const mine = (list: Evaluation[]) => list.filter((e) => (e.evaluator_email ?? '').toLowerCase() === who || (who === myEmail && e.evaluator_id === me!.id));
  const cur = mine(data.cur);
  const prev = mine(data.prev);
  const S = summarize(cur); const P = summarize(prev);
  const ids = new Set(cur.map((e) => e.id));
  const appeals = data.appeals.filter((a) => ids.has(a.evaluation_id) && a.status !== 'draft');
  const decided = appeals.filter((a) => ['approved', 'partially_approved', 'rejected'].includes(a.status));
  const overturned = decided.filter((a) => a.status !== 'rejected');
  const whoName = who === myEmail ? 'My audits' : `Audits by ${evaluators.find(([e]) => e === who)?.[1] ?? who}`;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title={whoName} subtitle={<>Tasks audited by {who === myEmail ? 'you' : 'this evaluator'} (matched by the evaluator email on the audit form) · Showing <strong>{sel.label}</strong></>}
        actions={<>
          {isSuper && evaluators.length > 0 && (
            <select aria-label="Evaluator" className={inputBase + ' w-auto max-w-[240px]'} value={who} onChange={(e) => setWho(e.target.value)}>
              <option value={myEmail}>My audits</option>
              {evaluators.filter(([e]) => e !== myEmail).map(([e, n]) => <option key={e} value={e}>{n}</option>)}
            </select>
          )}
          <PeriodPicker sel={sel} onChange={setSel} periods={periods} />
        </>} />
      <ErrorBox error={data.error} />
      {data.loading ? <Loading /> : cur.length === 0 ? (
        <EmptyState title="No audits by this evaluator in this period."
          body={who === myEmail ? 'Audits are matched by the email address used on the audit form. If you audited tasks with a different email, ask a Super Admin to check your account email.' : 'Choose another period.'} />
      ) : (<>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          <Kpi label="Tasks audited" term="Tasks Audited" value={S.tasks} sub={`${P.tasks} previous`} />
          <Kpi label="Average score given" term="Average QA Score" value={fmtPct(S.avg)} sub={<Variance value={variance(S.avg, P.avg)} />} />
          <Kpi label="Autofails given" term="Autofails" value={S.autofails} sub={S.autofailRate === null ? '—' : `${S.autofailRate.toFixed(2)}% of tasks`} />
          <Kpi label="Appeals on these audits" term="Appeals" value={appeals.length} sub={`${appeals.filter((a) => !isResolvedAppeal(a)).length} still open`} />
          <Kpi label="Overturned on appeal" value={decided.length ? `${overturned.length}/${decided.length}` : '—'}
            sub={decided.length ? `${Math.round((100 * overturned.length) / decided.length)}% of decided appeals approved in full or part` : 'No decided appeals yet'} />
          <Kpi label="Awaiting QA decision" value={appeals.filter((a) => a.status === 'pending_qa_review').length} sub="appeals on these audits" />
        </div>

        <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
          <Card title="By task type" pad={false}>
            <Table>
              <thead><tr><th className={th}>Task type</th><th className={th + ' text-right'}>Tasks</th><th className={th + ' text-right'}>Average given</th><th className={th + ' text-right'}>Autofails</th></tr></thead>
              <tbody>{ref.taskTypes.map((t) => {
                const x = summarize(cur.filter((e) => e.task_type === t.code));
                if (!x.tasks) return null;
                return <tr key={t.code}><td className={td}>{t.name}</td><td className={td + ' text-right tnum'}>{x.tasks}</td><td className={td + ' text-right'}><ScoreBadge score={x.avg} settings={ref.settings} /></td><td className={td + ' text-right tnum'}>{x.autofails}</td></tr>;
              })}</tbody>
            </Table>
          </Card>
          <Card title="Appeals on these audits" pad={false}>
            {appeals.length === 0 ? <p className="p-4 text-[13px] text-muted">No appeals on these audits.</p> : (
              <Table>
                <thead><tr><th className={th}>Reference</th><th className={th}>CAM</th><th className={th}>Disputed</th><th className={th}>Status</th><th className={th}>Submitted</th></tr></thead>
                <tbody>{appeals.map((a) => (
                  <tr key={a.id}><td className={td}><Link to={`/appeals/${a.id}`} className="font-mono text-[12.5px] text-brand hover:underline">{a.reference}</Link></td>
                    <td className={td}>{a.cam_name}</td><td className={td}>{a.parameters_label}</td>
                    <td className={td}><StatusBadge status={a.status} overdue={a.overdue} /></td><td className={td + ' text-muted'}>{fmtDate(a.submitted_at)}</td></tr>
                ))}</tbody>
              </Table>
            )}
          </Card>
        </div>

        <Card title="Audited tasks" subtitle="Open a task to see every parameter and the feedback you gave." pad={false}>
          <EvaluationsTable evals={cur} settings={ref.settings} showCam pageSize={25} appealedIds={new Set(appeals.map((a) => a.evaluation_id))} />
        </Card>
      </>)}
    </div>
  );
}
