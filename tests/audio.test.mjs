/* Audio engine checks.

   There is no sound card in CI, so we drive `Audio` with a strict fake
   AudioContext: every node is a proxy that throws the moment code calls a
   parameter method (setValueAtTime &c.) on the *node* instead of on its
   `.gain` / `.frequency` / `.pan` parameter. That is exactly the class of bug
   that silences the whole game on a real device, and it cannot be caught by a
   loose stub that happily returns `undefined`.                              */
import { Audio, NULL_AUDIO, SOUND_NAMES } from '../src/game/audio.js';

let pass = 0;
const fails = [];
const check = (name, fn) => {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fails.push(name + ': ' + (e && e.message)); console.log('  FAIL ' + name + ' — ' + (e && e.message)); }
};
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };

const PARAM_METHODS = ['setValueAtTime', 'linearRampToValueAtTime', 'exponentialRampToValueAtTime',
  'setTargetAtTime', 'setValueCurveAtTime', 'cancelScheduledValues', 'cancelAndHoldAtTime'];

function fakeParam(value = 0, calls = null, label = 'param') {
  const p = { defaultValue: value, automationRate: 'a-rate' };
  let v = value;
  Object.defineProperty(p, 'value', {
    get: () => v,
    set: (nv) => { v = nv; if (calls) calls.push(label + '.value=' + nv); }
  });
  for (const m of PARAM_METHODS) {
    p[m] = (...args) => {
      if (calls) calls.push(label + '.' + m + '(' + args.map((a) => (typeof a === 'number' ? a.toFixed(3) : String(a))).join(',') + ')');
      return p;
    };
  }
  return p;
}

function fakeNode(kind, ctx, calls) {
  const node = {
    kind,
    connect(dest) { assert(dest && dest.kind, `${kind}.connect() must receive a node`); return dest; },
    disconnect() {},
    start(t) { assert(Number.isFinite(t) || t === undefined, `${kind}.start(${t}) is not a time`); calls.push(kind + '.start'); },
    stop(t) { assert(Number.isFinite(t) || t === undefined, `${kind}.stop(${t}) is not a time`); calls.push(kind + '.stop'); }
  };
  if (kind === 'gain') node.gain = fakeParam(1, calls, 'gain');
  if (kind === 'osc' || kind === 'filter') {
    node.frequency = fakeParam(kind === 'osc' ? 440 : 350, calls, kind + '.frequency');
    node.detune = fakeParam(0, calls, 'detune');
    node.Q = fakeParam(1, calls, 'Q');
    node.type = kind === 'osc' ? 'sine' : 'lowpass';
  }
  if (kind === 'panner') node.pan = fakeParam(0, calls, 'pan');
  if (kind === 'comp') {
    for (const p of ['threshold', 'knee', 'ratio', 'attack', 'release']) node[p] = fakeParam(1, calls, 'comp.' + p);
  }
  if (kind === 'src') { node.buffer = null; node.loop = false; }
  // Calling an AudioParam method on the node itself must blow up.
  for (const m of PARAM_METHODS) {
    node[m] = () => { throw new Error(`${kind}.${m}() called on the node — use .gain/.frequency/.pan`); };
  }
  return node;
}

function fakeContext(calls) {
  const ctx = {
    kind: 'ctx',
    currentTime: 10,
    sampleRate: 48000,
    state: 'running',
    destination: { kind: 'dest', connect() {}, disconnect() {} },
    resume() { ctx.state = 'running'; },
    suspend() { ctx.state = 'suspended'; },
    createGain: () => fakeNode('gain', ctx, calls),
    createOscillator: () => fakeNode('osc', ctx, calls),
    createBiquadFilter: () => fakeNode('filter', ctx, calls),
    createStereoPanner: () => fakeNode('panner', ctx, calls),
    createDynamicsCompressor: () => fakeNode('comp', ctx, calls),
    createBufferSource: () => fakeNode('src', ctx, calls),
    createBuffer(channels, len, rate) {
      assert(channels === 1 && len > 0 && rate > 0, 'createBuffer arguments');
      const data = new Float32Array(len);
      return { numberOfChannels: channels, length: len, sampleRate: rate, getChannelData: () => data };
    }
  };
  return ctx;
}

function withFakeWindow(fn) {
  const calls = [];
  const prevWindow = globalThis.window;
  globalThis.window = { AudioContext: function FakeAC() { return fakeContext(calls); } };
  const prevInterval = globalThis.setInterval;
  const intervals = [];
  globalThis.setInterval = (f, ms) => { intervals.push(f); return intervals.length; };
  const prevClear = globalThis.clearInterval;
  globalThis.clearInterval = () => {};
  try { return fn(calls, intervals); }
  finally {
    globalThis.window = prevWindow;
    globalThis.setInterval = prevInterval;
    globalThis.clearInterval = prevClear;
  }
}

check('unlock() builds a working graph', () => withFakeWindow((calls) => {
  const a = new Audio();
  a.unlock();
  assert(a.ready, 'audio should be ready');
  assert(a.master && a.sfxGain && a.musicGain, 'gain stages missing');
  assert(a.noiseBuffer && a.noiseBuffer.length > 1000, 'noise buffer not generated');
  assert(calls.some((c) => c.startsWith('gain.value=')), 'gain stages not initialised');
  a.stopMusic();
}));

check('unlock() is idempotent and resumes a suspended context', () => withFakeWindow(() => {
  const a = new Audio();
  a.unlock();
  const ctx = a.ctx;
  ctx.state = 'suspended';
  a.unlock();
  assert(a.ctx === ctx && ctx.state === 'running', 'second unlock must resume, not rebuild');
  a.stopMusic();
}));

check(`every sound renders (${SOUND_NAMES.length} names)`, () => withFakeWindow((calls) => {
  const a = new Audio();
  a.unlock();
  a.stopMusic();
  for (const name of SOUND_NAMES) {
    calls.length = 0;
    a.lastPlay.clear();
    a.play(name);
    assert(calls.some((c) => c.startsWith('gain.setValueAtTime')), `${name} produced no envelope`);
  }
  // unknown names must fall back, not throw
  a.lastPlay.clear();
  a.play('no-such-sound');
}));

check('spatial playback attenuates, pans and mutes far-away sources', () => withFakeWindow(() => {
  const a = new Audio();
  a.unlock();
  a.lastPlay.clear();
  a.setListener(0, 0, 0);
  a.listener.yaw = Math.PI / 2;
  let panned = 0;
  const realPanner = a.ctx.createStereoPanner;
  a.ctx.createStereoPanner = () => { panned++; return realPanner(); };
  a.play('sword', { x: 3, z: 1 });
  assert(panned === 1, 'near source should be panned');
  a.lastPlay.clear();
  a.play('sword', { x: 900, z: 900 });
  assert(panned === 1, 'distant source should be culled before panning');
}));

check('rate limiting suppresses bursts of the same sound', () => withFakeWindow((calls) => {
  const a = new Audio();
  a.unlock();
  a.lastPlay.clear();
  a.play('death');
  const after = calls.length;
  for (let i = 0; i < 40; i++) a.play('death');
  assert(calls.length === after, '40 deaths in one instant should be throttled to one');
}));

check('music starts, breathes, updates and stops cleanly', () => withFakeWindow((calls, intervals) => {
  const a = new Audio();
  a.unlock();
  assert(a.musicOn, 'music should auto-start after unlock');
  assert(a.drones && a.drones.length === 3, 'three drones expected');
  assert(intervals.length === 1, 'one breath timer expected');
  intervals[0]();                       // run the filter-breathing callback
  a.musicTimer = 0;
  calls.length = 0;
  a.update(0.016);
  assert(calls.some((c) => c.startsWith('gain.linearRampToValueAtTime')), 'pluck envelope missing');
  assert(calls.some((c) => c.startsWith('osc.frequency')));
  a.musicOn = false;
  a.update(1);                          // must be a no-op when stopped
  a.setMusic(false);
  a.stopMusic();
  assert(!a.drones, 'drones not released');
}));

check('update() before unlock is a no-op', () => {
  const a = new Audio();
  a.update(1);
  a.play('click');
  a.setListener(1, 2, 3);
  a.setMusic(true);
  assert(!a.ready && !a.musicOn);
});

check('toggling enabled / music changes the output gains', () => withFakeWindow((calls) => {
  const a = new Audio();
  a.unlock();
  const calls0 = calls.length;
  a.setEnabled(false);
  assert(calls.some((c, i) => i >= calls0 && c.startsWith('gain.setTargetAtTime(0.000')), 'muting was not scheduled');
  const calls1 = calls.length;
  a.setEnabled(true);
  assert(calls.some((c, i) => i >= calls1 && c.startsWith('gain.setTargetAtTime(0.850')), 'unmute was not scheduled');
  a.setMusic(false);
  a.setMusic(true);
  a.suspend();
  a.resume();
}));

check('NULL_AUDIO implements the whole surface', () => {
  for (const m of ['play', 'unlock', 'setEnabled', 'setMusic', 'setListener', 'startMusic', 'stopMusic', 'update', 'resume', 'suspend']) {
    assert(typeof NULL_AUDIO[m] === 'function', 'NULL_AUDIO.' + m + ' missing');
  }
  NULL_AUDIO.play('click');
  NULL_AUDIO.update(0.016);
});

if (fails.length) {
  console.error('\nAUDIO CHECKS FAILED\n' + fails.map((f) => ' - ' + f).join('\n'));
  process.exit(1);
}
console.log(`\nAUDIO CHECKS PASSED (${pass})`);
