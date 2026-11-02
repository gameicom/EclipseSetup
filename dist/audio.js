export const DEFAULT_VOLUME = 80;
export function normalizeVolume(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : DEFAULT_VOLUME;
}
export function readAudioPreference(value) {
  return { sound:value?.sound === true, volume:normalizeVolume(value?.volume) };
}
export function playAlarm(context, volume = DEFAULT_VOLUME) {
  const loudness = normalizeVolume(volume) / 100;
  if (!context || context.state !== 'running' || loudness === 0) return false;
  // Non-overlapping pulses keep the peak below 1, including at maximum volume.
  [784, 1046.5, 1318.5, 784, 1046.5, 1318.5].forEach((frequency,index) => {
    const start = context.currentTime + index * 0.27;
    const oscillator = context.createOscillator(), gain = context.createGain();
    oscillator.type = 'triangle';
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(0.7 * loudness, start + 0.02);
    gain.gain.setValueAtTime(0.7 * loudness, start + 0.13);
    gain.gain.exponentialRampToValueAtTime(0.001, start + 0.24);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start(start);
    oscillator.stop(start + 0.25);
    oscillator.onended = () => {oscillator.disconnect(); gain.disconnect();};
  });
  return true;
}
