const manifest = require('./voice-model.json');

// Model files keep their repo path; runtime files live under runtime/.
function voiceFiles(model = manifest) {
  const list = Object.entries(model.files).map(([rel, sha256]) => ({
    rel, sha256, url: `https://huggingface.co/${model.repo}/resolve/${model.revision}/${rel}`,
  }));
  for (const [name, { url, sha256 }] of Object.entries(model.runtime || {})) {
    list.push({ rel: `runtime/${name}`, sha256, url });
  }
  return list;
}

module.exports = { voiceFiles };
