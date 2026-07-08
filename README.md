# tide

A living 3D ocean surface driven by real marine buoy data from the SF coast. Wave height drives vertex displacement, swell direction rotates the wave pattern, sea surface temperature tints the water color.

**Visual Style:** Dark — Abyss (deep ocean, cyan-teal strokes, gentle motion)

**Data Source:** Open-Meteo Marine API (SF buoy 37.77, -122.42)

**How it works:**
- Wave height from the API drives the amplitude of 6-component Gerstner waves in a vertex shader
- Swell direction rotates the primary wave field orientation
- Sea surface temperature tints the water from cool blue (#0d47a1) to warm teal (#4dd0e1)
- OrbitControls let you explore the ocean surface from any angle
- Tap on the ocean to reveal per-point wave height, swell direction, and temperature
- A 5x5 annotation grid shows wave height labels projected onto the 3D surface
- Hero number at top-left shows significant wave height
- Data stamp at bottom shows source, live/fallback status, and freshness

**GitHub:** https://github.com/parthchandak02/tide

**Live:** https://tide.parthchandak.info

**Tech:** Vanilla Three.js + Vite + TypeScript. Hosted on Cloudflare Pages.
