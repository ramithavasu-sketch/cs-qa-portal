import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ShieldCheck } from 'lucide-react';
import { useApp } from '../app/context';
import { repo, demoRepo, localRepo } from '../data';
import { DEMO_PASSWORD } from '../demo/generate';
import { Button, ErrorBox, Field, inputCls } from '../components/ui';

function Shell({ children, title, subtitle }: { children: React.ReactNode; title: string; subtitle?: string }) {
  return (
    <div className="flex min-h-full items-center justify-center px-4 py-10">
      <div className="w-full max-w-[420px]">
        <div className="mb-6 flex items-center gap-2.5">
          <ShieldCheck className="h-7 w-7 text-brand" aria-hidden />
          <div>
            <div className="text-[17px] font-bold leading-tight">CS QA Performance Portal</div>
            <div className="text-[12.5px] text-muted">Client Services · Quality Assurance</div>
          </div>
        </div>
        <div className="rounded-lg border border-line bg-surface p-6">
          <h1 className="text-[19px] font-bold">{title}</h1>
          {subtitle && <p className="mt-1 text-[13px] text-muted">{subtitle}</p>}
          <div className="mt-5">{children}</div>
        </div>
      </div>
    </div>
  );
}

function LocalSetup() {
  const nav = useNavigate();
  const { signIn } = useApp();
  const [name, setName] = useState(''); const [email, setEmail] = useState(''); const [pw, setPw] = useState(''); const [pw2, setPw2] = useState('');
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<unknown>(null);
  return (
    <Shell title="Set up local review" subtitle="Create your Super Admin login for this computer. Your audit data will be stored only in this browser.">
      <form className="flex flex-col gap-4" onSubmit={async (e) => {
        e.preventDefault(); setErr(null);
        if (pw !== pw2) return setErr(new Error('The two passwords do not match.'));
        setBusy(true);
        try { await localRepo!.setupLocalAdmin(name, email, pw); await signIn(email, pw); nav('/admin/import', { replace: true }); } catch (x) { setErr(x); } finally { setBusy(false); }
      }}>
        <Field label="Your name" htmlFor="ls-name"><input id="ls-name" className={inputCls} value={name} onChange={(e) => setName(e.target.value)} required /></Field>
        <Field label="Company email" htmlFor="ls-email"><input id="ls-email" type="email" className={inputCls} value={email} onChange={(e) => setEmail(e.target.value)} required /></Field>
        <Field label="Password (at least 10 characters)" htmlFor="ls-pw"><input id="ls-pw" type="password" autoComplete="new-password" className={inputCls} value={pw} onChange={(e) => setPw(e.target.value)} required /></Field>
        <Field label="Confirm password" htmlFor="ls-pw2"><input id="ls-pw2" type="password" autoComplete="new-password" className={inputCls} value={pw2} onChange={(e) => setPw2(e.target.value)} required /></Field>
        <ErrorBox error={err} />
        <Button type="submit" loading={busy}>Create Super Admin and continue</Button>
      </form>
    </Shell>
  );
}

export function LoginPage() {
  if (localRepo?.needsSetup()) return <LocalSetup />;
  return <LoginForm />;
}

function LoginForm() {
  const { signIn, signedOutReason } = useApp();
  const nav = useNavigate();
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const submit = async (e?: React.FormEvent, em = email, p = pw) => {
    e?.preventDefault();
    setBusy(true); setErr(null);
    try { await signIn(em, p); nav('/', { replace: true }); } catch (x) { setErr(x); } finally { setBusy(false); }
  };
  const accounts = demoRepo?.demoAccounts() ?? [];
  const group = (r: string) => accounts.filter((a) => a.role === r);
  return (
    <Shell title="Sign in" subtitle={localRepo ? 'Local review mode — Super Admin only. Data stays in this browser on this computer.' : 'Use your company email and portal password.'}>
      {signedOutReason && <p className="mb-4 rounded bg-info-soft px-3 py-2 text-[13px] text-info">{signedOutReason}</p>}
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Company email" htmlFor="login-email">
          <input id="login-email" type="email" autoComplete="username" required className={inputCls} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" />
        </Field>
        <Field label="Password" htmlFor="login-password">
          <input id="login-password" type="password" autoComplete="current-password" required className={inputCls} value={pw} onChange={(e) => setPw(e.target.value)} />
        </Field>
        <ErrorBox error={err} />
        <Button type="submit" loading={busy} className="w-full">Sign in</Button>
        <Link to="/forgot-password" className="text-center text-[13px] text-brand hover:underline">Forgot password?</Link>
      </form>
      {demoRepo && (
        <div className="mt-6 border-t border-line pt-4">
          <p className="eyebrow">Demo accounts (fictional)</p>
          <p className="mt-1 text-[12.5px] text-muted">Password for every demo account: <code className="font-mono text-ink">{DEMO_PASSWORD}</code>. Pick one to sign in as that role.</p>
          {([['super_admin', 'QA team · Super Admin'], ['admin', 'Team Leads · Admin'], ['user', 'CAMs · User']] as const).map(([r, label]) => (
            <div key={r} className="mt-3">
              <div className="text-[12px] font-semibold text-muted">{label}</div>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {group(r).slice(0, r === 'user' ? 6 : 4).map((a) => (
                  <button key={a.email} type="button" disabled={busy} onClick={() => { setEmail(a.email); setPw(DEMO_PASSWORD); submit(undefined, a.email, DEMO_PASSWORD); }}
                    className="rounded border border-line px-2 py-1 text-[12.5px] hover:border-brand hover:text-brand">
                    {a.name}{a.team ? <span className="text-faint"> · {a.team}</span> : null}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </Shell>
  );
}

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  return (
    <Shell title="Reset your password" subtitle="We’ll email you a secure link to choose a new password.">
      {sent ? (
        <div className="flex flex-col gap-4 text-[13.5px]">
          <p>If an active portal account exists for <strong>{email}</strong>, a reset link is on its way. The link expires after one hour.</p>
          {demoRepo && <p className="text-muted">Demo mode: no email is sent.</p>}
          <Link to="/login" className="text-brand hover:underline">Back to sign in</Link>
        </div>
      ) : (
        <form className="flex flex-col gap-4" onSubmit={async (e) => {
          e.preventDefault(); setBusy(true); setErr(null);
          try { await repo.requestPasswordReset(email); setSent(true); } catch (x) { setErr(x); } finally { setBusy(false); }
        }}>
          <Field label="Company email" htmlFor="forgot-email">
            <input id="forgot-email" type="email" required className={inputCls} value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <ErrorBox error={err} />
          <Button type="submit" loading={busy}>Send reset link</Button>
          <Link to="/login" className="text-center text-[13px] text-brand hover:underline">Back to sign in</Link>
        </form>
      )}
    </Shell>
  );
}

export function ResetPasswordPage() {
  const nav = useNavigate();
  const { setRecovery, me, refreshMe } = useApp();
  const firstLogin = !!me?.must_change_password;
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const strong = pw.length >= 10 && /[A-Za-z]/.test(pw) && /\d/.test(pw);
  return (
    <Shell title={firstLogin ? 'Set your own password' : 'Choose a new password'} subtitle={firstLogin
      ? 'You signed in with a temporary password from the QA team. Choose your own to continue — at least 10 characters, including a letter and a number.'
      : 'At least 10 characters, including a letter and a number.'}>
      <form className="flex flex-col gap-4" onSubmit={async (e) => {
        e.preventDefault(); setErr(null);
        if (!strong) return setErr(new Error('Use at least 10 characters with a letter and a number.'));
        if (pw !== pw2) return setErr(new Error('The two passwords do not match.'));
        setBusy(true);
        try {
          await repo.updatePassword(pw); setRecovery(false); await refreshMe(); nav('/', { replace: true });
        } catch (x) { setErr(x); } finally { setBusy(false); }
      }}>
        <Field label="New password" htmlFor="reset-pw"><input id="reset-pw" type="password" autoComplete="new-password" className={inputCls} value={pw} onChange={(e) => setPw(e.target.value)} /></Field>
        <Field label="Confirm new password" htmlFor="reset-pw2"><input id="reset-pw2" type="password" autoComplete="new-password" className={inputCls} value={pw2} onChange={(e) => setPw2(e.target.value)} /></Field>
        <ErrorBox error={err} />
        <Button type="submit" loading={busy}>Update password</Button>
      </form>
    </Shell>
  );
}
