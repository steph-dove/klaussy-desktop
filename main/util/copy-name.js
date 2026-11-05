// "notes.md" -> "notes copy.md" -> "notes copy 2.md" ... first name `exists` rejects.
// A leading dot isn't an extension separator, so ".env" -> ".env copy".
function nextCopyName(name, exists) {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let candidate = `${stem} copy${ext}`;
  for (let n = 2; exists(candidate); n++) candidate = `${stem} copy ${n}${ext}`;
  return candidate;
}

module.exports = { nextCopyName };
