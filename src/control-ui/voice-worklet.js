/* Microphone capture for voice.js: turns the audio context's samples into 16 kHz mono 16-bit PCM frames of 100 ms
 * and reports the loudness of each frame. */
const TARGET_RATE = 16000, FRAME = 1600;
class VoiceCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.step = sampleRate / TARGET_RATE; this.position = 0; this.sum = 0; this.count = 0;
    this.frame = new Int16Array(FRAME); this.length = 0; this.energy = 0;
  }
  process(inputs) {
    const samples = inputs[0]?.[0];
    if (!samples) return true;
    for (let index = 0; index < samples.length; index++) {
      this.sum += samples[index]; this.count++; this.position++;
      if (this.position < this.step) continue;
      this.position -= this.step;
      const value = Math.max(-1, Math.min(1, this.sum / this.count)); this.sum = 0; this.count = 0;
      this.frame[this.length++] = value < 0 ? value * 0x8000 : value * 0x7fff; this.energy += value * value;
      if (this.length === FRAME) {
        this.port.postMessage({ pcm: this.frame.buffer, level: Math.sqrt(this.energy / FRAME) }, [this.frame.buffer]);
        this.frame = new Int16Array(FRAME); this.length = 0; this.energy = 0;
      }
    }
    return true;
  }
}
registerProcessor('voice-capture', VoiceCapture);
