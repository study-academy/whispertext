// Shared intent timings are milliseconds; visual animations remain independently short.
export const NOTCH_TIMINGS = Object.freeze({hoverDwell: 500, leaveDelay: 160, hapticCooldown: 500});

// Pure intent machine. Feed the union of the trigger/card hit regions, not individual DOM leaves.
// The owner calls tick from its existing pointer loop. No hidden timers survive a state change.
export class HoverIntent {
  constructor() {
    this.mode = 'rest';
    this.inside = false;
    this.protected = false;
    this.deadline = null;
  }
  get state() { return {mode: this.mode, deadline: this.deadline}; }
  pointer(inside, now) {
    if (inside === this.inside) return this.tick(now);
    this.inside = inside;
    this.deadline = inside
      ? (this.mode === 'rest' ? now + NOTCH_TIMINGS.hoverDwell : null)
      : (this.mode !== 'rest' && !this.protected ? now + NOTCH_TIMINGS.leaveDelay : null);
    return this.state;
  }
  tick(now) {
    if (this.deadline === null || now < this.deadline) return this.state;
    this.deadline = null;
    if (this.inside && this.mode === 'rest') this.mode = 'peek';
    else if (!this.inside && !this.protected) this.mode = 'rest';
    return this.state;
  }
  openFull() { this.mode = 'full'; this.deadline = null; return this.state; }
  setProtected(protectedState, now) {
    this.protected = !!protectedState;
    this.deadline = this.protected || this.inside || this.mode === 'rest' ? null : now + NOTCH_TIMINGS.leaveDelay;
    return this.state;
  }
  dismiss() { this.mode = 'rest'; this.deadline = null; return this.state; }
}
