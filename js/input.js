import { PointerLockControls } from 'PointerLockControls';
import { now, isMobile } from './utils.js';

export class Input {
  constructor(sceneMgr) {
    this.sceneMgr = sceneMgr;
    this.controls = new PointerLockControls(sceneMgr.dolly, document.body);
    this.m = { f:false,b:false,l:false,r:false, run:false, crouch:false, jump:false };

    document.body.addEventListener('click', () => {
      if (!sceneMgr.renderer.xr.isPresenting && !isMobile) this.controls.lock();
    });

    addEventListener('keydown', e => this._k(e, true));
    addEventListener('keyup',   e => this._k(e, false));

    // Mobile touch → world X/Z + swipe jump
    this.touch = { active:false, x0:0, y0:0, t0:0, dxNorm:0, dyNorm:0 };
    const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
    const MAXD = 200, SWIPE_MIN = 80, SWIPE_MS = 250;

    const onStart = (e) => {
      if (!isMobile) return;
      const t = e.touches[0];
      this.touch.active = true;
      this.touch.x0 = t.clientX; this.touch.y0 = t.clientY; this.touch.t0 = now();
      this.touch.dxNorm = 0; this.touch.dyNorm = 0;
    };
    const onMove = (e) => {
      if (!isMobile || !this.touch.active) return;
      const t = e.touches[0];
      let dx = t.clientX - this.touch.x0, dy = t.clientY - this.touch.y0;
      dx = clamp(dx, -MAXD, MAXD); dy = clamp(dy, -MAXD, MAXD);
      this.touch.dxNorm = dx / MAXD;
      this.touch.dyNorm = dy / MAXD;   // +down, -up
      e.preventDefault();
    };
    const onEnd = () => {
      if (!isMobile || !this.touch.active) return;
      const dt = now() - this.touch.t0;
      const dyEnd = this.touch.dyNorm * MAXD;
      if ((-dyEnd) > SWIPE_MIN && dt < SWIPE_MS) this.m.jump = true; // fast upward flick
      this.touch.active = false; this.touch.dxNorm = 0; this.touch.dyNorm = 0;
    };

    window.addEventListener('touchstart', onStart, { passive: true });
    window.addEventListener('touchmove',  onMove,  { passive: false });
    window.addEventListener('touchend',   onEnd,   { passive: true });
  }

  _k(e, d) {
    switch (e.code) {
      case 'ArrowUp': case 'KeyW': this.m.f = d; break;
      case 'ArrowDown': case 'KeyS': this.m.b = d; break;
      case 'ArrowLeft': case 'KeyA': this.m.l = d; break;
      case 'ArrowRight': case 'KeyD': this.m.r = d; break;
      case 'ShiftLeft': case 'ShiftRight': this.m.run = d; break;
      case 'ControlLeft': case 'ControlRight': this.m.crouch = d; break;
      case 'Space': if (d) this.m.jump = true; break;
    }
  }
  consumeJump(){ const j = this.m.jump; this.m.jump = false; return j; }
}
