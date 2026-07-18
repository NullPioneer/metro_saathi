// Replace these two values with the URL and anon key from Supabase → Project settings → API.
const supabaseUrl = 'https://xxxx.supabase.co';
const supabaseKey = 'your-anon-key';

export const isSupabaseConfigured = !supabaseUrl.includes('xxxx') && supabaseKey !== 'your-anon-key';
export const supabase = isSupabaseConfigured && window.supabase?.createClient
  ? window.supabase.createClient(supabaseUrl, supabaseKey)
  : null;
