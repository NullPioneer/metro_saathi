export const DEMO_MODE = true;
const SEEDED_KEY = 'metro-saathi-seeded-v1';

const samples = [
  ['Aluva', 1], ['Edapally', 3], ['Palarivattom', 2],
  ['Kaloor', 2], ['Town Hall', 1], ['Vyttila', 3],
].map(([station, level], index) => ({
  station, level, created_at: new Date(Date.now() - (index + 1) * 60_000).toISOString(),
}));

export async function seedCrowdDemo(useRemote = false) {
  if (!DEMO_MODE || sessionStorage.getItem(SEEDED_KEY)) return [];
  sessionStorage.setItem(SEEDED_KEY, 'true');
  if (!useRemote) return samples;
  const { supabase } = await import('./supabase-config.js');
  const { error } = await supabase.from('crowd_reports').insert(samples.map(({ station, level }) => ({ station, level })));
  if (error) console.warn('Demo crowd seed failed:', error.message);
  return [];
}
