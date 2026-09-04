// Synthesized "casting" sound for the rune-throw loading animation — no
// audio file needed. Three soft stone-clack taps (bandpass-filtered noise
// bursts) synced to when each .cast-stone lands in the CSS animation
// (public/css/style.css: @keyframes cast-fall, 1.7s cycle, landing ~58%),
// layered under a gentle sine-pad chord that fades in for atmosphere.

let ctx = null;
let intervalId = null;
let padGain = null;
let padOscs = null;

function getCtx() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

function playClack(time, freq) {
  const ac = ctx;
  const dur = 0.09;
  const bufferSize = Math.floor(ac.sampleRate * dur);
  const buffer = ac.createBuffer(1, bufferSize, ac.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) {
    data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / bufferSize, 2);
  }
  const noise = ac.createBufferSource();
  noise.buffer = buffer;

  const bandpass = ac.createBiquadFilter();
  bandpass.type = 'bandpass';
  bandpass.frequency.value = freq;
  bandpass.Q.value = 1.3;

  const gain = ac.createGain();
  gain.gain.setValueAtTime(0.22, time);
  gain.gain.exponentialRampToValueAtTime(0.001, time + dur);

  noise.connect(bandpass).connect(gain).connect(ac.destination);
  noise.start(time);
  noise.stop(time + dur + 0.02);
}

function startPad() {
  const ac = ctx;
  padGain = ac.createGain();
  padGain.gain.setValueAtTime(0, ac.currentTime);
  padGain.gain.linearRampToValueAtTime(0.05, ac.currentTime + 1.4);
  padGain.connect(ac.destination);

  // soft open fifth + octave — a calm, ambiguous "meditative" chord
  const freqs = [196.0, 293.66, 392.0];
  padOscs = freqs.map((f) => {
    const o = ac.createOscillator();
    o.type = 'sine';
    o.frequency.value = f;
    o.connect(padGain);
    o.start();
    return o;
  });
}

function stopPad() {
  if (!padGain || !ctx) return;
  const now = ctx.currentTime;
  const g = padGain;
  const oscs = padOscs;
  g.gain.cancelScheduledValues(now);
  g.gain.setValueAtTime(g.gain.value, now);
  g.gain.linearRampToValueAtTime(0, now + 0.5);
  setTimeout(() => { oscs.forEach((o) => { try { o.stop(); } catch {} }); }, 600);
  padGain = null;
  padOscs = null;
}

// Call synchronously from a user-gesture handler (click/submit), before any
// `await`, so the browser's autoplay policy allows audio to start.
export function startCastSound() {
  getCtx();
  if (intervalId) return; // already running
  startPad();

  const cycle = 1.7;
  const landOffsets = [0.986, 1.186, 1.386]; // matches .s1/.s2/.s3 delays + 58% of 1.7s
  const freqs = [780, 980, 880];

  function scheduleCycle(baseTime) {
    landOffsets.forEach((off, i) => playClack(baseTime + off, freqs[i]));
  }

  let cycleStart = ctx.currentTime + 0.02;
  scheduleCycle(cycleStart);
  intervalId = setInterval(() => {
    cycleStart += cycle;
    scheduleCycle(cycleStart);
  }, cycle * 1000);
}

export function stopCastSound() {
  if (intervalId) { clearInterval(intervalId); intervalId = null; }
  stopPad();
}
