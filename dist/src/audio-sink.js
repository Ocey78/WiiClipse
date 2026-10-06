export class AudioSink {
  constructor() {
    this.context = null;
    this.nextTime = 0;
  }

  async resume() {
    if (!this.context) {
      const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!AudioContextClass) return false;
      this.context = new AudioContextClass({ latencyHint: 'interactive' });
      this.nextTime = this.context.currentTime;
    }
    if (this.context.state === 'suspended') await this.context.resume();
    return true;
  }

  push({ buffer, frames, sampleRate = 48000 }) {
    if (!this.context || !buffer || !frames) return;
    const input = new Int16Array(buffer);
    const audio = this.context.createBuffer(2, frames, sampleRate);
    const left = audio.getChannelData(0);
    const right = audio.getChannelData(1);
    for (let i = 0; i < frames; i++) {
      left[i] = (input[i * 2] || 0) / 32768;
      right[i] = (input[i * 2 + 1] || 0) / 32768;
    }
    const source = this.context.createBufferSource();
    source.buffer = audio;
    source.connect(this.context.destination);
    const now = this.context.currentTime;
    if (this.nextTime < now - 0.08 || this.nextTime > now + 0.25) this.nextTime = now + 0.02;
    source.start(this.nextTime);
    this.nextTime += audio.duration;
  }
}
