import { AudioEngine, encodeWav } from './audio.js';
import { MidiInput, parseMidiFile } from './midi.js';
import { attackSeconds, decayHalfSeconds, nativeDecay } from './dsp/envelope.js';
import { modulationDestinations, supportsDestination } from './dsp/modulation.js';
const $ = (s) => document.querySelector(s),
  $$ = (s) => [...document.querySelectorAll(s)];
const clone = (x) => JSON.parse(JSON.stringify(x));
const esc = (x) =>
  String(x ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const at = (object, path) => path.split('.').reduce((x, k) => x?.[k], object);
const put = (object, path, value) => {
  const keys = path.split('.'),
    last = keys.pop();
  keys.reduce((x, k) => x[k], object)[last] = value;
};
const noteName = (note) =>
  ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'][note % 12] +
  (Math.floor(note / 12) - 2);
let toastTimer;
function toast(message) {
  $('#toast').textContent = message;
  $('#toast').classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('#toast').classList.remove('show'), 4600);
}
async function readJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error('载入失败：' + url);
  return r.json();
}
const [factory, baseXML] = await Promise.all([
  readJSON('/assets/tresure-island.json'),
  fetch('/assets/Tresure%20Island.ifwprog').then((r) => r.text()),
]).catch((error) => {
  toast(error.message);
  throw error;
});
const presetLibrary = await readJSON('/assets/presets/index.json');
const libraryPatches = new Map(
  await Promise.all(
    presetLibrary.presets.map(async (entry) => [entry.id, await readJSON(entry.url)]),
  ),
);
for (const entry of presetLibrary.presets) {
  const option = document.createElement('option');
  option.value = entry.id;
  option.textContent = entry.name;
  $('#preset-select').append(option);
}
let patch = clone(factory),
  tab = 'osc',
  egIndex = 1,
  dry = false,
  dirty = false,
  solo = null,
  soloBackup = null,
  preset = 'factory',
  baseNote = 48;
let midiFile = null,
  midiDevices = [];
const heldPointers = new Map(),
  heldKeys = new Map(),
  playTimers = [];
const audio = new AudioEngine(patch);
const midi = new MidiInput(handleMidi, (devices) => {
  midiDevices = devices;
  $('#midi-connect').innerHTML =
    `<span class="midi-icon">▥</span> ${devices.length ? 'MIDI · ' + devices.length : 'MIDI 已连接'}`;
  if (tab === 'midi') renderPanel();
});
const modules = [
  ['osc', 'OSC', 'Oscillators', 'SOUND GENERATORS', '01—04'],
  ['flt', 'FLT', 'Filters', 'SIGNAL SHAPING', '01—03'],
  ['amp', 'AMP', 'Amplifiers', 'DUAL SIGNAL PATH', '01—02'],
  ['eg', 'EG / LFO', 'Envelopes & LFOs', 'TIME & MOTION', '04 / 02'],
  ['mod', 'MOD', 'Modulation', 'MATRIX ROUTING', '01—08'],
  ['fx', 'FX', 'Effects', 'SPACE & COLOR', '07 UNITS'],
  ['master', 'MASTER', 'Master', 'FINAL OUTPUT', ''],
  ['midi', 'MIDI', 'MIDI & performance', 'EXPRESSION INPUT', ''],
];
const modulationSources = [
  'None',
  'BREATH',
  'VELOCITY',
  'NOTE',
  'PITCH BEND',
  'VIBRATO',
  'GLIDE',
  ...Array.from({ length: 4 }, (_, i) => 'EG ' + (i + 1)),
  ...Array.from({ length: 2 }, (_, i) => 'LFO ' + (i + 1) + ' (+-)'),
  ...Array.from({ length: 4 }, (_, i) =>
    ['SAW', 'TRI', 'PWM', 'NOISE'].map((w) => 'OSC ' + (i + 1) + ' ' + w + ' (+-)'),
  ).flat(),
];
const colors = { teal: '#34b4af', red: '#e66d64', blue: '#6c9fc2', yellow: '#d0bd61' };

function updateProgramUI() {
  $('#program-number').textContent = String(patch.settings?.ProgramIndex ?? 4).padStart(3, '0');
  $('#dirty-indicator').textContent = dirty ? 'EDITED' : '';
  $('#dry-toggle').checked = dry;
}
function changePatch(path, newValue) {
  put(patch, path, newValue);
  dirty = true;
  audio.setPatch(patch);
  updateProgramUI();
  if (tab === 'eg') updateEnvelopePreviews();
}
function knob(key, label, min = 0, max = 10, step = 0.1, color = 'red', unit = '', extra = {}) {
  const path = extra.path || 'parameters.' + key,
    value = Number(at(patch, path) ?? extra.fallback ?? 0),
    ratio = clamp((value - min) / (max - min), 0.001, 1),
    digits = step >= 1 ? 0 : step >= 0.1 ? 1 : step >= 0.01 ? 2 : 3;
  return `<div class="knob" style="--accent:${colors[color] || color}"><div class="knob-label">${extra.select || esc(label) + (unit ? `<small class="label-unit">${esc(unit)}</small>` : '')}</div><div class="dial" style="--ratio:${ratio}" data-path="${esc(path)}" data-min="${min}" data-max="${max}" data-step="${step}" data-digits="${digits}" role="slider" tabindex="0" aria-label="${esc(key + ' ' + label)}" aria-valuemin="${min}" aria-valuemax="${max}" aria-valuenow="${value}"><input type="number" aria-label="${esc(key + ' value')}" min="${min}" max="${max}" step="${step}" value="${value.toFixed(digits)}"></div><div class="knob-scale"><span>${min}</span><span>${max}</span></div></div>`;
}
function select(path, options, label = '', className = '') {
  const current = String(at(patch, path) ?? '');
  const items = [...new Set([...options, current].filter(Boolean))];
  return `<select class="${className}" data-select-path="${esc(path)}" aria-label="${esc(label || path)}">${items.map((x) => `<option value="${esc(x)}" ${String(x) === current ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select>`;
}
function check(path, label, inverse = false) {
  const v = at(patch, path),
    checked = inverse ? v === 'Off' : v === 'On' || v === true || v === '1';
  return `<label class="check"><input type="checkbox" data-check-path="${esc(path)}" aria-label="${esc(path.replace(/^parameters\./, '') + ' ' + label)}" ${inverse ? 'data-inverse="true"' : ''} ${checked ? 'checked' : ''}>${esc(label)}</label>`;
}
function card(title, body, { index = '', controls = '', className = '' } = {}) {
  return `<section class="card ${className}"><div class="card-header"><div class="card-title">${index ? `<span class="card-index">${esc(index)}</span>` : ''}${esc(title)}</div><div class="card-switches">${controls}</div></div>${body}</section>`;
}

function oscPanel() {
  const oscillators = [1, 2, 3, 4]
    .map((i) => {
      const k = 'Osc' + i,
        last = i === 4;
      const controls =
        check('parameters.' + k + 'Sync', 'SYNC') +
        check('parameters.' + k + 'Output1', 'OUT 1') +
        check('parameters.' + k + 'Output2', 'OUT 2') +
        `<button class="solo-button ${solo === i ? 'active' : ''}" data-solo="${i}" aria-label="Solo OSC ${i}" aria-pressed="${solo === i}">S</button>`;
      const knobs =
        knob(k + 'Semi', 'SEMITONE', -36, 36, 1, 'teal', 'st') +
        knob(k + 'Tune', 'FINE', -50, 50, 0.1, 'teal', 'cents') +
        knob(k + 'SawLevel', 'SAW') +
        knob(k + 'TriLevel', 'WAVE', 0, 10, 0.1, 'red', '', {
          select: select(
            'parameters.' + k + 'Waveform2',
            ['SIN', 'TRI', 'SAW', 'SQU', 'Ext In'],
            'OSC' + i + ' waveform',
          ),
        }) +
        (last
          ? knob(k + 'NoiseLevel', 'NOISE') + knob(k + 'NoiseLoFi', 'LO-FI', 0, 10, 0.1, 'yellow')
          : knob(k + 'PwmLevel', 'PWM') + knob(k + 'PwmWidth', 'WIDTH', 0, 10, 0.1, 'yellow'));
      return card('OSC ' + i, `<div class="knob-grid">${knobs}</div>`, {
        controls,
        className: 'osc-card',
      });
    })
    .join('');
  return (
    `<div class="osc-bank">${oscillators}</div><div class="osc-globals">` +
    card(
      'PITCH',
      `<div class="knob-grid">${knob('Transpose', 'TRANSPOSE', -24, 24, 1, 'teal', 'st')}${knob('PitchBendRange', 'BEND RANGE', 0, 24, 0.1, 'teal', 'st')}${knob('GlideMinimumSpeed', 'MIN GLIDE', 0, 1, 0.01, 'yellow')}</div>`,
      { className: 'small-card' },
    ) +
    card(
      'PORTAMENTO',
      `<div class="knob-grid">${knob('GlideSpeed', 'RATE', 0, 10, 0.1, 'blue')}<div class="setting"><span>GLIDE MODE</span>${select('parameters.GlideMode', ['Time', 'Rate'], 'Glide mode')}</div><div class="setting"><span>CONTROL</span>${check('parameters.GlideMidiEnabled', 'MIDI')}</div></div>`,
      { className: 'small-card' },
    ) +
    `<div class="signal-flow"><span class="eyebrow">SIGNAL FLOW</span><span>OSC 1–4</span><i>→</i><span>${esc(patch.parameters.FilterConnection || 'Parallel 2').toUpperCase()}</span><i>→</i><span>AMP / FX</span></div></div>`
  );
}
function filterPanel() {
  const filters = [1, 2]
    .map((i) => {
      const k = 'Filter' + i;
      return card(
        'FILTER ' + i,
        `<div class="knob-grid">${knob(k + 'Frequency', 'CUTOFF', 0, 10, 0.1, 'blue')}${knob(k + 'Resonance', 'RESONANCE', 0, 10, 0.1, 'blue')}${knob(k + 'Breath', 'BREATH', -10, 10, 0.1, 'yellow')}${knob(k + 'KeyTrack', 'KEY TRACK', -10, 10, 0.1, 'yellow')}</div><div class="inline-select card-footer">SOURCE ${select('parameters.' + k + 'BreathSubMod', ['BREATH', 'BRxEG1', 'BRxEG2', 'BRxEG3', 'BRxEG4'], 'Filter ' + i + ' breath source')}</div>`,
        {
          controls: select(
            'parameters.' + k + 'Type',
            ['LPF24', 'LPF12', 'HPF12', 'BPF12'],
            'Filter ' + i + ' type',
          ),
          className: 'filter-card',
        },
      );
    })
    .join('');
  return (
    `<div class="parameter-heading"><label class="inline-select">ROUTING ${select('parameters.FilterConnection', ['Serial', 'Parallel 1', 'Parallel 2'], 'Filter routing')}</label></div><div class="filter-bank">${filters}` +
    card(
      'FILTER 3 · ALL-PASS',
      `<div class="knob-grid">${knob('Filter3Stage', 'STAGES', 2, 24, 1, 'blue')}${knob('Filter3Frequency', 'FREQUENCY', 0, 10, 0.1, 'blue')}${knob('Filter3Resonance', 'RESONANCE', -10, 10, 0.1, 'blue')}${knob('Filter3Mix', 'MIX', -10, 10, 0.1, 'yellow')}</div>`,
      { controls: check('parameters.Filter3Enabled', 'ON'), className: 'filter-card' },
    ) +
    '</div>'
  );
}
function ampPanel() {
  return `<div class="subsection-grid amp-grid">${[1, 2].map((i) => card('AMPLIFIER ' + i, `<div class="knob-grid">${knob('Amp' + i + 'Level', 'LEVEL')}${knob('Amp' + i + 'Breath', 'BREATH', 0, 10, 0.1, 'yellow')}</div><div class="inline-select fx-footer">SOURCE ${select('parameters.Amp' + i + 'BreathSubMod', ['BREATH', 'BRxEG1', 'BRxEG2', 'BRxEG3', 'BRxEG4'], 'Amp ' + i + ' breath source')}</div>`, { index: '0' + i })).join('')}</div><div class="routing-row">${(patch.parameters.FilterConnection || 'Parallel 2') === 'Parallel 2' ? '<span class="route-chip">FILTER 1 → FILTER 3 → AMP 1</span><span>+</span><span class="route-chip">FILTER 2 → AMP 2</span>' : '<span class="route-chip">' + esc(patch.parameters.FilterConnection) + ' → FILTER 3 → AMP 1</span>'}</div>`;
}
const egTime = (s) => (s < 1 ? (s * 1000).toFixed(s < 0.1 ? 1 : 0) + ' ms' : s.toFixed(2) + ' s');
function envelopePreview(index) {
  const k = 'Eg' + index,
    p = patch.parameters,
    a = attackSeconds(+p[k + 'Attack']),
    d = decayHalfSeconds(+p[k + 'Decay']) * 4.9,
    r = decayHalfSeconds(+p[k + 'Release']) * 4.9,
    s = +p[k + 'Sustain'] / 10,
    hold = 0.15,
    total = a + d + hold + r;
  const points = [];
  for (let i = 0; i <= 240; i++) {
    const t = (total * i) / 240;
    let level =
      t < a
        ? t / a
        : t < a + d
          ? s + (1 - s) * nativeDecay((t - a) / decayHalfSeconds(+p[k + 'Decay']))
          : t < a + d + hold
            ? s
            : s * nativeDecay((t - a - d - hold) / decayHalfSeconds(+p[k + 'Release']));
    points.push((16 + (i / 240) * 328).toFixed(2) + ',' + (77 - level * 60).toFixed(2));
  }
  const off = 16 + ((a + d + hold) / total) * 328;
  return `<svg class="eg-preview" viewBox="0 0 360 100" role="img" aria-label="EG${index} 包络曲线"><path class="eg-axis" d="M16 17V77H344"/><path class="eg-off" d="M${off.toFixed(2)} 12V82"/><polyline class="eg-trace" points="${points.join(' ')}"/><text x="16" y="96">0</text><text x="${Math.min(293, off + 4).toFixed(1)}" y="11">NOTE OFF</text><text x="342" y="96" text-anchor="end">${egTime(total)}</text></svg><div class="eg-times"><span>A <strong>${egTime(a)}</strong></span><span>D <strong>${egTime(d)}</strong></span><span>S <strong>${(s * 100).toFixed(0)}%</strong></span><span>R <strong>${egTime(r)}</strong></span></div>`;
}
function updateEnvelopePreviews() {
  for (let i = 1; i <= 4; i++) {
    const el = $(`[data-eg-preview="${i}"]`);
    if (el) el.innerHTML = envelopePreview(i);
  }
}
function envelopePanel() {
  const k = 'Eg' + egIndex;
  const envelope = card(
    'ENVELOPE ' + egIndex,
    `<div class="knob-grid">${['Attack', 'Decay', 'Sustain', 'Release'].map((p, j) => knob(k + p, p.toUpperCase(), 0, 10, 0.1, j === 2 ? 'yellow' : 'red')).join('')}</div><div data-eg-preview="${egIndex}">${envelopePreview(egIndex)}</div>`,
    { controls: check('parameters.' + k + 'Retrigger', 'RETRIGGER'), className: 'envelope-card' },
  );
  const lfos = [1, 2]
    .map((i) => {
      const k = 'Lfo' + i;
      return card(
        'LFO ' + i,
        `<div class="knob-grid">${knob(k + 'Speed', 'RATE', 0, 10, 0.1, 'blue')}<div class="setting"><span>WAVEFORM</span>${select('parameters.' + k + 'Waveform', ['TRI', 'SAW', 'SQU'], 'LFO ' + i + ' waveform')}${check('parameters.' + k + 'KeySync', 'NOTE SYNC')}</div><div class="setting"><span>BEAT</span>${select('parameters.' + k + 'Beat', ['4/1', '2/1', '1/1', '1/2', '1/4', '1/8', '1/16', '1/32', '1/64', '1/128'], 'LFO ' + i + ' beat')}${check('parameters.' + k + (i === 1 ? 'BPM' : 'Bpm') + 'Sync', 'BPM SYNC')}</div></div>`,
        { className: 'small-card' },
      );
    })
    .join('');
  return `<div class="envelope-layout"><div class="envelope-editor"><div class="segmented eg-selector">${[1, 2, 3, 4].map((i) => `<button data-eg="${i}" class="${egIndex === i ? 'active' : ''}" aria-pressed="${egIndex === i}">EG ${i}</button>`).join('')}</div>${envelope}</div><div class="lfo-bank">${lfos}</div></div>`;
}
function modulationPanel() {
  return (
    card(
      'MATRIX',
      `<table class="mod-table"><thead><tr><th>SLOT</th><th>SOURCE 1</th><th>× SOURCE 2</th><th>DESTINATION</th><th>DEPTH</th></tr></thead><tbody>${Array.from(
        { length: 8 },
        (_, i) => {
          const k = 'Mod' + (i + 1),
            active = patch.parameters[k + 'Source1'] !== 'None';
          return `<tr class="${active ? '' : 'inactive'}"><td>0${i + 1}</td><td>${select('parameters.' + k + 'Source1', modulationSources, 'Mod ' + (i + 1) + ' source 1')}</td><td>${select('parameters.' + k + 'Source2', modulationSources, 'Mod ' + (i + 1) + ' source 2')}</td><td>${select('parameters.' + k + 'Destination', modulationDestinations, 'Mod ' + (i + 1) + ' destination')}</td><td><input type="number" data-numeric-path="parameters.${k}Depth" min="-10" max="10" step=".1" value="${esc(patch.parameters[k + 'Depth'])}" aria-label="Mod ${i + 1} depth"></td></tr>`;
        },
      ).join('')}</tbody></table>`,
      { controls: '<span class="eyebrow">8 SLOTS</span>' },
    ) + ``
  );
}
function fxPanel() {
  const definitions = [
    [
      'PHASER',
      [
        ['Stereo', 'STEREO', 0, 10, 0.1],
        ['Speed', 'RATE', 0.02, 10, 0.01, 'Hz'],
        ['Feedback', 'FEEDBACK', -10, 10, 0.1],
        ['Lowpass', 'LOWPASS', 0, 10, 0.1],
        ['WetDry', 'WET / DRY', -10, 10, 0.1],
      ],
    ],
    [
      'CHORUS',
      [
        ['Rate', 'RATE', 0.02, 10, 0.01, 'Hz'],
        ['Depth', 'DEPTH', 0, 10, 0.1],
        ['Mix', 'MIX', 0, 10, 0.1],
      ],
    ],
    [
      'DELAY 1',
      [
        ['Time', 'TIME', 0.001, 2, 0.001, 'sec'],
        ['Depth', 'FEEDBACK', 0, 10, 0.1],
        ['WetDry', 'WET / DRY', 0, 10, 0.1],
        ['Lowpass', 'LOWPASS', 10, 20000, 1, 'Hz'],
        ['Highpass', 'HIGHPASS', 10, 20000, 1, 'Hz'],
      ],
    ],
    [
      'DELAY 2',
      [
        ['Time', 'TIME', 0.001, 2, 0.001, 'sec'],
        ['Depth', 'FEEDBACK', 0, 10, 0.1],
        ['WetDry', 'WET / DRY', 0, 10, 0.1],
        ['Lowpass', 'LOWPASS', 10, 20000, 1, 'Hz'],
        ['Highpass', 'HIGHPASS', 10, 20000, 1, 'Hz'],
      ],
    ],
    [
      'REVERB',
      [
        ['Size', 'ROOM SIZE', 0, 10, 0.1],
        ['Width', 'WIDTH', 0, 10, 0.1],
        ['HighDamp', 'DAMPING', 0, 10, 0.1],
        ['WetDry', 'WET / DRY', 0, 10, 0.1],
      ],
    ],
  ];
  const pre =
    knob('ExciterFrequency', 'EXCITER FREQ', 0, 10, 0.1, 'blue') +
    knob('ExciterMix', 'EXCITER MIX', -10, 10, 0.1) +
    knob('EnhancerDelayL', 'DELAY L', 0, 30, 0.1, 'teal', 'ms') +
    knob('EnhancerDelayR', 'DELAY R', 0, 30, 0.1, 'teal', 'ms') +
    knob('EnhancerMix', 'ENHANCER MIX', -10, 10, 0.1, 'yellow');
  return `<div class="fx-grid">${card('EXCITER / ENHANCER', `<div class="knob-grid">${pre}</div>`, { className: 'small-card' })}${definitions.map(([name, params], i) => card(name, `<div class="knob-grid">${params.map(([key, label, min, max, step, unit]) => knob(name + ' ' + key, label, min, max, step, key === 'Mix' || key === 'WetDry' ? 'yellow' : 'blue', unit || '', { path: 'fx.' + i + '.parameters.' + key })).join('')}</div>`, { controls: check('fx.' + i + '.parameters.Bypass', 'ON', true), className: 'small-card ' + (patch.fx[i].parameters.Bypass === 'On' ? 'fx-off' : '') })).join('')}</div>`;
}
function masterPanel() {
  return (
    card(
      'MASTER OUTPUT',
      `<div class="knob-grid">${knob('EqLowGain', 'EQ LOW', -18, 18, 0.1, 'blue', 'dB')}${knob('EqHighGain', 'EQ HIGH', -18, 18, 0.1, 'blue', 'dB')}${knob('MasterTune', 'TUNE', -50, 50, 0.1, 'teal', 'cents')}${knob('MasterLevel', 'VOLUME')}</div>`,
      { className: 'master-card' },
    ) +
    `<div class="subsection-grid">${card('SMOOTHING', `<div class="knob-grid">${knob('GateOpenSmoothTime', 'GATE OPEN', 0, 50, 0.1, 'teal', 'ms')}${knob('GateCloseSmoothTime', 'GATE CLOSE', 0, 100, 0.1, 'teal', 'ms')}${knob('BreathSmoothTime', 'BREATH', 0, 50, 0.1, 'yellow', 'ms')}</div>`, { className: 'small-card' })}${card('PITCH RESPONSE', `<div class="knob-grid">${knob('PitchBendSmoothTime', 'PITCH BEND', 0, 50, 0.1, 'blue', 'ms')}${knob('GlideSmoothTime', 'GLIDE', 0, 50, 0.1, 'blue', 'ms')}</div>`, { className: 'small-card' })}</div>`
  );
}
function midiPanel() {
  return (
    '<div class="midi-layout">' +
    card(
      'MIDI INPUT',
      `<div class="settings-grid"><label class="setting">INPUT<select id="midi-device"><option value="all">全部 MIDI 输入</option>${midiDevices.map((d) => `<option value="${esc(d.id)}" ${midi.selected === d.id ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select></label><label class="setting">CHANNEL<select id="midi-channel"><option value="0">OMNI / 所有通道</option>${Array.from({ length: 16 }, (_, i) => `<option value="${i + 1}" ${midi.config.channel === i + 1 ? 'selected' : ''}>${i + 1}</option>`).join('')}</select></label><label class="setting">BREATH SOURCE<select id="breath-cc">${[2, 7, 11, 'aftertouch'].map((n) => `<option value="${n}" ${String(midi.config.breathCC) === String(n) ? 'selected' : ''}>${n === 'aftertouch' ? 'Channel aftertouch' : 'CC ' + n}</option>`).join('')}</select></label><label class="setting">VIBRATO CC<input type="number" id="vibrato-cc" min="0" max="95" value="${midi.config.vibratoCC}"></label><label class="setting">GLIDE CC<input type="number" id="glide-cc" min="0" max="95" value="${midi.config.glideCC}"></label><div class="setting"><span>CONNECTION</span><button class="button quiet" id="midi-connect-panel">连接 / 刷新设备</button></div></div><ul class="midi-list">${midiDevices.length ? midiDevices.map((d) => `<li><span class="tiny-dot"></span>${esc(d.name)} <small>${esc(d.state)}</small></li>`).join('') : '<li>尚未连接输入设备。屏幕键盘和电脑键盘可以直接演奏。</li>'}</ul><p class="device-message">默认值来自导出文件：CC7 气息、CC9 振音、CC5 滑音，弯音 ±2 半音。外接风管请保持 Web 与原版的 CC 设置相同。</p>`,
      { index: 'IN' },
    ) +
    card(
      'STANDARD MIDI FILE',
      `<p class="device-message" id="midi-file-description">${midiFile ? esc(midiFile.name) + ' · ' + midiFile.events.filter((e) => e.type === 'noteOn').length + ' notes · ' + midiFile.duration.toFixed(1) + ' sec' : '支持 .mid Type 0 / 1、运行状态、速度变化、Note、CC、Aftertouch 与 14 位弯音。'}</p><div class="file-actions"><button class="button quiet" id="load-midi">↥ 载入 .mid</button><button class="button quiet" id="play-midi" ${midiFile ? '' : 'disabled'}>▶ 播放 MIDI</button><button class="button quiet" id="export-midi-audio" ${midiFile ? '' : 'disabled'}>↧ 渲染 WAV</button><button class="text-button" id="stop-midi">■ 停止</button></div><input type="file" id="midi-file" accept=".mid,.midi" hidden>`,
      { className: 'fx-footer' },
    ) +
    '</div>'
  );
}
function renderPanel() {
  const m = modules.find((m) => m[0] === tab);
  $('#panel-eyebrow').textContent = m[3];
  $('#panel-title').innerHTML = esc(m[2]) + `<span>${esc(m[4])}</span>`;
  $('#module-nav').innerHTML = modules
    .map(
      (m, i) =>
        `<button data-tab="${m[0]}" class="${tab === m[0] ? 'active' : ''}"><span class="module-number">${String(i + 1).padStart(2, '0')}</span>${m[1]}</button>`,
    )
    .join('');
  $('.main-panel').dataset.panel = tab;
  $('#panel-content').innerHTML = {
    osc: oscPanel,
    flt: filterPanel,
    amp: ampPanel,
    eg: envelopePanel,
    mod: modulationPanel,
    fx: fxPanel,
    master: masterPanel,
    midi: midiPanel,
  }[tab]();
  bindPanel();
  updateProgramUI();
}
function bindPanel() {
  $$('[data-eg]').forEach(
    (b) =>
      (b.onclick = () => {
        egIndex = Number(b.dataset.eg);
        renderPanel();
      }),
  );
  $$('[data-select-path]').forEach(
    (el) =>
      (el.onchange = () => {
        changePatch(el.dataset.selectPath, el.value);
        if (tab === 'mod' || tab === 'flt') renderPanel();
      }),
  );
  $$('[data-check-path]').forEach(
    (el) =>
      (el.onchange = () => {
        changePatch(
          el.dataset.checkPath,
          el.dataset.inverse ? (el.checked ? 'Off' : 'On') : el.checked ? 'On' : 'Off',
        );
        if (tab === 'fx') renderPanel();
      }),
  );
  $$('[data-numeric-path]').forEach(
    (el) =>
      (el.onchange = () => {
        const n = Number(el.value);
        if (Number.isFinite(n))
          changePatch(el.dataset.numericPath, clamp(n, Number(el.min), Number(el.max)));
      }),
  );
  $$('.dial').forEach((dial) => {
    const input = dial.querySelector('input'),
      min = Number(dial.dataset.min),
      max = Number(dial.dataset.max),
      step = Number(dial.dataset.step),
      digits = Number(dial.dataset.digits);
    function set(v) {
      v = Number((Math.round(clamp(v, min, max) / step) * step).toFixed(digits));
      input.value = v.toFixed(digits);
      dial.style.setProperty('--ratio', clamp((v - min) / (max - min), 0.001, 1));
      dial.setAttribute('aria-valuenow', v);
      changePatch(dial.dataset.path, v);
    }
    input.oninput = () => {
      if (input.value === '' || !Number.isFinite(input.valueAsNumber)) return;
      const v = clamp(input.valueAsNumber, min, max);
      dial.style.setProperty('--ratio', clamp((v - min) / (max - min), 0.001, 1));
      dial.setAttribute('aria-valuenow', v);
      changePatch(dial.dataset.path, v);
    };
    input.onchange = () => {
      if (Number.isFinite(Number(input.value))) set(Number(input.value));
    };
    input.onfocus = () => input.select();
    dial.onpointerdown = (e) => {
      if (e.target === input) return;
      e.preventDefault();
      const y = e.clientY,
        start = Number(input.value);
      dial.setPointerCapture(e.pointerId);
      dial.onpointermove = (event) =>
        set(start + ((y - event.clientY) * (max - min)) / (event.shiftKey ? 1600 : 240));
      dial.onpointerup = dial.onpointercancel = () => {
        dial.onpointermove = null;
      };
    };
    dial.onkeydown = (e) => {
      if (e.target === input) return;
      if (['ArrowUp', 'ArrowRight', 'ArrowDown', 'ArrowLeft', 'Home', 'End'].includes(e.key)) {
        e.preventDefault();
        set(
          e.key === 'Home'
            ? min
            : e.key === 'End'
              ? max
              : Number(input.value) + (['ArrowUp', 'ArrowRight'].includes(e.key) ? step : -step),
        );
      }
    };
  });
  $$('[data-solo]').forEach(
    (b) =>
      (b.onclick = () => {
        const index = Number(b.dataset.solo);
        if (soloBackup)
          for (let i = 1; i <= 4; i++)
            for (let j = 1; j <= 2; j++)
              patch.parameters['Osc' + i + 'Output' + j] = soloBackup[i - 1][j - 1];
        if (solo === index) {
          solo = null;
          soloBackup = null;
        } else {
          soloBackup = Array.from({ length: 4 }, (_, i) => [
            patch.parameters['Osc' + (i + 1) + 'Output1'],
            patch.parameters['Osc' + (i + 1) + 'Output2'],
          ]);
          solo = index;
          for (let i = 1; i <= 4; i++)
            if (i !== index) {
              patch.parameters['Osc' + i + 'Output1'] = 'Off';
              patch.parameters['Osc' + i + 'Output2'] = 'Off';
            }
        }
        audio.setPatch(patch);
        renderPanel();
      }),
  );
  if ($('#midi-connect-panel')) $('#midi-connect-panel').onclick = connectMidi;
  if ($('#midi-device'))
    $('#midi-device').onchange = (e) => {
      midi.selected = e.target.value;
      audio.panic();
    };
  if ($('#midi-channel'))
    $('#midi-channel').onchange = (e) => {
      midi.config.channel = Number(e.target.value);
      audio.panic();
    };
  if ($('#breath-cc'))
    $('#breath-cc').onchange = (e) => {
      midi.config.breathCC =
        e.target.value === 'aftertouch' ? 'aftertouch' : Number(e.target.value);
    };
  for (const [id, key] of [
    ['vibrato-cc', 'vibratoCC'],
    ['glide-cc', 'glideCC'],
  ])
    if ($('#' + id))
      $('#' + id).onchange = (e) => (midi.config[key] = clamp(Number(e.target.value), 0, 95));
  if ($('#load-midi')) $('#load-midi').onclick = () => $('#midi-file').click();
  if ($('#midi-file'))
    $('#midi-file').onchange = async (e) => {
      try {
        const file = e.target.files[0];
        if (!file) return;
        const parsed = parseMidiFile(await file.arrayBuffer(), midi.config);
        if (parsed.duration > 600) throw new Error('当前预览支持 10 分钟以内的 MIDI 文件');
        midiFile = { ...parsed, name: file.name };
        renderPanel();
        toast('已载入 ' + file.name);
      } catch (error) {
        toast(error.message);
      }
    };
  if ($('#play-midi'))
    $('#play-midi').onclick = async () => {
      if (!(await startAudio())) return;
      audio.panic();
      audio.send({ type: 'breath', value: Number($('#breath').value) / 127 });
      audio.node.port.postMessage({ command: 'schedule', events: midiFile.events });
      toast('正在播放 ' + midiFile.name);
    };
  if ($('#stop-midi')) $('#stop-midi').onclick = () => panic();
  if ($('#export-midi-audio'))
    $('#export-midi-audio').onclick = async () => {
      try {
        toast('正在离线渲染 MIDI…');
        const rendered = await audio.render(midiFile.events, {
          duration: midiFile.duration + 3,
          breath: Number($('#breath').value) / 127,
        });
        download(encodeWav(rendered), midiFile.name.replace(/\.midi?$/i, '') + '.wav');
        toast('MIDI 音频已导出');
      } catch (e) {
        toast(e.message);
      }
    };
}

function loadPreset(which) {
  panic();
  patch = clone(factory);
  preset = which;
  dirty = false;
  solo = null;
  soloBackup = null;
  if (libraryPatches.has(which)) {
    patch = clone(libraryPatches.get(which));
    dry = false;
  } else if (which === 'sine' || which === 'saw') {
    patch.name = which === 'sine' ? 'Init · Sine' : 'Init · Saw';
    patch.author = 'OpenIFW';
    dry = true;
    for (let i = 1; i <= 4; i++) {
      const k = 'Osc' + i;
      patch.parameters[k + 'SawLevel'] = 0;
      patch.parameters[k + 'TriLevel'] = 0;
      patch.parameters[k + 'PwmLevel'] = 0;
      patch.parameters[k + 'NoiseLevel'] = 0;
      patch.parameters[k + 'Output1'] = i === 1 ? 'On' : 'Off';
      patch.parameters[k + 'Output2'] = 'Off';
      patch.parameters[k + 'Sync'] = 'Off';
    }
    patch.parameters[which === 'sine' ? 'Osc1TriLevel' : 'Osc1SawLevel'] = 10;
    patch.parameters.Osc1Waveform2 = 'SIN';
    patch.parameters.Filter1Frequency = 10;
    patch.parameters.Filter1KeyTrack = 0;
    patch.parameters.Filter1Breath = 0;
    patch.parameters.EqLowGain = 0;
    patch.parameters.EqHighGain = 0;
    patch.parameters.ExciterMix = 0;
    patch.parameters.GlideMinimumSpeed = 0;
  } else {
    dry = which === 'dry';
  }
  audio.setPatch(patch);
  audio.setDry(dry);
  $('#patch-name').textContent = patch.name;
  $('#patch-author').textContent =
    patch.author +
    ' · ' +
    (which === 'factory' || which === 'dry' || libraryPatches.has(which) ? '原版参数' : '基础波形');
  $('#preset-select').value = which;
  renderPanel();
}
async function startAudio() {
  try {
    await audio.start();
    $('#audio-light').classList.add('ready');
    $('#audio-status').textContent = 'AUDIO RUNNING';
    $('#sample-rate').textContent = (audio.context.sampleRate / 1000).toFixed(0) + ' kHz / stereo';
    $('#audio-start').innerHTML = '<span>●</span> 音频已启动';
    return true;
  } catch (error) {
    toast(error.message);
    return false;
  }
}
function highlight(note, active) {
  $$(`[data-note="${note}"]`).forEach((b) => b.classList.toggle('active', active));
  if (active) $('#note-display').textContent = noteName(note) + ' / ' + note;
}
async function playNote(note, id) {
  if (id?.startsWith('pointer')) heldPointers.set(id, note);
  else heldKeys.set(id, note);
  if (!(await startAudio())) return;
  if (!heldPointers.has(id) && !heldKeys.has(id)) return;
  audio.send({ type: 'breath', value: Number($('#breath').value) / 127 });
  audio.send({ type: 'noteOn', note, velocity: Number($('#velocity').value) / 127 });
  highlight(note, true);
}
function releaseNote(id) {
  const note = heldPointers.get(id) ?? heldKeys.get(id);
  if (note === undefined) return;
  heldPointers.delete(id);
  heldKeys.delete(id);
  audio.send({ type: 'noteOff', note });
  highlight(note, false);
}
function releaseKeyboard() {
  for (const k of [...heldPointers.keys(), ...heldKeys.keys()]) releaseNote(k);
}
function panic() {
  releaseKeyboard();
  audio.panic();
  playTimers.forEach(clearTimeout);
  playTimers.length = 0;
  $$('.piano-key.active').forEach((el) => el.classList.remove('active'));
  $('#note-display').textContent = '—';
}
const pcCodes = [
  'KeyA',
  'KeyW',
  'KeyS',
  'KeyE',
  'KeyD',
  'KeyF',
  'KeyT',
  'KeyG',
  'KeyY',
  'KeyH',
  'KeyU',
  'KeyJ',
  'KeyK',
  'KeyO',
  'KeyL',
  'KeyP',
  'Semicolon',
];
const pcLabels = [
  'A',
  'W',
  'S',
  'E',
  'D',
  'F',
  'T',
  'G',
  'Y',
  'H',
  'U',
  'J',
  'K',
  'O',
  'L',
  'P',
  ';',
];
function renderKeyboard() {
  const white = [],
    black = [];
  for (let n = 0; n <= 48; n++) ([0, 2, 4, 5, 7, 9, 11].includes(n % 12) ? white : black).push(n);
  const html = (n, type, style = '') => {
    const pc = pcLabels[n - 12];
    return `<button class="piano-key ${type}" data-note="${baseNote + n}" style="${style}" aria-label="${noteName(baseNote + n)} MIDI ${baseNote + n}">${type === 'white' && n % 12 === 0 ? `<span class="key-label">${noteName(baseNote + n)}</span>` : ''}${pc ? `<span class="${type === 'white' ? 'pc-label' : 'key-label'}">${pc}</span>` : ''}</button>`;
  };
  $('#keyboard').innerHTML =
    white.map((n) => html(n, 'white')).join('') +
    black
      .map((n) => {
        const before = white.filter((w) => w < n).length;
        return html(
          n,
          'black',
          `left:calc(${(before / white.length) * 100}% - ${(0.31 / white.length) * 100}%);width:${(0.62 / white.length) * 100}%;`,
        );
      })
      .join('');
  $$('.piano-key').forEach((key) => {
    key.onpointerdown = (e) => {
      e.preventDefault();
      key.setPointerCapture(e.pointerId);
      playNote(Number(key.dataset.note), 'pointer' + e.pointerId);
    };
    key.onpointerup = key.onpointercancel = (e) => releaseNote('pointer' + e.pointerId);
  });
}

async function connectMidi() {
  try {
    if (!(await startAudio())) return;
    const devices = await midi.connect();
    audio.send({ type: 'breath', value: 0 });
    $('#breath-source').textContent = '等待 MIDI CC' + midi.config.breathCC;
    tab = 'midi';
    renderPanel();
    toast(devices.length ? 'MIDI 输入已连接' : 'Web MIDI 已连接，尚未检测到输入设备');
  } catch (error) {
    toast(error.message);
  }
}
function handleMidi(event) {
  audio.send(event);
  $('#midi-last').textContent =
    (event.device ? event.device + ' · ' : '') +
    event.type +
    (event.note !== undefined ? ' ' + noteName(event.note) : '');
  if (event.type === 'noteOn') highlight(event.note, true);
  if (event.type === 'noteOff') highlight(event.note, false);
  if (event.type === 'breath') {
    $('#breath').value = Math.round(event.value * 127);
    $('#breath-value').textContent = Math.round(event.value * 127);
    $('#breath-source').textContent =
      String(midi.config.breathCC) === 'aftertouch'
        ? 'MIDI AFTERTOUCH'
        : 'MIDI CC ' + midi.config.breathCC;
  }
  if (event.type === 'bend') {
    $('#pitch-bend').value = event.value;
    $('#bend-value').textContent = (
      event.value * Number(patch.parameters.PitchBendRange || 2)
    ).toFixed(2);
  }
  if (event.type === 'panic') panic();
}

function download(blob, name) {
  const url = URL.createObjectURL(blob),
    a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

function parsePatch(text) {
  let imported;
  if (text.trimStart().startsWith('{')) imported = JSON.parse(text);
  else {
    const xml = new DOMParser().parseFromString(text, 'application/xml');
    if (xml.querySelector('parsererror') || !xml.querySelector('IFWProgram Parameters'))
      throw new Error('不是有效的 IFW 音色文件');
    const p = xml.querySelector('IFWProgram'),
      parameters = {};
    for (const el of p.querySelector('Parameters').children)
      if (!el.tagName.startsWith('Dummy')) parameters[el.tagName] = el.textContent;
    const fx = [...xml.querySelector('FXProgram').children].map((el) => ({
      name: el.querySelector('FxName').textContent,
      parameters: Object.fromEntries(
        [...el.querySelector('Parameters').children].map((p) => [p.tagName, p.textContent]),
      ),
    }));
    imported = {
      name: p.querySelector('Name')?.textContent || 'Imported',
      author: p.querySelector('Author')?.textContent || 'Unknown',
      parameters,
      fx,
      settings: Object.fromEntries(
        [...xml.documentElement.children]
          .filter((el) => !el.children.length)
          .map((el) => [el.tagName, el.textContent]),
      ),
    };
  }
  if (!imported.parameters || !Array.isArray(imported.fx) || imported.fx.length !== 5)
    throw new Error('音色文件缺少合成参数或 5 个效果器区块');
  const result = clone(factory);
  Object.assign(result, imported);
  result.parameters = { ...factory.parameters, ...imported.parameters };
  result.settings = { ...factory.settings, ...imported.settings };
  result.modelTuning = clone(imported.modelTuning || {});
  for (let i = 1; i <= 4; i++) {
    const wave = result.parameters['Osc' + i + 'Waveform2'];
    if (!['SIN', 'TRI', 'SAW', 'SQU', 'SINE', 'PULSE', 'PWM', 'Ext In'].includes(wave))
      throw new Error('不支持的波形：' + wave + '。当前支持 SIN / TRI / SAW / PWM。');
  }
  for (let i = 1; i <= 8; i++) {
    const d = result.parameters['Mod' + i + 'Destination'];
    if (
      d &&
      d !== 'None' &&
      Number(result.parameters['Mod' + i + 'Depth']) !== 0 &&
      !supportsDestination(d)
    )
      throw new Error('当前未实现的调制目的地：' + d);
  }
  return result;
}
function exportPatch() {
  const xml = new DOMParser().parseFromString(baseXML, 'application/xml'),
    program = xml.querySelector('IFWProgram');
  program.querySelector('Name').textContent = patch.name;
  program.querySelector('Author').textContent = patch.author;
  program.querySelector('Comment').textContent = 'Edited in OpenIFW';
  program.querySelector('PatchMD5')?.remove();
  const parameters = program.querySelector('Parameters');
  for (const [key, value] of Object.entries(patch.parameters)) {
    let el = parameters.querySelector(key);
    if (!el) {
      el = xml.createElement(key);
      parameters.append(el);
    }
    el.textContent = String(value);
  }
  const fx = xml.querySelector('FXProgram');
  patch.fx.forEach((unit, i) => {
    const node = fx.children[i];
    for (const [key, value] of Object.entries(unit.parameters)) {
      const el = node.querySelector('Parameters ' + key);
      if (el) el.textContent = String(value);
    }
  });
  download(
    new Blob([new XMLSerializer().serializeToString(xml)], { type: 'application/xml' }),
    patch.name + '-web.ifwprog',
  );
  toast('已导出音色参数；原生 IFW 回读兼容性尚未验证。');
}

$('#module-nav').onclick = (e) => {
  const b = e.target.closest('[data-tab]');
  if (!b) return;
  tab = b.dataset.tab;
  renderPanel();
  $('.main-panel').scrollTop = 0;
};
$('#dry-toggle').onchange = (e) => {
  dry = e.target.checked;
  audio.setDry(dry);
  updateProgramUI();
};
$('#audio-start').onclick = () => startAudio();
$('#midi-connect').onclick = connectMidi;
$('#panic').onclick = panic;
$('#preset-select').onchange = (e) => loadPreset(e.target.value);
const presetOptions = ['factory', ...presetLibrary.presets.map((p) => p.id), 'dry', 'sine', 'saw'];
for (const [id, delta] of [
  ['previous-preset', -1],
  ['next-preset', 1],
])
  $('#' + id).onclick = () =>
    loadPreset(
      presetOptions[
        (Math.max(0, presetOptions.indexOf(preset)) + delta + presetOptions.length) %
          presetOptions.length
      ],
    );
$('#reset-patch').onclick = () => loadPreset('factory');
$('#import-patch').onclick = () => $('#patch-file').click();
$('#export-patch').onclick = exportPatch;
$('#patch-file').onchange = async (e) => {
  try {
    const file = e.target.files[0];
    if (!file) return;
    const imported = parsePatch(await file.text());
    panic();
    patch = imported;
    preset = 'user';
    dirty = true;
    dry = false;
    solo = null;
    soloBackup = null;
    audio.setPatch(patch);
    audio.setDry(dry);
    $('#patch-name').textContent = patch.name;
    $('#patch-author').textContent = patch.author + ' · 导入音色';
    const option = $('#preset-select option[value=user]');
    option.hidden = false;
    option.textContent = patch.name;
    $('#preset-select').value = 'user';
    renderPanel();
    toast('已导入 ' + patch.name);
  } catch (error) {
    toast(error.message);
  }
  e.target.value = '';
};
$('#breath').oninput = (e) => {
  const v = Number(e.target.value);
  $('#breath-value').textContent = v;
  $('#breath-source').textContent = '手动 / 屏幕键盘';
  audio.send({ type: 'breath', value: v / 127 });
};
$('#pitch-bend').oninput = (e) => {
  const v = Number(e.target.value);
  audio.send({ type: 'bend', value: v });
  $('#bend-value').textContent = (v * Number(patch.parameters.PitchBendRange || 2)).toFixed(2);
};
function centerBend() {
  $('#pitch-bend').value = 0;
  audio.send({ type: 'bend', value: 0 });
  $('#bend-value').textContent = '0.00';
}
$('#pitch-bend').onpointerup = $('#pitch-bend').onpointercancel = centerBend;
$('#octave').onchange = (e) => {
  releaseKeyboard();
  baseNote = Number(e.target.value);
  renderKeyboard();
};
$('#play-demo').onclick = async () => {
  if (!(await startAudio())) return;
  panic();
  audio.send({ type: 'breath', value: Number($('#breath').value) / 127 });
  const notes = [60, 62, 64, 67, 72, 67, 64, 62, 60],
    events = [];
  notes.forEach((note, i) =>
    events.push(
      { time: i * 0.34, type: 'noteOn', note, velocity: 0.8 },
      { time: i * 0.34 + 0.26, type: 'noteOff', note },
    ),
  );
  audio.node.port.postMessage({ command: 'schedule', events });
  for (const e of events)
    playTimers.push(setTimeout(() => highlight(e.note, e.type === 'noteOn'), e.time * 1000 + 30));
};
$('#help-open').onclick = () => $('#help-dialog').showModal();
$('#help-close').onclick = () => $('#help-dialog').close();
window.addEventListener('keydown', (e) => {
  if (
    e.ctrlKey ||
    e.metaKey ||
    e.altKey ||
    e.repeat ||
    e.target.closest('input,select,textarea,dialog')
  )
    return;
  if (e.code === 'Escape') {
    panic();
    return;
  }
  const index = pcCodes.indexOf(e.code);
  if (index >= 0) {
    e.preventDefault();
    playNote(baseNote + 12 + index, e.code);
  }
});
window.addEventListener('keyup', (e) => releaseNote(e.code));
window.addEventListener('blur', releaseKeyboard);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) releaseKeyboard();
});
audio.onMeter = (m) => {
  if (!m || m.type !== 'meter') return;
  $('#breath-value').textContent = Math.round(m.breath * 127);
  if (m.gate > 0.1) $('#note-display').textContent = noteName(m.note) + ' / ' + m.note;
  $$('.piano-key').forEach((key) =>
    key.classList.toggle('active', m.gate > 0.1 && Number(key.dataset.note) === m.note),
  );
};
audio.onError = (e) => toast(e.message);
const scope = $('#scope'),
  scopeCtx = scope.getContext('2d'),
  scopeData = new Float32Array(2048);
let lastScope = 0;
function animate(t) {
  requestAnimationFrame(animate);
  if (t - lastScope < 40) return;
  lastScope = t;
  const w = scope.width,
    h = scope.height;
  scopeCtx.clearRect(0, 0, w, h);
  scopeCtx.strokeStyle = '#344e5844';
  scopeCtx.lineWidth = 1;
  scopeCtx.beginPath();
  scopeCtx.moveTo(0, h / 2);
  scopeCtx.lineTo(w, h / 2);
  scopeCtx.stroke();
  if (audio.analyser) {
    audio.analyser.getFloatTimeDomainData(scopeData);
    let peak = 0;
    for (const sample of scopeData) peak = Math.max(peak, Math.abs(sample));
    $('#output-db').textContent =
      peak > 1e-7 ? (20 * Math.log10(peak)).toFixed(1) + ' dBFS' : '−∞ dBFS';
    scopeCtx.strokeStyle = '#59afa9';
    scopeCtx.lineWidth = 1.6;
    scopeCtx.beginPath();
    for (let i = 0; i < 512; i++) {
      const x = (i / 511) * w,
        y = h / 2 - scopeData[i] * h * 4;
      if (i) scopeCtx.lineTo(x, y);
      else scopeCtx.moveTo(x, y);
    }
    scopeCtx.stroke();
  }
}
renderPanel();
renderKeyboard();
requestAnimationFrame(animate);
