// Plays the looping alarm with the Web Audio API. Controlled by background.js messages.
'use strict';

const LOOKAHEAD_S = 5;   // how far ahead tones are scheduled
const TICK_MS = 1000;    // scheduler interval

let ctx = null;
let master = null;
let timer = null;
let sound = null;
let nextTime = 0;

function tone(freq, start, dur, level) {
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = 'square';
  osc.frequency.value = freq;
  g.gain.setValueAtTime(0, start);
  g.gain.linearRampToValueAtTime(level, start + 0.01);
  g.gain.setValueAtTime(level, start + dur - 0.015);
  g.gain.linearRampToValueAtTime(0, start + dur);
  osc.connect(g);
  g.connect(master);
  osc.start(start);
  osc.stop(start + dur + 0.02);
}

// Each pattern schedules one cycle at time t and returns the cycle length in seconds.
const PATTERNS = {
  // new ticket: two-tone siren, 880 / 1320 Hz every 350 ms
  new(t) {
    for (let i = 0; i < 4; i++) tone(i % 2 ? 1320 : 880, t + i * 0.35, 0.35, 0.8);
    return 1.4;
  },
  // monitoring lost: slow low triple-beep, then a pause
  lost(t) {
    for (let i = 0; i < 3; i++) tone(330, t + i * 0.3, 0.15, 0.8);
    return 2.4;
  },
};

function schedule() {
  if (!ctx || !sound) return;
  while (nextTime < ctx.currentTime + LOOKAHEAD_S) nextTime += PATTERNS[sound](nextTime);
}

function stop() {
  clearInterval(timer);
  timer = null;
  sound = null;
  if (ctx) {
    ctx.close().catch(() => {});
    ctx = null;
    master = null;
  }
}

async function play(kind, volume) {
  if (sound === kind && ctx) {
    setVolume(volume);
    if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
    return ctx.state;
  }
  stop();
  ctx = new AudioContext();
  master = ctx.createGain();
  master.gain.value = volume;
  const comp = ctx.createDynamicsCompressor(); // keeps max volume loud without clipping
  master.connect(comp);
  comp.connect(ctx.destination);
  sound = kind;
  await ctx.resume().catch(() => {});
  nextTime = ctx.currentTime + 0.05;
  schedule();
  timer = setInterval(schedule, TICK_MS);
  return ctx.state;
}

function setVolume(v) {
  if (master) master.gain.setTargetAtTime(v, ctx.currentTime, 0.02);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return;
  if (msg.cmd === 'play') {
    play(msg.sound, msg.volume).then((audio) => sendResponse({ ok: true, audio }));
    return true;
  }
  if (msg.cmd === 'volume') {
    setVolume(msg.volume);
    sendResponse({ ok: true });
  } else if (msg.cmd === 'stop') {
    stop();
    sendResponse({ ok: true });
  }
});
