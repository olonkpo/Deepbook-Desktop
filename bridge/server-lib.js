/**
 * Bridge server — runs inside the Electron main process. Turns HTTP calls
 * from the renderer (the DeepBook Studio page) into calls to the Claude Code
 * binary that ships INSIDE this app (via the @anthropic-ai/claude-code
 * dependency). No API key anywhere; no separate install; no PATH lookup.
 */
const http = require('http');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
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
// OS — Unix ignores the extension). Electron's asar-aware require.resolve
// transparently returns the *unpacked* path here because of the
// `asarUnpack` build setting, so this works both in `npm start` (dev) and in
// the packaged app.
function resolveClaudeBinary() {
  const pkgJsonPath = require.resolve('@anthropic-ai/claude-code/package.json');
  const pkgDir = path.dirname(pkgJsonPath);
  const bin = path.join(pkgDir, 'bin', 'claude.exe');
  log.info('[bridge] resolved claude binary at', bin);
  return bin;
}

function withCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
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

function checkClaude() {
  log.info('[bridge] /health check starting');
  try {
    const bin = resolveClaudeBinary();
    const r = spawnSync(bin, ['--version'], { timeout: 5000, encoding: 'utf8' });
    if (r.error || r.status !== 0) {
      const result = { ok: false, loggedIn: false, error: r.stderr?.trim() || r.error?.message };
      log.warn('[bridge] --version failed:', JSON.stringify(result), 'spawnSync status:', r.status, 'stdout:', r.stdout?.trim());
      return result;
    }
    log.info('[bridge] --version OK:', r.stdout.trim());
    // A quick, cheap way to tell "installed" from "installed but not signed in"
    // is to check auth status; fall back gracefully if the flag doesn't exist.
    const who = spawnSync(bin, ['-p', 'ping', '--output-format', 'json', '--disallowedTools', DISALLOWED_TOOLS], { timeout: 15000, encoding: 'utf8' });
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
      withCors(res);
      log.info('[bridge] request:', req.method, req.url);
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

      if (req.method === 'GET' && req.url === '/health') {
        sendJSON(res, 200, checkClaude());
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
    server.listen(PORT, HOST, () => { log.info(`[bridge] listening on http://${HOST}:${PORT}`); resolve(server); });
  });
}

module.exports = { startBridge, resolveClaudeBinary, checkClaude };
