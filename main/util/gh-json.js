// Thin promise wrappers around the `gh` CLI, shared by the PR-review IPC
// modules. ghJson parses stdout as JSON; ghText returns it raw. Both attach
// stderr to the rejected error so callers can surface gh's message. An optional
// `extraEnv` (e.g. { GH_TOKEN } from ghEnvForAccount) runs the command as a
// specific account without flipping gh's global active account.
const { execFile } = require('child_process');

function runGh(args, cwd, extraEnv) {
  const env = extraEnv && Object.keys(extraEnv).length
    ? { ...process.env, ...extraEnv } : undefined;
  const opts = { cwd, maxBuffer: 50 * 1024 * 1024 };
  if (env) opts.env = env;
  return opts;
}

function ghJson(args, cwd, extraEnv) {
  return new Promise((resolve, reject) => {
    execFile('gh', args, runGh(args, cwd, extraEnv), (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        return reject(err);
      }
      try { resolve(JSON.parse(stdout)); }
      catch (e) { reject(new Error('gh returned non-JSON: ' + stdout.slice(0, 200))); }
    });
  });
}

function ghText(args, cwd, extraEnv) {
  return new Promise((resolve, reject) => {
    execFile('gh', args, runGh(args, cwd, extraEnv), (err, stdout, stderr) => {
      if (err) { err.stderr = stderr; return reject(err); }
      resolve(stdout);
    });
  });
}

module.exports = { ghJson, ghText };
