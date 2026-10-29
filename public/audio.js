// P-Day Quips sound engine. Everything is synthesized with the Web Audio API:
// original music loops + sound effects, no audio files to download.
window.PDQAudio = (() => {
  let analyser = null;
  let ctx = null, master, musicBus, sfxBus, noiseBuf;
  let theme = null, nextTheme = null, step = 0, nextTime = 0, timerId = null;
  const prefs = { music: true, sfx: true };
  try { Object.assign(prefs, JSON.parse(localStorage.getItem("pdq_audio")) || {}); } catch {}
  const save = () => { try { localStorage.setItem("pdq_audio", JSON.stringify(prefs)); } catch {} };

  const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
  const CH = { maj: [0, 4, 7], min: [0, 3, 7], sus: [0, 5, 7], maj7: [0, 4, 7, 11], m7: [0, 3, 7, 10] };

  function init() {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain(); master.gain.value = 0.9;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.ratio.value = 4;
    analyser = ctx.createAnalyser(); analyser.fftSize = 2048;
    master.connect(comp).connect(analyser).connect(ctx.destination);
    musicBus = ctx.createGain(); musicBus.gain.value = prefs.music ? 0.32 : 0; musicBus.connect(master);
    sfxBus = ctx.createGain(); sfxBus.gain.value = prefs.sfx ? 0.8 : 0; sfxBus.connect(master);
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return ctx;
  }
  function unlock() {
    if (!init()) return;
    if (ctx.state !== "running") ctx.resume();
    // iOS: play a silent buffer inside the gesture
    const s = ctx.createBufferSource(); s.buffer = ctx.createBuffer(1, 1, 22050); s.connect(ctx.destination); s.start(0);
  }
  const ready = () => ctx && ctx.state === "running";

  // ---------- voices ----------
  function tone(freq, t, dur, { type = "triangle", gain = 0.3, dest, attack = 0.005, release = 0.08, cutoff = 0, slideTo = 0 } = {}) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(gain, t + attack);
    g.gain.setValueAtTime(gain, Math.max(t + attack, t + dur - release));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    let node = o;
    if (cutoff) { const f = ctx.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = cutoff; o.connect(f); node = f; }
    node.connect(g).connect(dest || sfxBus);
    o.start(t); o.stop(t + dur + 0.05);
  }
  function noise(t, dur, { gain = 0.2, dest, type = "highpass", freq = 7000, q = 1, sweepTo = 0 } = {}) {
    const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    s.buffer = noiseBuf; f.type = type; f.frequency.setValueAtTime(freq, t); f.Q.value = q;
    if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t + dur);
    g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f).connect(g).connect(dest || sfxBus);
    s.start(t, Math.random() * 0.5); s.stop(t + dur + 0.02);
  }
  function kick(t, dest, gain = 0.9) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.setValueAtTime(140, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
    g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    o.connect(g).connect(dest); o.start(t); o.stop(t + 0.32);
  }

  // ---------- music ----------
  // Each theme: bpm, 4 one-bar chords [root midi, quality], 16-step drum/arp patterns.
  const THEMES = {
    lobby:  { bpm: 96,  chords: [[60,"maj7"],[57,"m7"],[53,"maj7"],[55,"sus"]], kick: "x.......x.......", snare: "....x.......x...", hat: "..x...x...x...x.", arp: "x.x.x.x.x.x.x.x.", arpOct: 12, bass: "x.....x.x.......", swing: 0.12 },
    answer: { bpm: 112, chords: [[53,"maj"],[55,"maj"],[52,"min"],[57,"min"]], kick: "x...x...x...x...", snare: "....x.......x...", hat: "xxxxxxxxxxxxxxxx", arp: "x.xx.x.xx.x.x.xx", arpOct: 12, bass: "x..x..x.x..x..x.", swing: 0.08 },
    vote:   { bpm: 120, chords: [[50,"min"],[58,"maj"],[60,"maj"],[57,"maj"]], kick: "x..x..x.x..x..x.", snare: "....x.......x..x", hat: "x.x.x.x.x.x.x.x.", arp: "x..x..x..x..x.x.", arpOct: 24, bass: "x..x..x.x..x..x.", swing: 0 },
    scores: { bpm: 100, chords: [[60,"maj"],[55,"maj"],[57,"min"],[53,"maj"]], kick: "x.......x.......", snare: "....x.......x...", hat: "x.x.x.x.x.x.x.x.", arp: "", arpOct: 12, bass: "x.......x...x...", swing: 0.1 },
    final:  { bpm: 128, chords: [[57,"min"],[53,"maj"],[48,"maj"],[55,"maj"]], kick: "x...x...x...x...", snare: "....x.......x.x.", hat: ".x.x.x.x.x.x.x.x", arp: "xxxxxxxxxxxxxxxx", arpOct: 12, bass: "x.xx.x.xx.xx.x.x", swing: 0 },
    end:    { bpm: 116, chords: [[60,"maj"],[53,"maj"],[55,"maj"],[60,"maj"]], kick: "x...x...x...x...", snare: "....x.......x...", hat: "x.x.x.x.x.x.x.x.", arp: "x.x.x.x.x.x.x.x.", arpOct: 24, bass: "x...x...x...x.x.", swing: 0.06 },
  };

  function scheduleStep(th, s, t) {
    const i = s % 16, bar = Math.floor(s / 16) % th.chords.length;
    const [root, q] = th.chords[bar], notes = CH[q];
    if (th.kick[i] === "x") kick(t, musicBus, 0.8);
    if (th.snare[i] === "x") { noise(t, 0.16, { gain: 0.35, dest: musicBus, type: "bandpass", freq: 1800, q: 0.8 }); tone(190, t, 0.08, { type: "triangle", gain: 0.25, dest: musicBus }); }
    if (th.hat[i] === "x") noise(t, 0.04, { gain: i % 4 === 2 ? 0.12 : 0.07, dest: musicBus });
    if (th.bass[i] === "x") tone(mtof(root - 24 + (i === 14 ? 7 : 0)), t, 0.22, { type: "sawtooth", gain: 0.32, dest: musicBus, cutoff: 420, release: 0.1 });
    if (i === 0) for (const n of notes) tone(mtof(root + n), t, (60 / th.bpm) * 4 * 0.98, { type: "triangle", gain: 0.06, dest: musicBus, attack: 0.15, release: 0.4, cutoff: 1400 });
    if (th.arp && th.arp[i] === "x") {
      const seq = notes.concat(notes.map((n) => n + 12));
      const n = seq[(s * 3 + bar) % seq.length];
      tone(mtof(root + n + th.arpOct - 12), t, 0.14, { type: "square", gain: 0.06, dest: musicBus, cutoff: 2600, release: 0.08 });
    }
  }
  function tick() {
    while (nextTime < ctx.currentTime + 0.12) {
      if (nextTheme && step % 16 === 0) { theme = THEMES[nextTheme]; nextTheme = null; step = 0; }
      if (!theme) break;
      const sixteenth = 60 / theme.bpm / 4;
      const swing = step % 2 ? sixteenth * theme.swing : 0;
      scheduleStep(theme, step, nextTime + swing);
      nextTime += sixteenth; step++;
    }
  }
  function playMusic(name) {
    if (!init() || !THEMES[name]) return;
    if (theme && THEMES[name] === theme && !nextTheme) return;
    if (!theme) { theme = THEMES[name]; step = 0; nextTime = ctx.currentTime + 0.05; }
    else nextTheme = name; // switch on the next bar line
    if (!timerId) timerId = setInterval(tick, 25);
  }
  function stopMusic() { theme = null; nextTheme = null; if (timerId) { clearInterval(timerId); timerId = null; } }
  function duck(sec = 2.5) {
    if (!ready() || !prefs.music) return;
    const t = ctx.currentTime, g = musicBus.gain;
    g.cancelScheduledValues(t); g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(0.08, t + 0.1); g.setValueAtTime(0.08, t + sec); g.linearRampToValueAtTime(0.32, t + sec + 0.6);
  }

  // ---------- sound effects ----------
  const arp = (notes, t, step, opts) => notes.forEach((m, i) => tone(mtof(m), t + i * step, opts.dur || 0.18, opts));
  const SFX = {
    join(t)   { arp([72, 79], t, 0.07, { type: "square", gain: 0.12, cutoff: 3000, dur: 0.12 }); },
    tap(t)    { tone(880, t, 0.05, { type: "triangle", gain: 0.25 }); },
    submit(t) { noise(t, 0.18, { gain: 0.18, type: "bandpass", freq: 600, sweepTo: 5000, q: 2 }); arp([76, 84], t + 0.06, 0.06, { type: "triangle", gain: 0.25, dur: 0.14 }); },
    vote(t)   { tone(660, t, 0.07, { type: "square", gain: 0.12, cutoff: 2500 }); tone(990, t + 0.05, 0.09, { type: "square", gain: 0.12, cutoff: 2500 }); },
    tick(t)   { tone(1200, t, 0.04, { type: "sine", gain: 0.3 }); noise(t, 0.02, { gain: 0.1 }); },
    timeup(t) { tone(220, t, 0.45, { type: "sawtooth", gain: 0.22, cutoff: 900 }); tone(233, t, 0.45, { type: "sawtooth", gain: 0.18, cutoff: 900 }); },
    round(t)  { arp([60, 64, 67, 72], t, 0.08, { type: "square", gain: 0.12, cutoff: 3200, dur: 0.16 }); kick(t, sfxBus, 0.5); noise(t + 0.32, 0.6, { gain: 0.12 }); },
    whoosh(t) { noise(t, 0.4, { gain: 0.22, type: "bandpass", freq: 300, sweepTo: 4000, q: 1.5 }); },
    drumroll(t, dur = 1.1) { for (let x = 0; x < dur; x += 0.045) noise(t + x, 0.05, { gain: 0.06 + 0.12 * (x / dur), type: "bandpass", freq: 1600, q: 0.7 }); },
    reveal(t) { kick(t, sfxBus, 0.8); noise(t, 0.9, { gain: 0.16 }); arp([67, 72, 76], t, 0.05, { type: "triangle", gain: 0.25, dur: 0.4 }); },
    points(t) { arp([84, 88, 91, 96], t, 0.06, { type: "square", gain: 0.1, cutoff: 4000, dur: 0.1 }); },
    sweep(t)  { arp([60, 64, 67, 72, 76, 79, 84], t, 0.07, { type: "square", gain: 0.12, cutoff: 3500, dur: 0.2 }); [72, 76, 79, 84].forEach((m) => tone(mtof(m), t + 0.5, 0.9, { type: "triangle", gain: 0.12, release: 0.5 })); noise(t + 0.5, 1.2, { gain: 0.14 }); },
    jinx(t)   { tone(392, t, 0.25, { type: "sawtooth", gain: 0.18, cutoff: 1200, slideTo: 370 }); tone(370, t + 0.28, 0.25, { type: "sawtooth", gain: 0.18, cutoff: 1200, slideTo: 349 }); tone(349, t + 0.56, 0.7, { type: "sawtooth", gain: 0.18, cutoff: 1200, slideTo: 262 }); },
    scores(t) { arp([67, 72, 76, 79], t, 0.1, { type: "triangle", gain: 0.22, dur: 0.3 }); },
    winner(t) {
      const fan = [[67, 0], [67, 0.15], [67, 0.3], [72, 0.45], [76, 0.9], [79, 1.1], [84, 1.3]];
      fan.forEach(([m, d]) => tone(mtof(m), t + d, d >= 1.3 ? 1.2 : 0.16, { type: "square", gain: 0.13, cutoff: 3500, release: d >= 1.3 ? 0.8 : 0.05 }));
      [60, 64, 67, 72].forEach((m) => tone(mtof(m), t + 1.3, 1.4, { type: "triangle", gain: 0.1, release: 0.9 }));
      kick(t + 1.3, sfxBus, 0.9); noise(t + 1.3, 1.6, { gain: 0.18 });
    },
  };
  function sfx(name, delay = 0, ...args) {
    if (!ready() || !prefs.sfx || !SFX[name]) return;
    SFX[name](ctx.currentTime + 0.01 + delay, ...args);
  }

  function setPref(k, v) {
    prefs[k] = v; save();
    if (!ctx) return;
    if (k === "music") musicBus.gain.setTargetAtTime(v ? 0.32 : 0, ctx.currentTime, 0.1);
    if (k === "sfx") sfxBus.gain.setTargetAtTime(v ? 0.8 : 0, ctx.currentTime, 0.05);
  }

  function level() { // peak output level 0..1 (used by tests)
    if (!analyser) return 0; const d = new Float32Array(analyser.fftSize); analyser.getFloatTimeDomainData(d);
    let m = 0; for (const v of d) m = Math.max(m, Math.abs(v)); return m;
  }
  return { level, unlock, ready, playMusic, stopMusic, duck, sfx, prefs, setPref, state: () => (ctx ? ctx.state : "none") };
})();
