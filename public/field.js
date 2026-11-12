/* ProofOfMass — live gravitational field (canvas). The landing spectacle.
 * All masses float in one field, sized by mass, the alpha dominant. Ambient
 * drift + occasional "absorb" pulse keep it alive. Hover swells + labels; click
 * opens the agent. No deps; tuned to stay light on a 2-vCPU box. */
(function () {
  'use strict';
  var clamp = function (x, a, b) { return Math.max(a, Math.min(b, x)); };

  function POMField(canvas) {
    this.c = canvas; this.ctx = canvas.getContext('2d');
    this.bodies = []; this.scaleMax = 1; this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.mouse = { x: -1e4, y: -1e4 }; this.hover = null; this.raf = null; this.t = 0;
    this.shock = []; this.onSelectCb = null; this.nextMerge = 6000 + Math.random() * 6000;
    this._bind();
  }
  POMField.prototype._bind = function () {
    var self = this;
    this._resize = function () {
      var r = self.c.getBoundingClientRect();
      self.W = r.width; self.H = r.height;
      self.c.width = r.width * self.dpr; self.c.height = r.height * self.dpr;
      self.ctx.setTransform(self.dpr, 0, 0, self.dpr, 0, 0);
    };
    window.addEventListener('resize', this._resize);
    this.c.addEventListener('mousemove', function (e) {
      var r = self.c.getBoundingClientRect(); self.mouse.x = e.clientX - r.left; self.mouse.y = e.clientY - r.top;
    });
    this.c.addEventListener('mouseleave', function () { self.mouse.x = -1e4; self.mouse.y = -1e4; });
    this.c.addEventListener('click', function () {
      if (self.hover && self.onSelectCb) self.onSelectCb(self.hover.id);
    });
  };
  POMField.prototype.onSelect = function (fn) { this.onSelectCb = fn; return this; };

  POMField.prototype.setAgents = function (agents, scaleMax) {
    this._resize();
    this.scaleMax = scaleMax || (agents[0] && agents[0].mass) || 1;
    var self = this, W = this.W || 900, H = this.H || 600;
    var maxR = Math.min(W, H) * 0.34;
    var prev = {}; this.bodies.forEach(function (b) { prev[b.id] = b; });
    this.bodies = agents.map(function (a, i) {
      var ratio = clamp(a.mass / self.scaleMax, 0, 1);
      var baseR = Math.max(10, maxR * Math.sqrt(ratio));
      var p = prev[a.id];
      var ang = (i / Math.max(1, agents.length)) * Math.PI * 2;
      return {
        id: a.id, handle: a.x_handle, mass: a.mass, vitality: a.vitality || 0,
        isAlpha: !!a.is_alpha, cls: a.class || 1, baseR: baseR, r: baseR,
        x: p ? p.x : W / 2 + Math.cos(ang) * (W * 0.22) + (Math.random() - 0.5) * 40,
        y: p ? p.y : H / 2 + Math.sin(ang) * (H * 0.22) + (Math.random() - 0.5) * 40,
        vx: p ? p.vx : (Math.random() - 0.5) * 8, vy: p ? p.vy : (Math.random() - 0.5) * 8,
        phase: Math.random() * Math.PI * 2
      };
    });
  };

  POMField.prototype._step = function (dt) {
    var W = this.W, H = this.H, cx = W / 2, cy = H / 2, B = this.bodies;
    for (var i = 0; i < B.length; i++) {
      var b = B[i];
      // weak pull to center (alpha pulled hardest → sits central)
      var k = b.isAlpha ? 0.9 : 0.42;
      b.vx += (cx - b.x) * k * dt; b.vy += (cy - b.y) * k * dt;
      // soft mutual repulsion so discs don't fully overlap
      for (var j = i + 1; j < B.length; j++) {
        var o = B[j], dx = b.x - o.x, dy = b.y - o.y, d = Math.hypot(dx, dy) || 1;
        var min = (b.r + o.r) * 0.86;
        if (d < min) {
          var f = (min - d) / min * 34;
          var ux = dx / d, uy = dy / d;
          b.vx += ux * f * dt; b.vy += uy * f * dt; o.vx -= ux * f * dt; o.vy -= uy * f * dt;
        }
      }
      b.vx *= 0.92; b.vy *= 0.92;
      b.x += b.vx * dt * 6; b.y += b.vy * dt * 6;
      var pad = b.r + 6;
      if (b.x < pad) { b.x = pad; b.vx = Math.abs(b.vx) * 0.5; }
      if (b.x > W - pad) { b.x = W - pad; b.vx = -Math.abs(b.vx) * 0.5; }
      if (b.y < pad) { b.y = pad; b.vy = Math.abs(b.vy) * 0.5; }
      if (b.y > H - pad) { b.y = H - pad; b.vy = -Math.abs(b.vy) * 0.5; }
    }
    // hover test (nearest body under cursor)
    this.hover = null;
    for (var h = 0; h < B.length; h++) {
      var bb = B[h];
      if (Math.hypot(this.mouse.x - bb.x, this.mouse.y - bb.y) < bb.r + 4) { this.hover = bb; break; }
    }
    this.c.style.cursor = this.hover ? 'pointer' : 'default';
  };

  // ambient "absorb" pulse — two masses drift together and the larger pulses.
  POMField.prototype._ambient = function (dtms) {
    this.nextMerge -= dtms;
    if (this.nextMerge > 0 || this.bodies.length < 2) return;
    this.nextMerge = 9000 + Math.random() * 8000;
    var B = this.bodies, small = B[Math.floor(Math.random() * B.length)];
    var big = null, bd = 1e9;
    for (var i = 0; i < B.length; i++) if (B[i] !== small && B[i].mass >= small.mass) {
      var d = Math.hypot(B[i].x - small.x, B[i].y - small.y); if (d < bd) { bd = d; big = B[i]; }
    }
    if (!big) return;
    small.vx += (big.x - small.x) * 0.5; small.vy += (big.y - small.y) * 0.5;
    this.shock.push({ x: big.x, y: big.y, r: big.r, life: 1, tgt: big });
  };

  POMField.prototype._drawBody = function (b, t) {
    var ctx = this.ctx, v = clamp(b.vitality, 0, 1);
    var breathe = 1 + 0.03 * Math.sin(t * (1.2 + v) + b.phase);
    var hovered = this.hover === b;
    var r = b.r * breathe * (hovered ? 1.08 : 1);
    var sat = 24 + 46 * v, light = 50 + 34 * v;
    var core = b.isAlpha ? '#ffffff' : 'hsl(192,' + sat + '%,' + light + '%)';
    var edge = b.isAlpha ? 'hsl(205,30%,46%)' : 'hsl(192,' + sat + '%,' + (light * 0.42) + '%)';
    var rim = b.isAlpha ? 'hsl(44,92%,72%)' : 'hsl(192,' + clamp(sat + 12, 0, 92) + '%,' + clamp(light + 16, 0, 96) + '%)';
    // glow
    var g = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, r * 2.1);
    g.addColorStop(0, rim); g.addColorStop(0.4, rim); g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.globalAlpha = 0.10 + 0.5 * v; ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(b.x, b.y, r * 2.1, 0, 7); ctx.fill(); ctx.globalAlpha = 1;
    // disc
    var cg = ctx.createRadialGradient(b.x - r * 0.3, b.y - r * 0.35, r * 0.1, b.x, b.y, r);
    cg.addColorStop(0, core); cg.addColorStop(0.62, core); cg.addColorStop(1, edge);
    ctx.fillStyle = cg; ctx.beginPath(); ctx.arc(b.x, b.y, r, 0, 7); ctx.fill();
    // class rings
    var fr = [0.74, 0.52, 0.32];
    ctx.strokeStyle = b.isAlpha ? '#fff' : rim; ctx.globalAlpha = 0.18 + 0.1 * v; ctx.lineWidth = 1;
    for (var i = 0; i < b.cls - 1 && i < fr.length; i++) { ctx.beginPath(); ctx.arc(b.x, b.y, r * fr[i], 0, 7); ctx.stroke(); }
    ctx.globalAlpha = 1;
    // alpha halo
    if (b.isAlpha) {
      ctx.strokeStyle = rim; ctx.globalAlpha = 0.6; ctx.setLineDash([2, 7]); ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(b.x, b.y, r * 1.22, 0, 7); ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
    }
    // label (hover, or alpha always)
    if (hovered || b.isAlpha) {
      ctx.font = (b.isAlpha ? '600 ' : '') + '13px ui-monospace,monospace';
      ctx.fillStyle = b.isAlpha ? '#ffd27a' : '#e9eef7'; ctx.textAlign = 'center';
      ctx.fillText('@' + b.handle + '  ' + b.mass, b.x, b.y + r + 20);
    }
  };

  POMField.prototype._frame = function (now) {
    var self = this; if (!this.last) this.last = now;
    var dtms = Math.min(50, now - this.last); this.last = now; this.t += dtms / 1000;
    var dt = dtms / 1000;
    this._step(dt); this._ambient(dtms);
    var ctx = this.ctx;
    ctx.clearRect(0, 0, this.W, this.H);
    // shockwaves
    for (var s = this.shock.length - 1; s >= 0; s--) {
      var sh = this.shock[s]; sh.life -= dt * 1.6;
      if (sh.life <= 0) { if (sh.tgt) sh.tgt.r = sh.tgt.baseR; this.shock.splice(s, 1); continue; }
      if (sh.tgt) sh.tgt.r = sh.tgt.baseR * (1 + 0.18 * sh.life);
      ctx.strokeStyle = 'rgba(111,242,255,' + (sh.life * 0.5) + ')'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(sh.x, sh.y, sh.r * (1 + (1 - sh.life) * 1.6), 0, 7); ctx.stroke();
    }
    for (var i = 0; i < this.bodies.length; i++) this._drawBody(this.bodies[i], this.t);
    this.raf = requestAnimationFrame(function (n) { self._frame(n); });
  };
  POMField.prototype.start = function () { if (!this.raf) { this.last = 0; var s = this; this.raf = requestAnimationFrame(function (n) { s._frame(n); }); } };
  POMField.prototype.stop = function () { if (this.raf) cancelAnimationFrame(this.raf); this.raf = null; };

  window.POMField = POMField;
})();
