import type { Repo } from './repo';
import { DemoRepo } from './demoRepo';
import { SupabaseRepo } from './supabaseRepo';
import { createGoogleRepo } from './googleRepo';

// VITE_DATA_MODE=demo     -> fictional in-browser data (public demo)
// VITE_DATA_MODE=supabase -> Supabase backend (default when URL + anon key are set)
// VITE_DATA_MODE=local    -> "local review mode": your real data, only in this browser on this computer
// VITE_DATA_MODE=google   -> Google Workspace version (Apps Script web app; see server/ and README)
const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
const mode = (import.meta.env.VITE_DATA_MODE as string | undefined) ?? (url && anon ? 'supabase' : 'demo');

export const repo: Repo = mode === 'google' ? createGoogleRepo()
  : mode === 'supabase' && url && anon ? new SupabaseRepo(url, anon)
  : new DemoRepo(mode === 'local' ? 'local' : 'demo');
export const isDemo = repo.mode === 'demo';
export const isLocal = repo.mode === 'local';
export const isGoogle = repo.mode === 'google';
export const demoRepo = isDemo ? (repo as DemoRepo) : null;
export const localRepo = isLocal ? (repo as DemoRepo) : null;
