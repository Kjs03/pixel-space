// Color-quantized, softly struck piano / glass with a bounded output bus.
class PixelSound {
  constructor() {
    this.enabled = false;
    this.context = null;
    this.voices = new Set();
    this.lastNoteTime = -Infinity;
    this.lastNote = -1;
    this.recentNotes = new Map();
    this.wasActive = false;
    this.maxVoices = 6;
    this.scale = Array.from({ length: 21 }, (_, i) => 36 + Math.floor(i / 5) * 12 + [0, 2, 4, 7, 9][i % 5]);
  }

  colorToHSL(red, green, blue) {
    const [r, g, b] = [red, green, blue].map(v => Math.max(0, Math.min(1, v)));
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const delta = max - min, lightness = (max + min) / 2;
    if (delta < .00001) return { hue: 0, saturation: 0, lightness };
    let hue = max === r ? ((g - b) / delta + 6) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
    return { hue: hue * 60, saturation: delta / (1 - Math.abs(2 * lightness - 1)), lightness };
  }

  noteForColor(red, green, blue) {
    const color = this.colorToHSL(red, green, blue);
    const h = color.hue;
    // Red/magenta C, orange D, yellow E, green G, cyan A, blue D, violet E/G.
    const pitch = color.saturation < .08 ? 0 : h < 18 ? 0 : h < 45 ? 2 : h < 78 ? 4
      : h < 160 ? 7 : h < 205 ? 9 : h < 255 ? 2 : h < 280 ? 4 : h < 310 ? 7 : 0;
    const octave = Math.min(3, Math.floor(color.lightness * 4));
    const blueLift = color.saturation >= .08 && h >= 205 && h < 255 ? 12 : 0;
    const note = color.lightness > .96 ? 84 : Math.min(84, 36 + octave * 12 + pitch + blueLift);
    return { ...color, note };
  }

  // Kept for brightness-only callers; interaction uses full RGB below.
  noteForBrightness(brightness) {
    return this.scale[Math.round(Math.max(0, Math.min(1, brightness)) * (this.scale.length - 1))];
  }

  async toggle() {
    this.enabled = !this.enabled;
    if (!this.enabled) {
      this.silence();
      this.master?.gain.setTargetAtTime(0, this.context.currentTime, .025);
      return false;
    }
    try {
      if (!this.context) {
        const Audio = window.AudioContext || window.webkitAudioContext;
        if (!Audio) throw new Error('Web Audio is unavailable');
        this.context = new Audio();
        this.connectOutput();
      }
      await this.context.resume();
      this.master.gain.cancelScheduledValues(this.context.currentTime);
      this.master.gain.setTargetAtTime(this.enabled ? 1.1 : 0, this.context.currentTime, .04);
      return this.enabled;
    } catch (error) {
      await this.dispose();
      throw error;
    }
  }

  connectOutput() {
    const ctx = this.context;
    this.tone = ctx.createBiquadFilter();
    this.tone.type = 'lowpass';
    this.tone.frequency.value = 4600;
    this.tone.Q.value = .35;
    this.master = ctx.createGain();
    this.master.gain.value = 1.1;
    this.delay = ctx.createDelay(.5);
    this.delay.delayTime.value = .21;
    this.tail = ctx.createGain();
    this.tail.gain.value = .12;
    this.tailFilter = ctx.createBiquadFilter();
    this.tailFilter.type = 'lowpass';
    this.tailFilter.frequency.value = 2400;
    this.compressor = ctx.createDynamicsCompressor();
    Object.entries({ threshold: -22, knee: 14, ratio: 3, attack: .006, release: .24 })
      .forEach(([key, value]) => { this.compressor[key].value = value; });
    this.limiter = ctx.createDynamicsCompressor();
    Object.entries({ threshold: -3, knee: 0, ratio: 20, attack: .001, release: .09 })
      .forEach(([key, value]) => { this.limiter[key].value = value; });
    this.tone.connect(this.master);
    this.tone.connect(this.delay);
    this.delay.connect(this.tailFilter);
    this.tailFilter.connect(this.tail);
    this.tail.connect(this.master);
    this.master.connect(this.compressor);
    this.compressor.connect(this.limiter);
    this.limiter.connect(ctx.destination);
  }

  update(color, active, speed) {
    if (!this.context || !this.enabled || this.context.state !== 'running') return;
    if (!active) {
      if (this.wasActive) this.silence();
      this.wasActive = false;
      return;
    }
    const rgb = typeof color === 'number' ? [color, color, color] : color;
    const { note, saturation } = this.noteForColor(...rgb);
    const now = this.context.currentTime;
    const velocity = Math.max(0, Math.min(1, speed || 0));
    const interval = .24 - velocity * .07;
    const changed = note !== this.lastNote;
    const repeat = now - this.lastNoteTime > 1 && velocity > .04;
    const cooled = now - (this.recentNotes.get(note) ?? -Infinity) >= .48;
    if ((changed || !this.wasActive || repeat) && cooled && now - this.lastNoteTime >= interval) {
      if (this.playNote(note, velocity, saturation)) {
        this.lastNote = note;
        this.lastNoteTime = now;
        this.recentNotes.set(note, now);
      }
    }
    this.wasActive = true;
  }

  playNote(note, velocity, saturation = .5) {
    if (this.voices.size >= this.maxVoices) return false;
    const now = this.context.currentTime;
    const frequency = 440 * Math.pow(2, (note - 69) / 12);
    const gain = this.context.createGain();
    const level = (.032 + Math.max(0, Math.min(1, velocity)) * .014) * (.96 + saturation * .08);
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(level, now + .014);
    gain.gain.exponentialRampToValueAtTime(level * .38, now + .25);
    gain.gain.exponentialRampToValueAtTime(.0001, now + 1.45);
    gain.gain.linearRampToValueAtTime(0, now + 1.52);
    gain.connect(this.tone);
    const voice = { gain, oscillators: [], cleaned: false };
    this.voices.add(voice);
    const harmonics = [1, 2, 3, 4.01];
    const weights = [.76, .17 + saturation * .025, .045 + saturation * .015, .018];
    harmonics.forEach((harmonic, i) => {
      const oscillator = this.context.createOscillator();
      const partial = this.context.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(frequency * harmonic, now);
      // High notes carry less upper-partial energy; upper partials decay first.
      const damping = i === 0 ? 1 : Math.min(1, 900 / frequency);
      partial.gain.setValueAtTime(weights[i] * damping, now);
      partial.gain.exponentialRampToValueAtTime(.0001, now + (i === 0 ? 1.5 : .85 - i * .13));
      oscillator.connect(partial);
      partial.connect(gain);
      voice.oscillators.push({ oscillator, partial });
      oscillator.start(now);
      oscillator.stop(now + 1.55);
    });
    voice.oscillators[0].oscillator.onended = () => this.releaseVoice(voice);
    return true;
  }

  releaseVoice(voice) {
    if (voice.cleaned) return;
    voice.cleaned = true;
    for (const { oscillator, partial } of voice.oscillators) {
      oscillator.onended = null;
      oscillator.disconnect();
      partial.disconnect();
    }
    voice.gain.disconnect();
    this.voices.delete(voice);
  }

  silence() {
    this.wasActive = false;
    this.lastNote = -1;
    if (!this.context) return;
    const now = this.context.currentTime;
    for (const voice of this.voices) {
      if (voice.releasing) continue;
      voice.releasing = true;
      const envelope = voice.gain.gain;
      if (envelope.cancelAndHoldAtTime) envelope.cancelAndHoldAtTime(now);
      else envelope.cancelScheduledValues(now);
      envelope.setTargetAtTime(0, now, .025);
      for (const { oscillator } of voice.oscillators) oscillator.stop(now + .12);
    }
  }

  async dispose() {
    this.enabled = false;
    if (!this.context) return;
    this.silence();
    for (const voice of this.voices) this.releaseVoice(voice);
    for (const node of [this.tone, this.master, this.delay, this.tail, this.tailFilter, this.compressor, this.limiter]) node?.disconnect();
    if (this.context.state !== 'closed') await this.context.close();
    this.context = null;
  }
}
