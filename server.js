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
    const voiceProfiles = {
      ml: { languageName: 'Malayalam', voice: 'marin', speed: 0.94, direction: 'Speak in authentic, fluent Kerala Malayalam. Use a warm human voice, gentle expression, natural breathing and short pauses, like a friendly Kochi Metro announcer. Pronounce Kochi place names carefully.' },
      en: { languageName: 'Indian English', voice: 'cedar', speed: 0.93, direction: 'Speak in natural Indian English. Use a warm human voice with subtle expression, natural breathing and short pauses, like a friendly professional Kochi Metro announcer.' },
      hi: { languageName: 'Hindi', voice: 'coral', speed: 0.94, direction: 'Speak in fluent, natural Hindi. Use a warm reassuring human voice, natural breathing and short pauses, like a friendly metro announcer. Pronounce place names carefully.' },
    };
    const profile = voiceProfiles[language] || voiceProfiles.en;
    const expressiveResponse = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-audio-1.5',
        modalities: ['text', 'audio'],
        audio: { voice: profile.voice, format: 'wav' },
        messages: [{
          role: 'user',
          content: `${profile.direction}\n\nSay only the announcement below. Do not add an introduction or explanation. Let punctuation create natural pauses instead of using a repetitive reading cadence.\n\n${text.trim()}`,
        }],
      }),
    });
    const result = await expressiveResponse.json().catch(() => ({}));
    if (expressiveResponse.ok) {
      const audioData = result.choices?.[0]?.message?.audio?.data;
      if (audioData) {
        const audio = Buffer.from(audioData, 'base64');
        response.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': audio.length, 'Cache-Control': 'private, max-age=300', 'X-Voice-Engine': 'gpt-audio-1.5' });
        response.end(audio);
        return;
      }
    }
    return json(response, expressiveResponse.ok ? 502 : expressiveResponse.status, {
      error: result.error?.message || 'Expressive AI voice did not return audio',
    });
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
