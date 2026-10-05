import type { Repo } from './repo';
import { DemoRepo } from './demoRepo';
import { SupabaseRepo } from './supabaseRepo';

// VITE_DATA_MODE=demo  -> fictional in-browser data (public demo)
// VITE_DATA_MODE=supabase (default when URL + anon key are set) -> production backend
const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
const mode = (import.meta.env.VITE_DATA_MODE as string | undefined) ?? (url && anon ? 'supabase' : 'demo');

// VITE_DATA_MODE=local -> "local review mode": your real data, only in this browser on this computer
export const repo: Repo = mode === 'supabase' && url && anon ? new SupabaseRepo(url, anon) : new DemoRepo(mode === 'local' ? 'local' : 'demo');
export const isDemo = repo.mode === 'demo';
export const isLocal = repo.mode === 'local';
export const demoRepo = isDemo ? (repo as DemoRepo) : null;
export const localRepo = isLocal ? (repo as DemoRepo) : null;
