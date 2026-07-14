// Cross-platform headless spawn for the agent CLIs.
//
// macOS/Linux: a bare `spawn(bin, args)` resolves the CLI on PATH and passes
// each arg (including a large multi-line prompt) as its own argv element — no
// shell, no quoting concerns. That path is preserved exactly.
//
// Windows is the problem the rest of this file exists for. The agent CLIs are
// installed as npm `.cmd` shims (`claude.cmd`, `gemini.cmd`, …). Node can't
// spawn a `.cmd` directly — `CreateProcess` only appends `.exe` (never consults
// PATHEXT), and Node 24 refuses `.cmd`/`.bat` without a shell — so `spawn('claude')`
// throws ENOENT. Routing through the shell fixes the launch, but a `.cmd` runs
// under cmd.exe, whose command line CANNOT carry a multi-line argument (a newline
// terminates the command). The review prompts are large and multi-line, so the
// prompt must arrive on STDIN instead; callers pass `stdinInput` and build
// `args` as short single-line flags only. A resolved native `.exe` has neither
// problem and is spawned directly with the full args array.
//
// This whole module no-ops to plain `spawn` off Windows, so it's safe to route
// every headless agent launch through it.

const { spawn } = require('child_process');
const { whichBinSync } = require('./platform');

const IS_WIN = process.platform === 'win32';

// Whether a headless prompt must be delivered on stdin rather than as a
// command-line arg for this bin: true only on Windows when the CLI resolves to a
// `.cmd`/`.bat` shim (which can't carry a multi-line arg through cmd.exe). A
// native `.exe` (e.g. antigravity's `agy`) takes the multi-line arg fine, so it
// stays arg-based. Callers pass the result as `promptOnStdin` to buildHeadlessRun.
function promptGoesOnStdin(bin) {
  if (!IS_WIN || !bin) return false;
  const resolved = whichBinSync(bin) || bin;
  return /\.(cmd|bat)$/i.test(resolved);
}

function writeStdin(proc, stdinInput) {
  if (stdinInput == null || !proc.stdin) return;
  try {
    proc.stdin.write(stdinInput);
    proc.stdin.end();
  } catch { /* child already gone / pipe closed — its own exit handling covers it */ }
}

// Spawn a headless agent process. `stdinInput` (optional) is written to the
// child's stdin then closed — required on Windows for `.cmd` shims (see header),
// harmless elsewhere. `opts.stdio` must include a writable stdin ('pipe') when
// stdinInput is used.
function spawnHeadlessAgent(bin, args, opts = {}, stdinInput = null) {
  if (!IS_WIN) {
    const proc = spawn(bin, args, opts);
    writeStdin(proc, stdinInput);
    return proc;
  }
  // Resolve the real target via where.exe (whichBinSync) so we know whether it's
  // a native .exe or a .cmd/.bat shim. Fall back to the bare name if unresolved.
  const resolved = whichBinSync(bin) || bin;
  const isShim = /\.(cmd|bat)$/i.test(resolved);
  const proc = isShim
    // .cmd/.bat: go through the shell so cmd.exe runs the shim. The npm global
    // shim path has no spaces (`%APPDATA%\npm\…`), and args are short flags (the
    // prompt is on stdin), so shell:true's unquoted join is safe for the common
    // case. NOTE: a username with a space in the profile path is a known gap.
    ? spawn(resolved, args, { ...opts, shell: true })
    // native .exe: spawn directly — a multi-line argv element is fine here.
    : spawn(resolved, args, opts);
  writeStdin(proc, stdinInput);
  return proc;
}

// Buffered one-shot variant of spawnHeadlessAgent, shaped like child_process
// execFile but with the same Windows `.cmd`/stdin handling. Resolves (never
// rejects) with { stdout, stderr, error? }. `opts`: { cwd, timeout, maxBuffer }.
function execHeadlessAgent(bin, args, opts = {}, stdinInput = null) {
  const { cwd, timeout = 0, maxBuffer = 1024 * 1024 } = opts;
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawnHeadlessAgent(bin, args, {
        cwd,
        stdio: [stdinInput != null ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      }, stdinInput);
    } catch (err) {
      resolve({ stdout: '', stderr: '', error: err.message });
      return;
    }
    let stdout = '';
    let stderr = '';
    let overflow = false;
    let timedOut = false;
    const timer = timeout ? setTimeout(() => { timedOut = true; try { proc.kill(); } catch { /* already gone */ } }, timeout) : null;
    proc.stdout.on('data', (d) => {
      stdout += d;
      if (stdout.length > maxBuffer) { overflow = true; try { proc.kill(); } catch { /* already gone */ } }
    });
    proc.stderr.on('data', (d) => { stderr += d; });
    proc.on('error', (err) => {
      if (timer) clearTimeout(timer);
      resolve({ stdout, stderr, error: err.message });
    });
    proc.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (timedOut) return resolve({ stdout, stderr, error: `timed out after ${timeout}ms` });
      if (overflow) return resolve({ stdout, stderr, error: 'maxBuffer exceeded' });
      if (code !== 0) return resolve({ stdout, stderr, error: stderr || `exited with code ${code}` });
      resolve({ stdout, stderr });
    });
  });
}

module.exports = { spawnHeadlessAgent, execHeadlessAgent, promptGoesOnStdin };
