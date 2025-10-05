import { PointerLockControls } from 'PointerLockControls';
import { now, isMobile } from './utils.js';
import { ui } from './ui.js';

export class Input {
  constructor(sceneMgr) {
    this.sceneMgr = sceneMgr;
    const canvas = sceneMgr.renderer?.domElement || document.querySelector('canvas');

    this.controls = new PointerLockControls(sceneMgr.dolly, document.body);
    this.m = { f:false,b:false,l:false,r:false, run:false, crouch:false, jump:false };

    // Only lock on canvas clicks (desktop)
    const shouldLock = (e) => {
      if (isMobile) return false;
      if (sceneMgr.renderer.xr.isPresenting) return false;
      if (ui.menuPane && ui.menuPane.style.display === 'block') return false;
      const path = e.composedPath?.() || [];
      return path.includes(canvas) || e.target === canvas;
    };
    document.body.addEventListener('click', (e) => {
      if (shouldLock(e)) this.controls.lock();
    });

    addEventListener('keydown', e => this._k(e, true));
    addEventListener('keyup',   e => this._k(e, false));

    // ------------- Mobile swipe (canvas-only) -------------
    this.touch = { active:false, x0:0, y0:0, t0:0, dxNorm:0, dyNorm:0, pointerId:null };
    const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
    const MAXD = 200, SWIPE_MIN = 80, SWIPE_MS = 250;

    if (canvas) {
      // Ensure the browser does NOT convert touches into page scroll on this element
      // (do this in JS so it wins against late-loading CSS)
      canvas.style.touchAction = 'none';
      canvas.style.webkitUserSelect = 'none'; // iOS: avoid text selection long-press
      canvas.style.userSelect = 'none';

      // Prefer Pointer Events
      const onPointerDown = (e) => {
        if (!isMobile) return;
        if (e.pointerType !== 'touch' && e.pointerType !== 'pen') return;

        this.touch.active = true;
        this.touch.pointerId = e.pointerId;
        this.touch.x0 = e.clientX; this.touch.y0 = e.clientY; this.touch.t0 = now();
        this.touch.dxNorm = 0; this.touch.dyNorm = 0;

        // Capture so we keep receiving move/up even if finger leaves the canvas
        try { canvas.setPointerCapture(e.pointerId); } catch {}
      };

      const onPointerMove = (e) => {
        if (!isMobile) return;
        if (!this.touch.active || e.pointerId !== this.touch.pointerId) return;

        let dx = e.clientX - this.touch.x0;
        let dy = e.clientY - this.touch.y0;
        dx = clamp(dx, -MAXD, MAXD);
        dy = clamp(dy, -MAXD, MAXD);

        this.touch.dxNorm = dx / MAXD;
        this.touch.dyNorm = dy / MAXD;

        // Prevent page scroll while the gesture that began on the canvas is active
        e.preventDefault();
      };

      const endGesture = () => {
        if (!this.touch.active) return;
        const dt = now() - this.touch.t0;
        const dyEnd = this.touch.dyNorm * MAXD;
        if ((-dyEnd) > SWIPE_MIN && dt < SWIPE_MS) this.m.jump = true;
        this.touch.active = false;
        this.touch.pointerId = null;
        this.touch.dxNorm = 0;
        this.touch.dyNorm = 0;
      };

      const onPointerUp = (e) => {
        if (!isMobile) return;
        if (e.pointerId !== this.touch.pointerId) return;
        endGesture();
        try { canvas.releasePointerCapture(e.pointerId); } catch {}
        e.preventDefault();
      };

      const onPointerCancel = (e) => {
        if (e.pointerId !== this.touch.pointerId) return;
        endGesture();
        try { canvas.releasePointerCapture(e.pointerId); } catch {}
      };

      canvas.addEventListener('pointerdown', onPointerDown, { passive: true });
      canvas.addEventListener('pointermove', onPointerMove, { passive: false });
      canvas.addEventListener('pointerup', onPointerUp, { passive: false });
      canvas.addEventListener('pointercancel', onPointerCancel, { passive: true });

      // --- Fallback for older browsers without Pointer Events ---
      if (!('onpointerdown' in window)) {
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
          this.touch.dyNorm = dy / MAXD;
          e.preventDefault();
        };
        const onEnd = () => {
          if (!isMobile || !this.touch.active) return;
          const dt = now() - this.touch.t0;
          const dyEnd = this.touch.dyNorm * MAXD;
          if ((-dyEnd) > SWIPE_MIN && dt < SWIPE_MS) this.m.jump = true;
          this.touch.active = false;
          this.touch.dxNorm = 0; this.touch.dyNorm = 0;
        };

        canvas.addEventListener('touchstart', onStart, { passive: true });
        canvas.addEventListener('touchmove',  onMove,  { passive: false });
        canvas.addEventListener('touchend',   onEnd,   { passive: true });
        canvas.addEventListener('touchcancel', onEnd,  { passive: true });
      }
    }
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
