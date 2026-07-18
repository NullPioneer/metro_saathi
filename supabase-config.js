// The anon key is designed for browser use. Keep Row Level Security enabled in Supabase.
const supabaseUrl = 'https://yhhmwekqscbusddaoixu.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InloaG13ZWtxc2NidXNkZGFvaXh1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQzOTQ3NDQsImV4cCI6MjA5OTk3MDc0NH0.2phWOIjUwR_edbZx6lAS8j1qSCe2cwHbwzr2aRSuBBc';

export const isSupabaseConfigured = !supabaseUrl.includes('xxxx') && supabaseKey !== 'your-anon-key';
export const supabase = isSupabaseConfigured && window.supabase?.createClient
  ? window.supabase.createClient(supabaseUrl, supabaseKey)
  : null;
