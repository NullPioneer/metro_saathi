const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const root = __dirname;
const envPath = path.join(root, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, '');
  }
}

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8' };
const json = (response, status, body) => {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
};

async function compose(request, response) {
  if (!process.env.OPENAI_API_KEY) return json(response, 500, { error: 'OPENAI_API_KEY is missing from .env' });
  let raw = '';
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > 20_000) return json(response, 413, { error: 'Request too large' });
  }
  try {
    const rhythm = JSON.parse(raw);
    const prompt = `Compose a calm, dark instrumental ambient recipe for a Kochi Metro ride using this sensor summary: ${JSON.stringify(rhythm)}. Return ONLY JSON with label (2-5 words), rootHz (55-110), intervals (2-3 numbers, 0.5-2), and waveforms (same count; sine, triangle, or sawtooth). Avoid harsh sounds.`;
    const apiResponse = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5-mini', input: prompt }),
    });
    const result = await apiResponse.json();
    if (!apiResponse.ok) return json(response, apiResponse.status, { error: result.error?.message || 'OpenAI request failed' });
    const text = result.output_text || result.output?.flatMap((item) => item.content || []).find((item) => item.type === 'output_text')?.text;
    const recipe = JSON.parse(text.replace(/^```json\s*|\s*```$/g, ''));
    recipe.rootHz = Math.min(110, Math.max(55, Number(recipe.rootHz) || 73.42));
    recipe.intervals = (recipe.intervals || [1, 1.5]).slice(0, 3).map((value) => Math.min(2, Math.max(.5, Number(value) || 1)));
    recipe.waveforms = recipe.intervals.map((_, index) => ['sine', 'triangle', 'sawtooth'].includes(recipe.waveforms?.[index]) ? recipe.waveforms[index] : 'sine');
    json(response, 200, recipe);
  } catch (error) {
    json(response, 500, { error: error.message || 'Composition failed' });
  }
}

async function speech(request, response) {
  if (!process.env.OPENAI_API_KEY) return json(response, 500, { error: 'OPENAI_API_KEY is missing from .env' });
  let raw = '';
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > 20_000) return json(response, 413, { error: 'Request too large' });
  }
  try {
    const { text, language } = JSON.parse(raw);
    if (typeof text !== 'string' || !text.trim()) return json(response, 400, { error: 'Speech text is required' });
    const languageName = { ml: 'Malayalam', hi: 'Hindi', en: 'Indian English' }[language] || 'Indian English';
    const apiResponse = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini-tts', voice: 'marin', input: text, response_format: 'mp3',
        instructions: `Speak naturally and warmly in native ${languageName}, like a calm professional Kochi Metro announcer. Use authentic pronunciation, a measured pace, and no robotic cadence.`,
      }),
    });
    if (!apiResponse.ok) {
      const problem = await apiResponse.json().catch(() => ({}));
      return json(response, apiResponse.status, { error: problem.error?.message || 'Speech generation failed' });
    }
    const audio = Buffer.from(await apiResponse.arrayBuffer());
    response.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': audio.length, 'Cache-Control': 'private, max-age=300' });
    response.end(audio);
  } catch (error) {
    json(response, 500, { error: error.message || 'Speech generation failed' });
  }
}

const port = Number(process.env.PORT) || 8123;
http.createServer(async (request, response) => {
  if (request.method === 'POST' && request.url === '/api/compose-rhythm') return compose(request, response);
  if (request.method === 'POST' && request.url === '/api/speech') return speech(request, response);
  const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = path.resolve(root, relative);
  if (!filePath.startsWith(`${root}${path.sep}`) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    response.writeHead(404); response.end('Not found'); return;
  }
  response.writeHead(200, { 'Content-Type': types[path.extname(filePath)] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(response);
}).listen(port, () => console.log(`Metro Saathi: http://localhost:${port}`));
