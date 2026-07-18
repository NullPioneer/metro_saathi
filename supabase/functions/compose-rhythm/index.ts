const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const apiKey = Deno.env.get('OPENAI_API_KEY');
    if (!apiKey) throw new Error('OPENAI_API_KEY is not configured');
    const rhythm = await request.json();
    const prompt = `You are composing a calm, dark, instrumental ambient sound for a Kochi Metro ride.
Use this live sensor summary: ${JSON.stringify(rhythm)}.
Return ONLY valid JSON with: label (2-5 words), rootHz (number from 55 to 110), intervals (2-3 numbers from 0.5 to 2), and waveforms (same count, each one of sine, triangle, sawtooth). Avoid harsh or startling sounds.`;

    const openAIResponse = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5-mini', input: prompt }),
    });
    if (!openAIResponse.ok) throw new Error(`OpenAI returned ${openAIResponse.status}`);
    const result = await openAIResponse.json();
    const outputText = result.output_text || result.output?.flatMap((item: any) => item.content || []).find((item: any) => item.type === 'output_text')?.text;
    const recipe = JSON.parse(outputText.replace(/^```json\s*|\s*```$/g, ''));
    recipe.rootHz = Math.min(110, Math.max(55, Number(recipe.rootHz) || 73.42));
    recipe.intervals = (recipe.intervals || [1, 1.5]).slice(0, 3).map((value: unknown) => Math.min(2, Math.max(0.5, Number(value) || 1)));
    recipe.waveforms = recipe.intervals.map((_: number, index: number) => ['sine', 'triangle', 'sawtooth'].includes(recipe.waveforms?.[index]) ? recipe.waveforms[index] : 'sine');
    return Response.json(recipe, { headers: corsHeaders });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Composition failed' }, { status: 500, headers: corsHeaders });
  }
});
