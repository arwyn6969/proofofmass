/*
 * ProofOfMass — canonical mass-visual generator (shared-visual.js)
 * ----------------------------------------------------------------
 * SINGLE SOURCE OF TRUTH for the visual language. Runs identically in:
 *   - Node (server-side SVG endpoint, OG image, on-chain metadata export)
 *   - Browser (window.POMVisual, explorer cards)
 *
 * The mass is the only subject. Black field. Austere, near-monochrome,
 * almost mathematical. Radius scales with mass (relative to the current
 * alpha). Vitality modulates color, glow, and breathing speed. Mass class
 * adds internal structure. The alpha (largest mass) is rendered distinct.
 *
 * Do not fork this file. If the visual language changes, change it here and
 * every surface updates at once. See STYLE.md for the full guide.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.POMVisual = api;
})(this, function () {
  'use strict';

  var clamp = function (x, a, b) { return Math.max(a, Math.min(b, x)); };

  // ── Class tiers (ABSOLUTE mass) — internal structure grows with class ──
  function massClass(mass) {
    if (mass >= 600) return 4;
    if (mass >= 200) return 3;
    if (mass >= 50) return 2;
    return 1;
  }
  var CLASS_LABEL = { 1: 'I · Spark', 2: 'II · Body', 3: 'III · Core', 4: 'IV · Singular' };
  function classLabel(mass) { return CLASS_LABEL[massClass(mass)] || CLASS_LABEL[1]; }

  // ── Radius: area ∝ mass ⇒ radius ∝ √mass, scaled against the alpha mass ──
  function radiusFor(mass, scaleMax, maxR) {
    if (!scaleMax || scaleMax <= 0) return Math.max(8, maxR * 0.25);
    var ratio = clamp(mass / scaleMax, 0, 1);
    return Math.max(8, maxR * Math.sqrt(ratio));
  }

  function esc(s) { return String(s).replace(/[^a-zA-Z0-9_-]/g, ''); }

  /*
   * massSVG(opts) -> SVG string
   *   mass      number   this position's mass
   *   vitality  0..1     recent-activity signal (already decayed server-side)
   *   isAlpha   bool     largest current mass → rendered distinct
   *   scaleMax  number   the alpha mass (relative sizing); defaults to mass
   *   size      number   pixel size of the square SVG (viewBox is fixed 400)
   *   animate   bool     emit SMIL breathing/rotation (default true)
   *   uid       string   unique suffix for gradient/filter ids on a page
   *   bg        string   optional background fill (default transparent)
   */
  function massSVG(opts) {
    opts = opts || {};
    var mass = Math.max(0, +opts.mass || 0);
    var v = clamp(opts.vitality == null ? 0 : +opts.vitality, 0, 1);
    var isAlpha = !!opts.isAlpha;
    var scaleMax = +opts.scaleMax || mass || 1;
    var size = +opts.size || 400;
    var animate = opts.animate !== false;
    var uid = esc(opts.uid || ('m' + Math.random().toString(36).slice(2, 8)));
    var bg = opts.bg || null;

    var C = 200, maxR = 168;
    var r = radiusFor(mass, scaleMax, maxR);
    var cls = massClass(mass);

    // Palette — cold cyan accent scaling with vitality; alpha resolves to white.
    var hue = 192;
    var sat = 24 + 46 * v;
    var light = 50 + 34 * v;
    var core = isAlpha ? '#ffffff' : 'hsl(' + hue + ',' + sat.toFixed(0) + '%,' + light.toFixed(0) + '%)';
    var edge = isAlpha ? 'hsl(205,30%,46%)' : 'hsl(' + hue + ',' + sat.toFixed(0) + '%,' + (light * 0.42).toFixed(0) + '%)';
    var rim = isAlpha ? 'hsl(44,92%,72%)' : 'hsl(' + hue + ',' + clamp(sat + 12, 0, 92).toFixed(0) + '%,' + clamp(light + 16, 0, 96).toFixed(0) + '%)';
    var glowOp = (0.12 + 0.58 * v).toFixed(3);
    var blur = (r * (0.14 + 0.10 * v)).toFixed(1);
    var breath = (6.2 - 3.3 * v).toFixed(2);

    var parts = [];
    parts.push('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" width="' + size + '" height="' + size + '" role="img" aria-label="mass ' + mass + '">');

    // defs: core gradient + glow gradient + blur filter
    parts.push('<defs>');
    parts.push('<radialGradient id="core-' + uid + '" cx="42%" cy="38%" r="72%">' +
      '<stop offset="0%" stop-color="' + core + '"/>' +
      '<stop offset="62%" stop-color="' + core + '" stop-opacity="0.92"/>' +
      '<stop offset="100%" stop-color="' + edge + '"/>' +
      '</radialGradient>');
    parts.push('<radialGradient id="glow-' + uid + '" cx="50%" cy="50%" r="50%">' +
      '<stop offset="0%" stop-color="' + rim + '" stop-opacity="0.9"/>' +
      '<stop offset="60%" stop-color="' + rim + '" stop-opacity="0.25"/>' +
      '<stop offset="100%" stop-color="' + rim + '" stop-opacity="0"/>' +
      '</radialGradient>');
    parts.push('<filter id="blur-' + uid + '" x="-80%" y="-80%" width="260%" height="260%">' +
      '<feGaussianBlur stdDeviation="' + blur + '"/></filter>');
    parts.push('</defs>');

    if (bg) parts.push('<rect x="0" y="0" width="400" height="400" fill="' + bg + '"/>');

    parts.push('<g transform="translate(' + C + ',' + C + ')">');

    // Outer glow (blurred), sits behind, pulses with vitality
    parts.push('<circle r="' + (r * 1.5).toFixed(1) + '" fill="url(#glow-' + uid + ')" opacity="' + glowOp + '" filter="url(#blur-' + uid + ')">');
    if (animate) parts.push('<animate attributeName="opacity" values="' + glowOp + ';' + (Math.min(1, +glowOp + 0.18)).toFixed(3) + ';' + glowOp + '" dur="' + breath + 's" repeatCount="indefinite"/>');
    parts.push('</circle>');

    // Breathing group: disc + internal rings + core highlight
    parts.push('<g>');
    if (animate) parts.push('<animateTransform attributeName="transform" additive="sum" type="scale" values="1;1.035;1" dur="' + breath + 's" repeatCount="indefinite" calcMode="spline" keyTimes="0;0.5;1" keySplines="0.4 0 0.2 1;0.4 0 0.2 1"/>');

    // Primary disc
    parts.push('<circle r="' + r.toFixed(1) + '" fill="url(#core-' + uid + ')"/>');

    // Internal concentric rings — one per class above I
    var ringFr = [0.74, 0.52, 0.32];
    for (var i = 0; i < cls - 1 && i < ringFr.length; i++) {
      var rr = (r * ringFr[i]).toFixed(1);
      parts.push('<circle r="' + rr + '" fill="none" stroke="' + (isAlpha ? '#ffffff' : rim) + '" stroke-opacity="' + (0.16 + 0.10 * v).toFixed(3) + '" stroke-width="' + (r * 0.012 + 0.4).toFixed(2) + '"/>');
    }

    // Core highlight point (brighter for alpha)
    parts.push('<circle r="' + Math.max(1.5, r * (isAlpha ? 0.09 : 0.05)).toFixed(1) + '" cx="' + (-r * 0.16).toFixed(1) + '" cy="' + (-r * 0.2).toFixed(1) + '" fill="#ffffff" opacity="' + (isAlpha ? 0.95 : 0.35 + 0.4 * v).toFixed(3) + '"/>');
    parts.push('</g>');

    // Class IV lattice — radial ticks, slow rotation
    if (cls >= 4) {
      parts.push('<g>');
      if (animate) parts.push('<animateTransform attributeName="transform" type="rotate" from="0" to="360" dur="' + (80 - 30 * v).toFixed(0) + 's" repeatCount="indefinite"/>');
      var ticks = 24;
      for (var t = 0; t < ticks; t++) {
        var a = (t / ticks) * Math.PI * 2;
        var x1 = (Math.cos(a) * r * 1.02).toFixed(1), y1 = (Math.sin(a) * r * 1.02).toFixed(1);
        var x2 = (Math.cos(a) * r * 1.1).toFixed(1), y2 = (Math.sin(a) * r * 1.1).toFixed(1);
        parts.push('<line x1="' + x1 + '" y1="' + y1 + '" x2="' + x2 + '" y2="' + y2 + '" stroke="' + rim + '" stroke-opacity="0.5" stroke-width="1"/>');
      }
      parts.push('</g>');
    }

    // Alpha insignia — dashed halo + cardinal crosshairs
    if (isAlpha) {
      var hr = (r * 1.22).toFixed(1);
      parts.push('<circle r="' + hr + '" fill="none" stroke="' + rim + '" stroke-opacity="0.55" stroke-width="1" stroke-dasharray="2 7"/>');
      var ch = [[0, -1], [1, 0], [0, 1], [-1, 0]];
      for (var k = 0; k < 4; k++) {
        var cx1 = (ch[k][0] * r * 1.28).toFixed(1), cy1 = (ch[k][1] * r * 1.28).toFixed(1);
        var cx2 = (ch[k][0] * r * 1.4).toFixed(1), cy2 = (ch[k][1] * r * 1.4).toFixed(1);
        parts.push('<line x1="' + cx1 + '" y1="' + cy1 + '" x2="' + cx2 + '" y2="' + cy2 + '" stroke="' + rim + '" stroke-opacity="0.7" stroke-width="1.5"/>');
      }
    }

    parts.push('</g></svg>');
    return parts.join('');
  }

  return {
    massSVG: massSVG,
    massClass: massClass,
    classLabel: classLabel,
    radiusFor: radiusFor
  };
});
