import { PcmRing } from './audio-ring.js';

class WiiClipseAudioProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.ring = new PcmRing(options.processorOptions.buffer);
  }

  process(inputs, outputs) {
    const channels = outputs[0];
    if (channels.length < 2) return true;
    // Work with the actual quantum length and hardware rate; neither is assumed fixed.
    return this.ring.render(channels[0], channels[1], sampleRate);
  }
}

registerProcessor('wiiclipse-audio', WiiClipseAudioProcessor);
