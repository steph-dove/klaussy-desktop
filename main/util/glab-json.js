// Promise wrappers around the `glab` CLI, mirroring gh-json.js.

const { execFile } = require('child_process');

function runGlab(args, cwd, extraEnv) {
  const env = extraEnv && Object.keys(extraEnv).length
    ? { ...process.env, ...extraEnv } : undefined;
  const opts = { cwd, maxBuffer: 50 * 1024 * 1024 };
  if (env) opts.env = env;
  return opts;
}

function glabJson(args, cwd, extraEnv) {
  return new Promise((resolve, reject) => {
    execFile('glab', args, runGlab(args, cwd, extraEnv), (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        return reject(err);
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (e) {
        reject(new Error('glab returned non-JSON: ' + String(stdout).slice(0, 200)));
      }
    });
  });
}

function glabText(args, cwd, extraEnv) {
  return new Promise((resolve, reject) => {
    execFile('glab', args, runGlab(args, cwd, extraEnv), (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        return reject(err);
      }
      resolve(stdout);
    });
  });
}

module.exports = { glabJson, glabText };
