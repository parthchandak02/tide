# tide — Creative Brief

## Concept
A living 3D ocean surface driven by real marine buoy data from the SF coast. Wave height from the Open-Meteo Marine API drives vertex displacement on a subdivided plane. Swell direction rotates the wave pattern. Sea surface temperature tints the water from cool blue to warm teal. OrbitControls for free exploration. A hero number shows the current significant wave height. The user sees a dynamic ocean that breathes with real Pacific data.

**Metaphor family:** ocean
**Narrative Pattern:** Annotation (wave height labels always visible at grid points)
**Tier 2 Patterns (pick 2):** Hero Number (significant wave height) + Quiet Zone (tap reveals per-point temp, swell height, wind wave data)

**Three Dials:**
- DESIGN_VARIANCE: 5
- MOTION_INTENSITY: 6
- VISUAL_DENSITY: 4

## Data Source
- API endpoint: `https://marine-api.open-meteo.com/v1/marine?latitude=37.77&longitude=-122.42&hourly=wave_height,swell_wave_height,swell_wave_direction,wind_wave_height,wind_wave_direction,sea_surface_temperature&forecast_days=1`
- Response format: JSON with hourly arrays; lat=37.77, lon=-122.42 (SF coast buoy)
- Fields used:
  - `wave_height` (m) — total significant wave height, drives vertex amplitude
  - `swell_wave_height` (m) — groundswell component
  - `swell_wave_direction` (degrees) — direction waves are coming FROM, drives wave orientation
  - `wind_wave_height` (m) — windsea component
  - `sea_surface_temperature` (degrees C) — drives water color
- Poll interval: 60s
- Current hour index: use `new Date().getHours()` in the response's timezone (GMT) — the API returns 24 hourly entries starting from midnight GMT
- Fallback: realistic default values (wave_height: 1.2, swell: 0.6, swell_dir: 250, wind_wave: 0.6, sst: 16.8) with honest "fallback" label

## Visual Style
- **Preset:** Dark — Abyss (deep ocean, cyan-teal strokes, gentle motion)
- Palette (locked JS const):
  ```js
  const PALETTE = {
    bg: '#0a0e17',
    secondary: '#0f1b2d',
    accent1: '#00bcd4',
    accent2: '#0277bd',
    glow: '#4dd0e1',
    text: 'rgba(255,255,255,0.6)',
  };
  ```
- SST color gradient: 14°C = deep blue (#0d47a1), 18°C = teal (#00bcd4), 22°C = warm cyan (#4dd0e1)
- Coherence tokens:
  - strokeWeightScale: { hair: 0.5, fine: 1, medium: 2 }
  - alphaHierarchy: { bg: 0.08, field: 0.25, active: 0.7, label: 0.45 }
  - shapeLanguage: organic curves (ocean surface)
  - glowBudget: 1 glow color (accent1), blur <= 40px, <= 20 entities
  - accentColor: #00bcd4 exactly one accent + semantic colors
- Motion tokens: `--motion-fast: 160ms; --motion-base: 240ms; --motion-slow: 360ms; --ease-out-expo: cubic-bezier(0.22, 1, 0.36, 1);`

## Encoding Contract
| Data Field | Visual Channel | Range | Inverse Function | "Bigger means..." | Legend? |
|---|---|---|---|---|---|
| wave_height (m) | Vertex Y displacement amplitude | 0.5-2.5m → 0.3-2.0 scene units | invertScale(y, 0.3, 2.0, 0.5, 2.5) | taller waves | no (physical metaphor) |
| swell_wave_direction (°) | Wave pattern rotation | 0-360° → 0-2PI rad | direction from normal angle | N/A (directional) | no (visible as wave orientation) |
| sea_surface_temp (°C) | Water color (blue→teal gradient) | 14-22°C → blue(#0d47a1) to teal(#4dd0e1) | interpolate from color to temp | warmer water | yes (color bar in quiet zone) |
| current_hour_index | Which hourly data to display | 0-23 | N/A (auto-cycles) | N/A | no |

## Canvas Code Requirements (MANDATORY)
1. Vite + TypeScript + vanilla Three.js project in `~/projects/tide/`
2. Single entry: `src/main.ts` — creates WebGLRenderer, PerspectiveCamera, Scene, requestAnimationFrame loop
3. No React, no R3F
4. DPR: `renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))`
5. `touch-action: manipulation` on body
6. First frame never blank — seed with fallback data
7. Config object `C` at top of main.ts with all tunable values
8. Realistic fallback data if API fails
9. `.nojekyll` file at project root
10. Font on all chrome: `system-ui, sans-serif`. No serif fonts. No Inter, Roboto, Open Sans.
11. No em-dashes in any user-visible strings — use hyphens.

## Creative Scene (Three.js)
- **Primary metaphor:** Living ocean surface. A large subdivided PlaneGeometry (128x128 segments, 24x24 scene units) with custom ShaderMaterial for vertex displacement and color.
- **Vertex displacement:** Combine multiple sine/cosine waves at different frequencies and directions. The wave_height value scales the overall amplitude. swell_wave_direction rotates the primary wave direction. Animate over time using `clock.getElapsedTime()`.
- **Water color:** Fragment shader mixes between cool blue (#0d47a1) and warm teal (#4dd0e1) based on sea_surface_temperature (14-22C range).
- **Waves:** 4-6 Gerstner-like wave components for realistic ocean motion. Amplitude scaled by the live wave_height API value.
- **Camera:** Poster angle at (8, 6, 8) looking at origin — shows the ocean surface with wave heights clearly visible. User can orbit with OrbitControls.
- **Direction:** Swell direction rotates the wave field. Wind wave direction can add a secondary ripple layer.
- **THREE APIs:** PlaneGeometry, ShaderMaterial, OrbitControls (damped, maxPolarAngle: PI/2 - 0.05), Clock, Mesh, Scene
- **Background:** Gradient from #0a0e17 (top/dark navy) to #0f1b2d (bottom/slightly lighter). Use a second large plane or `scene.background` with a gradient texture.
- **Fog:** Scene fog (FogExp2, density 0.035) to fade the ocean into the distance
- **Post-processing:** Optional — can add a subtle bloom on the wave crests using UnrealBloomPass (from three/examples/jsm/postprocessing/)

## UX Chrome (DOM overlays, not canvas)
1. **Hero Number (#hero)** — top-left, 56px bold, white, with "m" unit label. Shows current significant wave height. Updates every poll cycle.
   - `position: fixed; top: 24px; left: 24px; font: 56px/1 system-ui, sans-serif; color: white;`
   - Small label below: "significant wave height" at 11px, opacity 0.5
2. **Data Stamp (#stamp)** — bottom-left, 10px system-ui, opacity 0.4
   - `position: fixed; bottom: 20px; left: 16px;`
   - Format: `Open-Meteo Marine · SF Buoy · live|fallback · Xs ago`
3. **Description (#desc)** — bottom center, 11px system-ui, opacity 0.45, centered, max-width 65ch
   - `position: fixed; bottom: 68px; left: 50%; transform: translateX(-50%); text-align: center;`
   - Text: "Wave height drives the ocean surface — taller waves = more displacement. Swell direction rotates the wave pattern. Water temperature tints the color."
4. **Quiet Zone Panel (#info)** — bottom-center area, revealed on tap/click on the ocean surface, shows per-point data
   - `position: fixed; bottom: 100px; left: 50%; transform: translateX(-50%);`
   - Shows: significant wave height, swell height, swell direction (compass), wind wave height, sea surface temperature
   - Fades out after 3 seconds of inactivity
   - Styled with same palette (dark bg, teal accent text)
   - Use `pointer-events: none` on container, `pointer-events: auto` only on interactive elements
5. **Temperature Legend (#legend)** — bottom-right, small color bar showing blue→teal gradient with "14°C" and "22°C" labels
   - `position: fixed; bottom: 20px; right: 20px;`
   - 120px x 8px gradient bar with small labels below

## Interaction
- **OrbitControls** — click+drag to orbit, scroll to zoom. Damped (enableDamping: true), maxPolarAngle limited to prevent going under the surface
- **Tap/click on ocean** — raycaster intersection with the ocean mesh. Show Quiet Zone panel with the wave height, swell direction, and SST at that point. Panel fades after 3s idle.
- **Auto-animation** — waves animate continuously. Every 60s, re-fetch API and smoothly transition to new wave height / direction / temperature values.
- **First visit cue** — a subtle pulsing glow on initial load to indicate interactivity. Fades after 5 seconds.

## Communication Requirements
**Tier 1 (mandatory):**
1. Persistent Data Stamp — source name, last updated, live/fallback
2. Data Process Honesty — fallback labeled "fallback", never "live"
3. One-to-One Sensory Mapping — taller = bigger waves, bluer = colder water

**Tier 2 (pick 2):**
4. Hero Number — significant wave height at 56px, top-left
5. Quiet Zone — tap reveals per-point wave + temp + direction data, fades after 3s

## Build Requirements
- No CDN libraries — all via npm (three, and optionally three/examples/jsm/controls/OrbitControls)
- npm run build must produce a `dist/` folder with index.html and bundled JS
- Vite config must set `base: './'` for relative paths on Cloudflare Pages
- TypeScript: use normal types. Skip `tsc --noEmit` in build — let Vite/esbuild handle transpilation.

## Reduced Motion
- `@media (prefers-reduced-motion: reduce)` — collapse wave animation to static frame, disable OrbitControls auto-rotate, keep interaction and data updates working
- Show static ocean surface with labels and hero number still updating
