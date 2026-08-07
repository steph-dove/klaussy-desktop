// A minimal protobuf wire reader. The wire format is self-describing — every
// field carries its number and type — so a message can be walked for the string
// at a known field path without the .proto that defined it.
//
// Used to read Antigravity's conversation store, whose schema is not published.
// Because that schema can change under us, callers must treat a miss as "cannot
// read this" and fall back, never as "the agent said nothing".

function readVarint(buf, i) {
  let value = 0n;
  let shift = 0n;
  while (i < buf.length) {
    const byte = buf[i++];
    value |= BigInt(byte & 0x7f) << shift;
    if (!(byte & 0x80)) break;
    shift += 7n;
    if (shift > 63n) return [0n, -1]; // malformed
  }
  return [value, i];
}

// Collect every length-delimited field, keyed by its dotted path ("20.1").
// Nested messages are walked; anything that fails to parse as one is kept as a
// leaf, which is how strings are found without knowing the schema.
function scan(buf, { maxDepth = 8 } = {}) {
  const found = new Map();

  const walk = (slice, depth, path) => {
    let i = 0;
    while (i < slice.length) {
      let key;
      [key, i] = readVarint(slice, i);
      if (i === -1) return false;
      const field = Number(key >> 3n);
      const wire = Number(key & 7n);
      if (field === 0) return false;

      if (wire === 0) { [, i] = readVarint(slice, i); if (i === -1) return false; }
      else if (wire === 1) i += 8;
      else if (wire === 5) i += 4;
      else if (wire === 2) {
        let len;
        [len, i] = readVarint(slice, i);
        if (i === -1) return false;
        const n = Number(len);
        if (n < 0 || i + n > slice.length) return false;
        const sub = slice.subarray(i, i + n);
        i += n;
        const here = path ? `${path}.${field}` : String(field);
        const nested = depth < maxDepth && n > 1 && walk(sub, depth + 1, here);
        if (!nested) {
          if (!found.has(here)) found.set(here, []);
          found.get(here).push(sub);
        }
      } else return false;
    }
    return true;
  };

  walk(buf, 0, '');
  return found;
}

// The UTF-8 strings at a path, skipping anything that isn't cleanly decodable.
function stringsAt(buf, path) {
  const found = scan(buf);
  const raw = found.get(path) || [];
  const out = [];
  for (const b of raw) {
    const s = b.toString('utf8');
    // A mis-identified binary leaf decodes with replacement characters.
    if (s.includes('�')) continue;
    if (s.trim()) out.push(s);
  }
  return out;
}

module.exports = { scan, stringsAt };
