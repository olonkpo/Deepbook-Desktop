/**
 * Bridge server — runs inside the Electron main process. Turns HTTP calls
 * from the renderer (the DeepBook Studio page) into calls to the Claude Code
 * binary that ships INSIDE this app (via the @anthropic-ai/claude-code
 * dependency). No API key anywhere; no separate install; no PATH lookup.
 */
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const log = require('electron-log');

const PORT = 8787;
const HOST = '127.0.0.1';
const MAX_BODY_BYTES = 2 * 1024 * 1024;

// Tools Claude Code could otherwise use (file edits, bash, web, etc). We
// disallow all of them so every call is a pure text completion.
const DISALLOWED_TOOLS = [
  'Bash', 'Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep',
  'WebSearch', 'WebFetch', 'NotebookEdit', 'Task', 'TodoWrite'
].join(',');

// The npm package always places the real, platform-specific native binary at
// <package dir>/bin/claude.exe (filename is literally "claude.exe" on every
// OS — Unix ignores the extension).
//
// require.resolve() below always returns the *virtual* in-archive path
// (".../app.asar/...") — Electron's patched fs/require layer reads files at
// that path transparently, which is why resolving package.json "succeeds"
// with no special handling. But child_process.spawn() calls the real OS
// exec syscall directly, bypassing that layer entirely, and "app.asar" is a
// single archive file, not a real directory the OS can see into — spawning
// straight from the resolved path fails with ENOTDIR. asarUnpack (see
// package.json) does put a real, directly-executable copy on disk at the
// parallel "app.asar.unpacked" path; we rewrite the path below to point
// there explicitly. In dev (`npm start`, no asar at all) this rewrite is a
// no-op since the path never contains "app.asar" in the first place.
function resolveClaudeBinary() {
  const pkgJsonPath = require.resolve('@anthropic-ai/claude-code/package.json');
  const pkgDir = path.dirname(pkgJsonPath);
  let bin = path.join(pkgDir, 'bin', 'claude.exe');
  // require.resolve() always returns the virtual in-archive path
  // (".../app.asar/..."), which Electron's patched fs/require layer reads
  // from transparently — but child_process.spawn() calls the real OS exec
  // syscall directly, bypassing that layer entirely, and "app.asar" isn't a
  // real directory the OS can see into. asarUnpack (see package.json) does
  // put a real, directly-executable copy on disk at the parallel
  // "app.asar.unpacked" path — we just have to point at it explicitly.
  if (bin.includes(`${path.sep}app.asar${path.sep}`)) {
    bin = bin.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
  }
  log.info('[bridge] resolved claude binary at', bin);
  return bin;
}

function withCors(req, res) {
  // This server is only bound to 127.0.0.1, so it's unreachable from the
  // network — but a wildcard '*' here would let ANY website open in the
  // user's regular browser read responses from it too (a well-known class
  // of "localhost service" vulnerability), effectively letting any site
  // generate text using the user's signed-in Claude session. The app's own
  // page is loaded via file://, which sends "Origin: null" — only ever
  // allow exactly that, never reflect an arbitrary site's real origin.
  if (req.headers.origin === 'null') {
    res.setHeader('Access-Control-Allow-Origin', 'null');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function sendJSON(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = [], size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { reject(new Error('Request body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// Promise-based equivalent of spawnSync's {status, stdout, stderr, error}
// shape. Using async spawn here (instead of spawnSync) matters: spawnSync
// blocks Node's entire event loop, and since Electron's main process and all
// IPC/UI-event handling share that same thread, a blocking call here would
// freeze the WHOLE app — not just this one HTTP request — for as long as
// the subprocess takes.
function spawnCapture(bin, args, { timeoutMs } = {}) {
  return new Promise((resolve) => {
    let out = '', err = '', timedOut = false;
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = timeoutMs ? setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs) : null;
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { if (timer) clearTimeout(timer); resolve({ status: null, stdout: out, stderr: err, error: e }); });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ status: timedOut ? null : code, stdout: out, stderr: err, error: timedOut ? new Error('timed out') : null });
    });
  });
}

async function checkClaude() {
  log.info('[bridge] /health check starting');
  try {
    const bin = resolveClaudeBinary();
    const r = await spawnCapture(bin, ['--version'], { timeoutMs: 5000 });
    if (r.error || r.status !== 0) {
      const result = { ok: false, loggedIn: false, error: r.stderr?.trim() || r.error?.message };
      log.warn('[bridge] --version failed:', JSON.stringify(result), 'status:', r.status, 'stdout:', r.stdout?.trim());
      return result;
    }
    log.info('[bridge] --version OK:', r.stdout.trim());
    // A quick, cheap way to tell "installed" from "installed but not signed in"
    // is to check auth status; fall back gracefully if the flag doesn't exist.
    const who = await spawnCapture(bin, ['-p', 'ping', '--output-format', 'json', '--disallowedTools', DISALLOWED_TOOLS], { timeoutMs: 15000 });
    let loggedIn = false, authError = '';
    try {
      const parsed = JSON.parse(who.stdout || '{}');
      loggedIn = !parsed.is_error;
      if (parsed.is_error) authError = parsed.result || '';
    } catch {
      authError = who.stderr?.trim() || '';
      log.warn('[bridge] auth-check response was not JSON. stdout:', who.stdout?.trim(), 'stderr:', who.stderr?.trim(), 'status:', who.status, 'spawn error:', who.error?.message);
    }
    const result = { ok: true, version: r.stdout.trim(), loggedIn, authError };
    log.info('[bridge] /health result:', JSON.stringify(result));
    return result;
  } catch (e) {
    log.error('[bridge] /health threw:', e.message);
    return { ok: false, loggedIn: false, error: e.message };
  }
}

function runClaude(prompt, system) {
  return new Promise((resolve, reject) => {
    let bin;
    try { bin = resolveClaudeBinary(); } catch (e) { log.error('[bridge] runClaude: could not resolve binary:', e.message); reject(e); return; }

    const args = ['-p', prompt, '--output-format', 'json', '--disallowedTools', DISALLOWED_TOOLS];
    if (system) args.push('--append-system-prompt', system);

    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { log.warn('[bridge] runClaude: timed out after 120s, killing'); child.kill('SIGKILL'); reject(new Error('Claude timed out after 120s')); }, 120000);

    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); log.error('[bridge] runClaude: spawn error:', e.message); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      log.info('[bridge] runClaude: exited with code', code, 'stdout length', out.length, 'stderr length', err.length);
      if (code !== 0 && !out.trim()) { reject(new Error(err.trim() || `claude exited with code ${code}`)); return; }
      try {
        const parsed = JSON.parse(out);
        if (parsed.is_error) { reject(new Error(parsed.result || 'Claude reported an error — you may need to sign in (see Settings).')); return; }
        resolve(parsed.result || '');
      } catch {
        if (out.trim()) resolve(out.trim());
        else reject(new Error('Could not parse Claude output: ' + (err.trim() || out.trim())));
      }
    });
  });
}

function startBridge() {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      withCors(req, res);
      log.info('[bridge] request:', req.method, req.url);
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

      if (req.method === 'GET' && req.url === '/health') {
        sendJSON(res, 200, await checkClaude());
        return;
      }

      if (req.method === 'POST' && req.url === '/generate') {
        try {
          const raw = await readBody(req);
          const { prompt, system } = JSON.parse(raw || '{}');
          if (!prompt || typeof prompt !== 'string') { sendJSON(res, 400, { error: 'Missing "prompt" string' }); return; }
          log.info('[bridge] /generate: prompt length', prompt.length, 'system length', (system || '').length);
          const text = await runClaude(prompt, typeof system === 'string' ? system : '');
          log.info('[bridge] /generate: succeeded, response length', text.length);
          sendJSON(res, 200, { text });
        } catch (e) {
          log.error('[bridge] /generate failed:', e.message);
          sendJSON(res, 500, { error: e.message || String(e) });
        }
        return;
      }

      sendJSON(res, 404, { error: 'Not found' });
    });
    server.on('error', (e) => { log.error('[bridge] server failed to start:', e.message); reject(e); });
    // Node recommends always handling this: an unhandled 'clientError' from
    // a malformed request would otherwise crash the whole process.
    server.on('clientError', (err, socket) => {
      log.warn('[bridge] clientError:', err.message);
      if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    });
    server.listen(PORT, HOST, () => { log.info(`[bridge] listening on http://${HOST}:${PORT}`); resolve(server); });
  });
}

module.exports = { startBridge, resolveClaudeBinary, checkClaude };
