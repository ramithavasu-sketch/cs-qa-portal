import { Component, StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App';
import { isGoogle } from './data';
import { applyGoogleDeepLink } from './data/googleRepo';

/** Shows what went wrong instead of a blank page. */
class CrashScreen extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error) { console.error('Portal crashed', error); }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div style={{ maxWidth: 560, margin: '64px auto', padding: 16, fontFamily: 'system-ui, sans-serif', lineHeight: 1.5 }}>
        <h1 style={{ fontSize: 20, fontWeight: 700 }}>Something went wrong loading the portal</h1>
        <p style={{ marginTop: 8 }}>Try reloading the page. If this keeps happening, send this message to whoever supports the portal:</p>
        <pre style={{ marginTop: 12, padding: 12, background: 'rgba(127,127,127,.12)', borderRadius: 6, whiteSpace: 'pre-wrap', fontSize: 13 }}>{this.state.error.message}</pre>
        <button style={{ marginTop: 12, padding: '8px 14px', borderRadius: 6, border: '1px solid currentColor', background: 'transparent', cursor: 'pointer' }} onClick={() => location.reload()}>Reload</button>
      </div>
    );
  }
}

const start = () => createRoot(document.getElementById('root')!).render(<StrictMode><CrashScreen><App /></CrashScreen></StrictMode>);
if (isGoogle) applyGoogleDeepLink().then(start, start); else start();
