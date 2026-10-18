// IFW exports use title case; editor controls used uppercase in the first version.
// Resolve both to parameter keys so imported slots and edited slots share a path.
const destinations = [['None', null]];
for (let i = 1; i <= 4; i++)
  for (const [label, suffix] of [
    ['Pitch', 'Pitch'],
    ['FM', 'FM'],
    ['SAW Level', 'SawLevel'],
    ['TRI Level', 'TriLevel'],
    ['Wave Level', 'TriLevel'],
    ['PWM Level', 'PwmLevel'],
    ['PWM Width', 'PwmWidth'],
    ['PWM Phase', 'PwmWidth'],
    ...(i === 4
      ? [
          ['Noise Level', 'NoiseLevel'],
          ['Noise Lo-Fi', 'NoiseLoFi'],
        ]
      : []),
  ]) {
    destinations.push([`OSC ${i} ${label}`, `Osc${i}${suffix}`]);
  }
for (let i = 1; i <= 3; i++)
  for (const [label, suffix] of [
    ['Frequency', 'Frequency'],
    ['Resonance', 'Resonance'],
    ...(i === 3 ? [['Mix', 'Mix']] : []),
  ])
    destinations.push([`Filter ${i} ${label}`, `Filter${i}${suffix}`]);
for (let i = 1; i <= 2; i++) destinations.push([`AMP ${i} Level`, `Amp${i}Level`]);
for (let i = 1; i <= 4; i++) destinations.push([`EG ${i} Rate`, `Eg${i}Rate`]);
for (let i = 1; i <= 2; i++) destinations.push([`LFO ${i} Rate`, `Lfo${i}Rate`]);
destinations.push(
  ['Exciter Frequency', 'ExciterFrequency'],
  ['Exciter Mix', 'ExciterMix'],
  ['Enhancer Mix', 'EnhancerMix'],
);
const canonical = (text) =>
  String(text ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toUpperCase();
const keys = new Map(destinations.map(([label, key]) => [canonical(label), key]));
export const modulationDestinations = destinations.map(([label]) => label);
export const destinationKey = (label) => keys.get(canonical(label));
export const supportsDestination = (label) => keys.has(canonical(label));
