// Thin promise wrappers around the `gh` CLI, shared by the PR-review IPC
// modules. ghJson parses stdout as JSON; ghText returns it raw. Both attach
// stderr to the rejected error so callers can surface gh's message.
const { execFile } = require('child_process');

function ghJson(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile('gh', args, { cwd, maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        return reject(err);
      }
      try { resolve(JSON.parse(stdout)); }
      catch (e) { reject(new Error('gh returned non-JSON: ' + stdout.slice(0, 200))); }
    });
  });
}

function ghText(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile('gh', args, { cwd, maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) { err.stderr = stderr; return reject(err); }
      resolve(stdout);
    });
  });
}

module.exports = { ghJson, ghText };
