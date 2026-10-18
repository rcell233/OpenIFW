import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { renderSequence } from '../web/src/dsp/core.js';
import { destinationKey } from '../web/src/dsp/modulation.js';
import { encodeWav } from '../web/src/audio.js';

const read = async (path) =>
  JSON.parse(await readFile(new URL('../web/' + path, import.meta.url), 'utf8'));
const library = await read('assets/presets/index.json');

test('all six built-in presets render finite audible output with effects and expression', async () => {
  const presets = [await read('assets/tresure-island.json')];
  for (const entry of library.presets) {
    const patch = await read(entry.url.slice(1));
    assert.equal(patch.name, entry.name);
    assert.equal(Number(patch.settings.ProgramIndex), entry.program);
    presets.push(patch);
  }
  assert.equal(presets.length, 6);
  for (const patch of presets)
    for (const note of [48, 60, 72]) {
      const audio = renderSequence(
        patch,
        [
          { time: 0.02, type: 'noteOn', note, velocity: 100 / 127 },
          { time: 0.25, type: 'breath', value: 0.6 },
          { time: 0.45, type: 'noteOff', note },
        ],
        { duration: 0.8, breath: 1 },
      );
      let energy = 0;
      for (const channel of [audio.left, audio.right])
        for (const value of channel) {
          assert.ok(Number.isFinite(value), patch.name);
          assert.ok(Math.abs(value) < 1, patch.name);
          energy += value * value;
        }
      assert.ok(energy > 1e-4, patch.name);
    }
});

test('preset and editor modulation destination labels resolve consistently', () => {
  for (const [a, b] of [
    ['Filter 3 Frequency', 'FILTER 3 FREQUENCY'],
    ['OSC 4 Noise Level', 'OSC 4 NOISE LEVEL'],
    ['EG 1 Rate', 'EG 1 RATE'],
  ])
    assert.equal(destinationKey(a), destinationKey(b));
  assert.equal(destinationKey('OSC 1 PWM Phase'), 'Osc1PwmWidth');
});

test('offline WAV export contains interleaved stereo PCM with clipping protection', async () => {
  const blob = encodeWav({
    left: new Float32Array([2, -0.5]),
    right: new Float32Array([-2, 0.5]),
    sampleRate: 48000,
  });
  const bytes = await blob.arrayBuffer(),
    view = new DataView(bytes);
  assert.equal(new TextDecoder().decode(bytes.slice(0, 4)), 'RIFF');
  assert.equal(view.getUint16(22, true), 2);
  assert.equal(view.getUint32(24, true), 48000);
  assert.equal(view.getUint32(40, true), 8);
  assert.equal(view.getInt16(44, true), 32767);
  assert.equal(view.getInt16(46, true), -32767);
  assert.equal(view.getInt16(48, true), -16383);
  assert.equal(view.getInt16(50, true), 16384);
});
