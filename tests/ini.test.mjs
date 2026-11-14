import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The nxjs.ini embedded in the NRO is the only way the loader can ask the
// nx.js runtime for memory. The runtime ignores a value whose section header
// is malformed (a corrupted "[memory]" header silently drops heap_limit and
// the app runs on the runtime's defaults), so the file is validated here end
// to end: real section headers, no orphaned keys, and the values the loader
// depends on (the full 512 MiB heap, no wasm code headroom, exposed gc).

function parseIni(text) {
  const sections = new Map();
  let current = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const header = /^\[(.+)\]$/.exec(line);
    if (header) {
      current = header[1];
      if (!sections.has(current)) sections.set(current, new Map());
      continue;
    }
    if (!current) return { sections, orphaned: [...(sections.orphaned || []), line] };
    const split = line.indexOf('=');
    if (split <= 0) continue;
    const name = line.slice(0, split).trim();
    const value = line.slice(split + 1).trim();
    sections.get(current).set(name, value);
  }
  return { sections, orphaned: [] };
}

test('nxjs.ini keeps valid sections and requests the full runtime heap', () => {
  const text = readFileSync(new URL('../romfs/nxjs.ini', import.meta.url), 'utf8');
  const { sections, orphaned } = parseIni(text);
  // Every key/value line must belong to a real section: a corrupted header
  // (the regression that previously broke [memory]) leaves orphaned lines.
  assert.deepEqual(orphaned, [], 'no orphaned keys outside of any [section]');
  for (const name of ['v8', 'memory', 'renderer', 'threadpool']) {
    assert.ok(sections.has(name), `the [${name}] section is present`);
  }
  const memory = sections.get('memory');
  assert.equal(memory.get('heap_limit'), '512MiB', 'the loader requests the runtime heap cap up front');
  const v8 = sections.get('v8');
  assert.ok((v8.get('flags') || '').includes('--expose-gc'), 'gc is exposed for teardown passes');
  assert.equal(v8.get('wasm'), 'off', 'no wasm code headroom is reserved for RPG Maker MV');
  assert.equal(v8.get('jit'), 'auto');
  assert.equal(sections.get('renderer').get('mode'), 'auto');
  assert.equal(sections.get('threadpool').get('size'), '4');
  assert.equal(sections.get('threadpool').get('stack_size'), '1MiB');
});
