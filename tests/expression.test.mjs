import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Synth, renderSequence } from '../web/src/dsp/core.js';
import { encodeWav } from '../web/src/audio.js';
import { createHash } from 'node:crypto';
const json = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));
const patch = await json('../web/assets/tresure-island.json');
function process(s, n) {
  const l = new Float32Array(n),
    r = new Float32Array(n);
  s.process(l, r);
  return l;
}
test('measured breath smoothing reaches its target in 12 ms despite repeated CC values', () => {
  const s = new Synth(48000, patch);
  s.setDry(true);
  s.noteOn(60);
  s.setBreath(1);
  process(s, 192);
  assert.ok(Math.abs(s.breath - 1 / 3) < 1e-10);
  s.setBreath(1);
  process(s, 384);
  assert.equal(s.breath, 1, 'a repeated target must not restart the native linear ramp');
  s.setBreath(0);
  process(s, 576);
  assert.equal(s.breath, 0);
  process(s, 2400);
  assert.ok(
    process(s, 64).every((v) => Math.abs(v) < 1e-10),
    'post-EQ state should settle after breath closes',
  );
});
test('native 15 ms gate fade terminates the dry voice without an exponential tail', () => {
  const s = new Synth(48000, patch);
  s.setDry(true);
  s.setBreath(1);
  s.noteOn(72);
  process(s, 4800);
  s.noteOff(72);
  process(s, 720);
  assert.ok(s.gate < 1e-10);
  process(s, 2400);
  assert.ok(
    process(s, 64).every((v) => Math.abs(v) < 1e-10),
    'post-EQ state should settle after the gate closes',
  );
});
const cases = await json('./fixtures/render-regressions.json');
// Check the application's exported PCM format across JavaScript runtimes.
const hash = async (audio) =>
  createHash('sha256')
    .update(new Uint8Array(await encodeWav(audio).arrayBuffer()))
    .digest('hex');
for (const c of cases)
  test(`deterministic WAV export: ${c.id}`, async () => {
    const p = await json('../' + c.patch),
      audio = renderSequence(p, c.events, c.options);
    assert.equal(audio.left.length, c.frames);
    assert.equal(await hash(audio), c.wavSha256);
  });
