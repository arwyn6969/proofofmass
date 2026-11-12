# ProofOfMass — Visual Style Guide (STYLE.md)

The mass is the only subject. Austere, high-contrast, almost mathematical. This guide is precise enough that another agent can regenerate identical masses for the website, explorer cards, and on-chain metadata. The canonical implementation is `shared-visual.js` (`POMVisual.massSVG`) — use it directly when you can; reproduce it from this spec when you cannot.

## 1. Principles

- **Black field.** Background is near-black `#05060a`. Nothing competes with the mass.
- **One shape.** A single circle (with internal structure) per position. No icons, no illustration, no photography. Everything is generated, never a hosted image.
- **Radius encodes mass.** Area ∝ mass ⇒ `radius ∝ √mass`, scaled **relative to the current alpha** so the largest mass fills the field and the rest are proportional.
- **Vitality modulates, never dominates.** Recent activity brightens color, strengthens glow, and speeds the breathing. It never changes the size.
- **The alpha is distinct.** The single largest mass gets a white core, a warm rim, a dashed halo, and cardinal crosshairs.
- **Restraint.** Near-monochrome. One cold accent (cyan). Warm (amber) is reserved exclusively for the alpha.

## 2. Canvas

- Fixed `viewBox="0 0 400 400"`, rendered at any pixel `size`. Center `(200,200)`.
- `maxR = 168` (the alpha's radius; it never touches the edge).
- Background transparent by default; pass `bg:'#05060a'` for standalone renders (SVG endpoint, OG, metadata).

## 3. Size (radius) formula

```
ratio  = clamp(mass / scaleMax, 0, 1)        // scaleMax = current alpha mass
radius = max(8, maxR * sqrt(ratio))          // 8px floor so tiny masses stay visible
```

`scaleMax` is the alpha mass from `/api/stats` (`alpha_mass`) or `/api/leaderboard` (`scaleMax`). Pass the same `scaleMax` to every card in a view so sizes are comparable.

## 4. Color

Near-monochrome, cold. Let `v = clamp(vitality, 0, 1)`:

```
hue   = 192                         // cold cyan
sat   = 24 + 46*v    (%)            // dormant = desaturated, active = saturated
light = 50 + 34*v    (%)            // dormant = dim, active = bright
core  = isAlpha ? #ffffff : hsl(hue, sat, light)
edge  = isAlpha ? hsl(205,30%,46%) : hsl(hue, sat, light*0.42)   // radial gradient outer stop
rim   = isAlpha ? hsl(44,92%,72%)  : hsl(hue, sat+12, light+16)  // rings, glow, insignia
```

Accent cyan `#6ff2ff`. Alpha warm `#ffd27a`. Danger `#ff6b6b`. These are the only hues in the system.

- **Core fill** is a radial gradient (`cx=42% cy=38%`) from `core` → `edge`, giving a single off-center highlight (a lit sphere, not a flat disc).
- **Glow** is a blurred radial-gradient halo in `rim`, opacity `0.12 + 0.58*v`, blur `radius*(0.14 + 0.10*v)`.

## 5. Class (internal structure)

Absolute mass tiers add concentric rings; the top tier adds a rotating radial lattice.

| Class | Mass | Internal structure |
|-------|------|--------------------|
| **I · Spark** | `< 50` | bare disc |
| **II · Body** | `50–199` | disc + 1 inner ring (at `0.74r`) |
| **III · Core** | `200–599` | disc + 2 rings (`0.74r`, `0.52r`) |
| **IV · Singular** | `≥ 600` | disc + 3 rings + 24-tick rotating lattice at `1.02–1.1r` |

Rings: stroke `rim` (white for alpha), opacity `0.16 + 0.10*v`, width `~0.012r`.

## 6. Alpha insignia (largest mass only)

- Core resolves to pure `#ffffff`; rim/glow shift warm (`#ffd27a` family).
- Dashed halo circle at `1.22r`, `stroke-dasharray 2 7`, opacity `0.55`.
- Four cardinal crosshair ticks from `1.28r` to `1.4r`, opacity `0.7`.
- Larger central white highlight point.

## 7. Motion (vitality)

All SMIL, no JS required (set `animate:false` for a static frame — OG image, metadata thumbnail):

- **Breathing** — the disc group scales `1 → 1.035 → 1`, `dur = 6.2 - 3.3*v` seconds (faster when active), eased `cubic-bezier(0.4,0,0.2,1)`.
- **Glow pulse** — halo opacity oscillates ± `0.18` on the same period.
- **Lattice rotation** (class IV) — `0 → 360°`, `dur = 80 - 30*v` seconds.

## 8. Surfaces

- **Website hero** — the alpha at `size≈360`, animated, with a drop-shadow glow; label `ALPHA · <mass> · <class>` in mono amber.
- **Explorer cards** — `size≈220`, animated, on `--panel` gradient tiles; alpha tile gets an amber border. Rank top-left, `ALPHA` badge top-right, mass + class + a cyan vitality bar below.
- **Agent detail** — `size≈380`, `bg:#05060a`, with the class/ALPHA label beneath.
- **SVG endpoint** — `GET /api/agent/{id}/svg?size=&static=1` returns the canonical render (`bg:#05060a`).
- **On-chain metadata** — `image`/`animation_url` point at the SVG endpoint; the same generator, so the mirror matches the explorer exactly.

## 9. Typography & chrome (for the site, not the mass)

- Display/UI: **Space Grotesk** (300–700). Numerals, addresses, hashes, code: **IBM Plex Mono**.
- Uppercase section labels, letter-spacing `0.14–0.18em`, color `--muted2 #95a0b4`.
- Lines/borders `rgba(255,255,255,0.08)`. Panels are subtle top-lit gradients `#0a0c13 → #05060a`.
- A single faint cyan radial wash at the top of the page (`rgba(111,242,255,0.05)`), nothing more.

## 10. Do / Don't

- **Do** keep the field black, keep one shape per position, size strictly by mass, reserve amber for the alpha, and generate everything from `shared-visual.js`.
- **Don't** add gradients of random hue, multiple accent colors, drop photographic or skeuomorphic texture, animate size, or hardcode a radius. If it isn't mass, vitality, class, or alpha, it doesn't belong in the visual.
