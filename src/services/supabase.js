// src/services/supabase.js
// Supabase client — AUTH ONLY.
// Data queries go through the Railway proxy via supaFetch() in api.js.

import { createClient } from '@supabase/supabase-js';

const SUPA_URL      = import.meta.env.VITE_SUPA_URL      || '';
const SUPA_ANON_KEY = import.meta.env.VITE_SUPA_ANON_KEY || '';

// Client is created even when env vars are absent so the app
// can import this module without crashing. Auth calls will fail
// gracefully when the values are empty.
export const supabase = createClient(SUPA_URL, SUPA_ANON_KEY);
