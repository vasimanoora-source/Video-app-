// AI Video Generator v2 - batch clips + auto join (Node 18+, ffmpeg needed for joining, no npm packages)
// Run:  GEMINI_API_KEY=your_key node server.js   then open http://localhost:3000
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.VEO_MODEL || 'veo-3.1-generate-preview';
const PORT = process.env.PORT || 3000;
const PARALLEL = parseInt(process.env.PARALLEL || '2');
const BASE = 'https://generativelanguage.googleapis.com/v1beta';
const OUT = path.join(__dirname, 'output');
fs.mkdirSync(OUT, { recursive: true });
if (!KEY) { console.error('GEMINI_API_KEY set pannunga.'); process.exit(1); }

const jobs = new Map();
const wait = ms => new Promise(r => setTimeout(r, ms));
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
const readBody = req => new Promise(r => { let b = ''; req.on('data', d => b += d); req.on('end', () => { try { r(JSON.parse(b || '{}')); } catch { r({}); } }); });
const clipFile = i => `clip${String(i + 1).padStart(2, '0')}.mp4`;

async function api(url, opts = {}) {
  const r = await fetch(url, { ...opts, headers: { 'x-goog-api-key': KEY, 'Content-Type': 'application/json' } });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error?.message || 'API error ' + r.status);
  return d;
}

async function runClip(job, i) {
  const c = job.clips[i];
  try {
    c.status = 'running'; c.error = '';
    const d = await api(`${BASE}/models/${MODEL}:predictLongRunning`, {
      method: 'POST',
      body: JSON.stringify({ instances: [{ prompt: c.prompt }], parameters: { aspectRatio: job.aspect } })
    });
    c.op = d.name;
    for (let n = 0; n < 90; n++) {           // up to ~15 min
      await wait(10000);
      const s = await api(`${BASE}/${c.op}`);
      if (!s.done) continue;
      if (s.error) throw new Error(s.error.message || 'Generation failed');
      const uri = s.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri;
      if (!uri) throw new Error('Video varala (safety filter-aa irukalam). Prompt-a maathi retry pannunga.');
      const v = await fetch(uri, { headers: { 'x-goog-api-key': KEY }, redirect: 'follow' });
      if (!v.ok) throw new Error('Video download aagala');
      fs.writeFileSync(path.join(job.dir, clipFile(i)), Buffer.from(await v.arrayBuffer()));
      c.status = 'done';
      return;
    }
    throw new Error('Romba neram aachu (timeout)');
  } catch (e) { c.status = 'error'; c.error = e.message; }
}

function pump(job) {
  const running = job.clips.filter(c => c.status === 'running').length;
  let free = PARALLEL - running;
  job.clips.forEach((c, i) => {
    if (free > 0 && c.status === 'queued') { free--; c.status = 'running'; runClip(job, i).then(() => pump(job)); }
  });
}

function join(job) {
  return new Promise((resolve, reject) => {
    const files = job.clips.map((c, i) => c.status === 'done' ? clipFile(i) : null).filter(Boolean);
    if (!files.length) return reject(new Error('Done clips illa'));
    fs.writeFileSync(path.join(job.dir, 'list.txt'), files.map(f => `file '${f}'`).join('\n'));
    execFile('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', 'list.txt', '-c:v', 'libx264', '-preset', 'fast', '-crf', '18',
      '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', 'final.mp4'],
      { cwd: job.dir }, (err, so, se) => err ? reject(new Error(err.code === 'ENOENT' ? 'ffmpeg install pannunga (ffmpeg.org)' : 'Join aagala: ' + String(se).slice(-300))) : resolve());
  });
}

function sendFile(req, res, file) {
  if (!fs.existsSync(file)) { res.writeHead(404); return res.end(); }
  const size = fs.statSync(file).size, range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    const s = m[1] ? parseInt(m[1]) : 0, e = m[2] ? parseInt(m[2]) : size - 1;
    res.writeHead(206, { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${s}-${e}/${size}`, 'Content-Length': e - s + 1 });
    return fs.createReadStream(file, { start: s, end: e }).pipe(res);
  }
  res.writeHead(200, { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': size });
  fs.createReadStream(file).pipe(res);
}

const PASS = process.env.APP_PASSWORD;
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (PASS) { // password protect (your API key pays for every video)
    const a = (req.headers.authorization || '').replace('Basic ', '');
    const given = Buffer.from(a, 'base64').toString().split(':').slice(1).join(':');
    if (given !== PASS) { res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Video App"' }); return res.end('Password venum'); }
  }
  try {
    if (req.method === 'POST' && url.pathname === '/api/batch') {
      const { prompts, aspectRatio } = await readBody(req);
      const list = (prompts || []).map(p => String(p).trim()).filter(Boolean);
      if (!list.length) return json(res, 400, { error: 'Prompts illa' });
      const id = crypto.randomBytes(4).toString('hex');
      const dir = path.join(OUT, id); fs.mkdirSync(dir, { recursive: true });
      const job = { id, dir, aspect: aspectRatio === '9:16' ? '9:16' : '16:9', clips: list.map(prompt => ({ prompt, status: 'queued', error: '' })) };
      jobs.set(id, job); pump(job);
      return json(res, 200, { id });
    }
    if (url.pathname === '/api/job') {
      const job = jobs.get(url.searchParams.get('id'));
      if (!job) return json(res, 404, { error: 'Job illa (server restart aachaa?)' });
      return json(res, 200, { clips: job.clips.map((c, i) => ({ status: c.status, error: c.error, file: c.status === 'done' ? `/files/${job.id}/${clipFile(i)}` : null })), final: fs.existsSync(path.join(job.dir, 'final.mp4')) ? `/files/${job.id}/final.mp4?t=${Date.now()}` : null });
    }
    if (req.method === 'POST' && url.pathname === '/api/retry') {
      const { id, i } = await readBody(req); const job = jobs.get(id);
      if (!job || !job.clips[i]) return json(res, 404, { error: 'Clip illa' });
      if (job.clips[i].status === 'error') { job.clips[i].status = 'queued'; pump(job); }
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/join') {
      const { id } = await readBody(req); const job = jobs.get(id);
      if (!job) return json(res, 404, { error: 'Job illa' });
      await join(job); return json(res, 200, { ok: true });
    }
    const f = /^\/files\/([a-f0-9]{8})\/(clip\d+\.mp4|final\.mp4)$/.exec(url.pathname);
    if (f) return sendFile(req, res, path.join(OUT, f[1], f[2]));
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(path.join(__dirname, 'index.html')));
    }
    res.writeHead(404); res.end();
  } catch (e) { json(res, 500, { error: e.message }); }
}).listen(PORT, () => console.log(`Open http://localhost:${PORT}  (model: ${MODEL}, parallel: ${PARALLEL})`));
