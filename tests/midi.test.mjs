import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeMidi, parseMidiFile } from '../web/src/midi.js';
test('MIDI velocity-zero note-on is note-off; channel filters apply', () => {
  assert.equal(decodeMidi([0x90, 60, 0]).type, 'noteOff');
  assert.equal(decodeMidi([0x91, 60, 100], { channel: 1 }), null);
  assert.equal(decodeMidi([0x91, 60, 100], { channel: 2 }).note, 60);
});
test('14-bit pitch bend covers exact center and both endpoints', () => {
  assert.equal(decodeMidi([0xe0, 0, 64]).value, 0);
  assert.equal(decodeMidi([0xe0, 0, 0]).value, -1);
  assert.equal(decodeMidi([0xe0, 127, 127]).value, 1);
});
test('wind breath mappings, aftertouch and all-notes-off are preserved', () => {
  assert.equal(decodeMidi([0xb0, 7, 127]).value, 1);
  assert.equal(decodeMidi([0xb0, 2, 64], { breathCC: 2 }).type, 'breath');
  assert.equal(decodeMidi([0xd0, 100], { breathCC: 'aftertouch' }).value, 100 / 127);
  assert.equal(decodeMidi([0xb0, 123, 0]).type, 'panic');
});
function vlq(n) {
  const b = [n & 127];
  while ((n >>= 7)) b.unshift((n & 127) | 128);
  return b;
}
function chunk(name, bytes) {
  return [...name]
    .map((c) => c.charCodeAt(0))
    .concat(
      [
        (bytes.length >>> 24) & 255,
        (bytes.length >>> 16) & 255,
        (bytes.length >>> 8) & 255,
        bytes.length & 255,
      ],
      bytes,
    );
}
function midiBytes(tracks) {
  const b = [
    ...chunk('MThd', [0, tracks.length > 1 ? 1 : 0, 0, tracks.length, 1, 224]),
    ...tracks.flatMap((t) => chunk('MTrk', t)),
  ];
  return Uint8Array.from(b).buffer;
}
test('standard MIDI parsing merges tracks, respects tempo changes and running status', () => {
  const tempo = [
    0,
    0xff,
    0x51,
    3,
    7,
    0xa1,
    0x20,
    ...vlq(480),
    0xff,
    0x51,
    3,
    0x0f,
    0x42,
    0x40,
    ...vlq(480),
    0xff,
    0x2f,
    0,
  ];
  const notes = [
    0,
    0x90,
    60,
    100,
    ...vlq(480),
    60,
    0,
    0,
    0x90,
    64,
    100,
    ...vlq(480),
    0x80,
    64,
    0,
    0,
    0xff,
    0x2f,
    0,
  ];
  const midi = parseMidiFile(midiBytes([tempo, notes]));
  const on = midi.events.filter((e) => e.type === 'noteOn'),
    off = midi.events.filter((e) => e.type === 'noteOff');
  assert.equal(on[0].time, 0);
  assert.equal(off[0].time, 0.5);
  assert.equal(on[1].time, 0.5);
  assert.equal(off[1].time, 1.5);
  assert.equal(midi.duration, 1.5);
});
test('truncated and unsupported MIDI headers fail with a useful error', () => {
  assert.throws(() => parseMidiFile(Uint8Array.from([77, 84, 104, 100]).buffer), /截断/);
});
