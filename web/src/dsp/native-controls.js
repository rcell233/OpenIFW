// Shared oscillator, modulation and filter control mappings for every preset.
export const OSCILLATOR_GAIN = 0.037;
export const SECONDARY_WAVE_GAIN = 1.1785;
export const NOISE_GAIN = 0.79;
export const PITCH_MOD_SEMITONES = 2.4;
export const AMP_MOD_GAIN = 0.05;
export const EG_RATE_LOG_SLOPE = 0.8742323893;
const noteCV = (note) => 7.7 + 5 * ((2 * (note - 64)) / 127);
const FILTER3_CUTOFF_KNOTS = [
  [5.7, 850.4219584482449],
  [noteCV(48), 1443.3044461941413],
  [noteCV(60), 2646.581370739413],
  [7.7, 3210.0425529737995],
  [noteCV(72), 4677.170704061711],
  [9.7, 10254.617860351776],
];
export function filter3Hz(cv, sampleRate = 48000) {
  let i = 1;
  while (i < FILTER3_CUTOFF_KNOTS.length - 1 && cv > FILTER3_CUTOFF_KNOTS[i][0]) i++;
  const a = FILTER3_CUTOFF_KNOTS[i - 1],
    b = FILTER3_CUTOFF_KNOTS[i];
  // Interpolate the digital pole's log-frequency CV, retaining the measured
  // high-cutoff warping rather than assuming equal Hz per semitone.
  const ga = Math.tan((Math.PI * a[1]) / 48000),
    gb = Math.tan((Math.PI * b[1]) / 48000);
  const g = ga * Math.exp((Math.log(gb / ga) * (cv - a[0])) / (b[0] - a[0]));
  return Math.min(sampleRate * 0.49, (48000 / Math.PI) * Math.atan(g));
}

// LP12 isolated-component fit; saturation is measured separately at high CV.
export const PARAMETER_FILTER_LAW = {
  baseHz: 5.663990017612683,
  frequencyLogSlope: 0.9236470127266707,
  breathLogSlope: 0.8355614261719994,
  keyLogSlopePerSemitone: 0.07083919091247709,
  keyLogOffset: -0.0002788762124903089,
};
export function parameterCutoffHz(frequency, depth, source, keyTrack, note, sampleRate = 48000) {
  const l = PARAMETER_FILTER_LAW;
  return Math.min(
    20700,
    sampleRate * 0.49,
    l.baseHz *
      Math.exp(
        l.frequencyLogSlope * frequency +
          l.breathLogSlope * depth * source +
          (l.keyLogSlopePerSemitone * (note - 60) * keyTrack) / 10 +
          l.keyLogOffset * keyTrack,
      ),
  );
}
