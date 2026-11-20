// Turns modifier changes into the notch gestures (docs/notch-zustaende.md):
//   hold key held          = dictate          hold key twice    = dictate hands-free until the next tap
//   Control + Option held  = talk to Studymut  Control twice     = talk hands-free until the next tap
// The hold key is fn on macOS and Right Alt on Windows and Linux, where fn never reaches software. fn is only
// ever dictation; the agent lives on Control and Option, as in HeyClicky.
// A lock never outlasts its recording (14.11.2026: a stale one swallowed Control + Option and looked like a hang):
// LOCK_MAXIMUM, and release() from the caller. Hands-free shows a pill with cancel and done (ui/notch.js).
// Pure state machine: the caller feeds flag changes, key downs and timer ticks with timestamps in seconds.
// 'arm' comes the moment a gesture can begin, so the microphone opens at once and the first word is kept
// (as in Wispr Flow and Coucou); 'disarm' drops that audio when it turned out to be a tap or a shortcut.

export const HOLD_DELAY = 0.22;
export const TAP_MAXIMUM = 0.3;
export const DOUBLE_TAP_WINDOW = 0.4;
// A recording ends by itself after two minutes (ui/notch.js); a lock older than that is stale.
export const LOCK_MAXIMUM = 125;

const anyFlag = f => f.hold || f.control || f.option || f.other;
const only = (f, ...keys) => ['hold', 'control', 'option', 'other'].every(key => !!f[key] === keys.includes(key));

export class KeyChord {
  // talk: false leaves Control and Option to the Mac (an app that only dictates).
  constructor({talk = true} = {}) {
    this.talk = talk;
    this.state = {name: 'idle'};
    this.flags = {hold: false, control: false, option: false, other: false};
    this.taps = {hold: null, control: null}; // a single key pressed alone: {down, last}
    // VoiceOver owns Control + Option; then talking needs Shift as well (⌃⌥⇧).
    this.voiceOver = false;
  }

  get capturing() { return this.state.name === 'capturing' || this.state.name === 'locked'; }

  // flags: {hold, control, option, other}. `other` = Command/Meta or Shift: a normal shortcut.
  flagsChanged(next, time) {
    const old = this.flags;
    const now = {hold: !!next.hold, control: !!next.control, option: !!next.option, other: !!next.other};
    this.flags = now;
    const tap = this.#trackTaps(old, now, time);
    if (this.state.name === 'locked' && time - this.state.since > LOCK_MAXIMUM) this.state = {name: 'idle'};
    const s = this.state;

    if (s.name === 'locked') {
      // Hands-free ends with one more tap of fn or Control; other keys are ordinary typing.
      if (tap === 'hold' || tap === 'control') { this.state = {name: 'idle'}; return {type: 'finish', mode: s.mode}; }
      return {type: 'none'};
    }
    if (tap === 'hold-double') { this.state = {name: 'locked', mode: 'dictate', since: time}; return {type: 'begin', mode: 'dictate', locked: true}; }
    if (tap === 'control-double' && this.talk) { this.state = {name: 'locked', mode: 'talk', since: time}; return {type: 'begin', mode: 'talk', locked: true}; }
    if (s.name === 'blocked') {
      if (!anyFlag(now)) this.state = {name: 'idle'};
      return {type: 'none'};
    }
    const talk = this.talk && (this.voiceOver ? only(now, 'control', 'option', 'other') : only(now, 'control', 'option'));
    const chord = only(now, 'hold') ? 'dictate' : talk ? 'talk' : null;
    if (s.name === 'idle') {
      if (!chord) return {type: 'none'};
      this.state = {name: 'armed', mode: chord, since: time};
      return {type: 'arm', mode: chord, deadline: time + HOLD_DELAY};
    }
    if (s.name === 'armed') {
      if (chord === s.mode) return {type: 'none'};
      this.state = {name: anyFlag(now) ? 'blocked' : 'idle'};
      return {type: 'disarm'};
    }
    // capturing: letting go of the chord finishes; adding another modifier makes it a shortcut.
    if (chord === s.mode) return {type: 'none'};
    const released = s.mode === 'dictate' ? !now.hold : !(now.control && now.option);
    const extra = s.mode === 'dictate' ? (now.control || now.option || now.other) : (now.hold || (now.other && !this.voiceOver));
    this.state = {name: anyFlag(now) ? 'blocked' : 'idle'};
    return released && !extra ? {type: 'finish', mode: s.mode} : {type: 'cancel'};
  }

  tick(time) {
    const s = this.state;
    if (s.name !== 'armed' || time - s.since < HOLD_DELAY - 0.01) return {type: 'none'};
    this.state = {name: 'capturing', mode: s.mode};
    return {type: 'begin', mode: s.mode};
  }

  // Any non-modifier key: fn + arrow and Control + letter are shortcuts, not gestures.
  keyDown() {
    this.taps = {hold: null, control: null};
    if (this.state.name === 'locked') return {type: 'none'};
    if (this.state.name === 'armed') { this.state = {name: 'blocked'}; return {type: 'disarm'}; }
    if (this.state.name === 'capturing') { this.state = {name: 'blocked'}; return {type: 'cancel'}; }
    return {type: 'none'};
  }

  // Hands-free talk started without keys ("Hey Studymut"), and its end once the person stopped speaking.
  lockTalk(time = 0) {
    if (this.state.name !== 'idle' && this.state.name !== 'blocked') return {type: 'none'};
    this.state = {name: 'locked', mode: 'talk', since: time};
    return {type: 'begin', mode: 'talk', locked: true, wake: true};
  }
  finishLocked() {
    if (this.state.name !== 'locked') return {type: 'none'};
    const mode = this.state.mode;
    this.state = {name: 'idle'};
    return {type: 'finish', mode};
  }

  // The recording behind a lock is over (its time ran out, the notch went to rest): the keys are free again.
  // Says nothing to the caller, who already knows.
  release(mode = null) {
    if (this.state.name === 'locked' && (!mode || this.state.mode === mode)) this.state = {name: anyFlag(this.flags) ? 'blocked' : 'idle'};
  }

  // Escape or an explicit stop from the UI.
  cancel() {
    const wasCapturing = this.capturing;
    this.state = {name: anyFlag(this.flags) ? 'blocked' : 'idle'};
    return wasCapturing ? {type: 'cancel'} : {type: 'none'};
  }

  // Taps of fn or Control pressed alone and released quickly. Returns 'hold' or 'control' for a single
  // tap, 'hold-double' or 'control-double' when it completes a double tap, otherwise null.
  #trackTaps(old, now, time) {
    for (const key of ['hold', 'control']) {
      const tap = this.taps[key] ?? (this.taps[key] = {down: null, last: null});
      const alone = only(now, key);
      if (now[key] && !old[key]) { tap.down = alone ? time : null; continue; }
      if (now[key] && !alone) { tap.down = null; tap.last = null; continue; }
      if (!now[key] && old[key]) {
        const down = tap.down;
        tap.down = null;
        if (down === null || anyFlag(now) || time - down > TAP_MAXIMUM) { tap.last = null; continue; }
        if (tap.last !== null && time - tap.last <= DOUBLE_TAP_WINDOW && this.state.name !== 'locked') { tap.last = null; return `${key}-double`; }
        tap.last = time;
        return key;
      }
    }
    return null;
  }
}
