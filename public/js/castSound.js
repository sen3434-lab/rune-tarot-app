// Synthesized "casting" sound for the rune-throw loading animation — no
// audio file needed. Three soft stone-clack taps (bandpass-filtered noise
// bursts) synced to when each .cast-stone lands in the CSS animation
// (public/css/style.css: @keyframes cast-fall, 1.7s cycle, landing ~58%),
// layered under a gentle sine-pad chord that fades in for atmosphere.

// 소리 켜기/끄기: 기기에 저장되는 개인 설정이다(설정 화면에서 바꾼다).
// 기본값은 켜짐. 저장소를 못 쓰는 환경에서도 앱이 멈추지 않게 try/catch.
const SOUND_KEY = 'rt_sound';

export function isSoundOn() {
  try { return localStorage.getItem(SOUND_KEY) !== 'off'; } catch { return true; }
}

export function setSoundOn(on) {
  try { localStorage.setItem(SOUND_KEY, on ? 'on' : 'off'); } catch {}
  if (!on) stopCastSound();
}

// 진동: 룬이 떨어지는 순간(돌 세 번)에 맞춰 짧게 세 번. 기본값은 꺼짐.
// navigator.vibrate는 안드로이드 크롬/앱에서만 동작하고(아이폰 등은 미지원),
// 사용자가 버튼을 누른 직후에만 허용된다.
const VIBE_KEY = 'rt_vibe';

export function canVibrate() {
  return typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';
}

export function isVibeOn() {
  try { return localStorage.getItem(VIBE_KEY) === 'on'; } catch { return false; }
}

export function setVibeOn(on) {
  try { localStorage.setItem(VIBE_KEY, on ? 'on' : 'off'); } catch {}
  if (!on) stopVibe();
}

let vibeInterval = null;
let vibeTimers = [];

function startVibe() {
  if (!isVibeOn() || !canVibrate() || vibeInterval) return;
  const cycleMs = 1700;
  const landMs = [986, 1186, 1386]; // 소리와 같은 박자(돌이 떨어지는 시점)
  const run = () => {
    landMs.forEach((ms) => vibeTimers.push(setTimeout(() => { try { navigator.vibrate(35); } catch {} }, ms)));
  };
  run();
  vibeInterval = setInterval(run, cycleMs);
}

function stopVibe() {
  if (vibeInterval) { clearInterval(vibeInterval); vibeInterval = null; }
  vibeTimers.forEach(clearTimeout);
  vibeTimers = [];
  if (canVibrate()) { try { navigator.vibrate(0); } catch {} }
}

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
  startVibe(); // 진동은 소리 설정과 별개다 (소리를 꺼도 진동만 쓸 수 있다)
  if (!isSoundOn()) return; // 소리를 끈 사용자는 아무 소리도 재생하지 않는다
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
  stopVibe();
  if (intervalId) { clearInterval(intervalId); intervalId = null; }
  stopPad();
}
