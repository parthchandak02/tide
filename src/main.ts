import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

// ── Config ──────────────────────────────────────────────────────────────────
const C = {
  apiUrl:
    'https://marine-api.open-meteo.com/v1/marine?latitude=37.77&longitude=-122.42&hourly=wave_height,swell_wave_height,swell_wave_direction,wind_wave_height,wind_wave_direction,sea_surface_temperature&forecast_days=1',
  pollIntervalMs: 60_000,
  planeSize: 24,
  planeSegments: 128,
  cameraPos: new THREE.Vector3(8, 6, 8),
  fogDensity: 0.035,
  waveHeightInMin: 0.5,
  waveHeightInMax: 2.5,
  waveAmpOutMin: 0.3,
  waveAmpOutMax: 2.0,
  sstMin: 14,
  sstMid: 18,
  sstMax: 22,
  annotationGrid: 5,
  infoFadeMs: 3000,
  firstVisitCueMs: 5000,
  transitionSpeed: 0.025,
  labelUpdateInterval: 0.1,
} as const;

const PALETTE = {
  bg: '#0a0e17',
  secondary: '#0f1b2d',
  accent1: '#00bcd4',
  accent2: '#0277bd',
  glow: '#4dd0e1',
  text: 'rgba(255,255,255,0.6)',
} as const;

const SST_COLORS = {
  cold: new THREE.Color('#0d47a1'),
  mid: new THREE.Color('#00bcd4'),
  warm: new THREE.Color('#4dd0e1'),
};

const FALLBACK = {
  waveHeight: 1.2,
  swellHeight: 0.6,
  swellDir: 250,
  windWaveHeight: 0.6,
  windWaveDir: 280,
  sst: 16.8,
};

// ── Types ───────────────────────────────────────────────────────────────────
interface MarineState {
  waveHeight: number;
  swellHeight: number;
  swellDir: number;
  windWaveHeight: number;
  windWaveDir: number;
  sst: number;
}

interface WaveComponent {
  dirX: number;
  dirZ: number;
  wavelength: number;
  steepness: number;
  speed: number;
  weight: number;
}

// ── Utilities ───────────────────────────────────────────────────────────────
function mapRange(
  value: number,
  inMin: number,
  inMax: number,
  outMin: number,
  outMax: number,
): number {
  const t = Math.max(0, Math.min(1, (value - inMin) / (inMax - inMin)));
  return outMin + t * (outMax - outMin);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpColor(temp: number): THREE.Color {
  const { sstMin, sstMid, sstMax } = C;
  if (temp <= sstMid) {
    const t = mapRange(temp, sstMin, sstMid, 0, 1);
    return SST_COLORS.cold.clone().lerp(SST_COLORS.mid, t);
  }
  const t = mapRange(temp, sstMid, sstMax, 0, 1);
  return SST_COLORS.mid.clone().lerp(SST_COLORS.warm, t);
}

function degToRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

function compassLabel(deg: number): string {
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const idx = Math.round(deg / 45) % 8;
  return dirs[idx];
}

function currentGmtHour(): number {
  return new Date().getUTCHours();
}

function formatAgo(seconds: number): string {
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const m = Math.floor(seconds / 60);
  return `${m}m ago`;
}

// ── Wave math (mirrors shader for annotations + raycast info) ────────────────
const BASE_WAVES: WaveComponent[] = [
  { dirX: 1, dirZ: 0.3, wavelength: 4.5, steepness: 0.35, speed: 1.1, weight: 1.0 },
  { dirX: 0.6, dirZ: 0.8, wavelength: 2.8, steepness: 0.28, speed: 1.4, weight: 0.7 },
  { dirX: -0.4, dirZ: 0.9, wavelength: 1.6, steepness: 0.22, speed: 1.8, weight: 0.45 },
  { dirX: 0.9, dirZ: -0.2, wavelength: 1.1, steepness: 0.18, speed: 2.2, weight: 0.3 },
  { dirX: -0.7, dirZ: -0.5, wavelength: 0.7, steepness: 0.12, speed: 2.8, weight: 0.2 },
  { dirX: 0.2, dirZ: 1.0, wavelength: 0.45, steepness: 0.08, speed: 3.5, weight: 0.12 },
];

function sampleWaveHeight(
  x: number,
  z: number,
  time: number,
  amp: number,
  swellDirRad: number,
  windDirRad: number,
  windWeight: number,
): number {
  const cosS = Math.cos(swellDirRad);
  const sinS = Math.sin(swellDirRad);
  const cosW = Math.cos(windDirRad);
  const sinW = Math.sin(windDirRad);
  let y = 0;

  for (let i = 0; i < BASE_WAVES.length; i++) {
    const w = BASE_WAVES[i];
    let dx = w.dirX;
    let dz = w.dirZ;
    const len = Math.hypot(dx, dz) || 1;
    dx /= len;
    dz /= len;

    const rotX = dx * cosS - dz * sinS;
    const rotZ = dx * sinS + dz * cosS;

    const windMix = i < 3 ? 1 : windWeight;
    const wx = rotX * (1 - windMix * 0.35) + dx * cosW * windMix * 0.35;
    const wz = rotZ * (1 - windMix * 0.35) + dz * sinW * windMix * 0.35;

    const k = (Math.PI * 2) / w.wavelength;
    const phase = k * (wx * x + wz * z) + time * w.speed;
    y += amp * w.weight * Math.sin(phase);
  }

  return y;
}

// ── Shaders ─────────────────────────────────────────────────────────────────
const vertexShader = /* glsl */ `
  uniform float uTime;
  uniform float uAmplitude;
  uniform float uSwellDir;
  uniform float uWindDir;
  uniform float uWindWeight;
  uniform float uAnimate;

  varying vec3 vWorldPos;
  varying vec3 vNormal;
  varying float vHeight;
  varying float vFoam;

  const int WAVE_COUNT = 6;

  vec2 rotateDir(vec2 d, float angle) {
    float c = cos(angle);
    float s = sin(angle);
    return vec2(d.x * c - d.y * s, d.x * s + d.y * c);
  }

  void gerstner(
    vec2 pos,
    vec2 dir,
    float wavelength,
    float steepness,
    float speed,
    float weight,
  inout vec3 displaced,
  inout vec3 tangentX,
  inout vec3 tangentZ
  ) {
    float k = 6.2831853 / wavelength;
    float a = uAmplitude * weight;
    float phase = k * dot(dir, pos) + uTime * speed * uAnimate;
    float c = cos(phase);
    float s = sin(phase);
    float q = steepness / (k * a + 0.001);

    displaced.x += q * a * dir.x * c;
    displaced.z += q * a * dir.y * c;
    displaced.y += a * s;

    float dPhaseDx = k * dir.x;
    float dPhaseDz = k * dir.y;
    float dyDx = a * c * dPhaseDx;
    float dyDz = a * c * dPhaseDz;

    tangentX += vec3(1.0 - q * a * dir.x * dir.x * s * dPhaseDx, dyDx, -q * a * dir.x * dir.y * s * dPhaseDx);
    tangentZ += vec3(-q * a * dir.x * dir.y * s * dPhaseDz, dyDz, 1.0 - q * a * dir.y * dir.y * s * dPhaseDz);
  }

  void main() {
    vec3 displaced = position;
    vec3 tangentX = vec3(1.0, 0.0, 0.0);
    vec3 tangentZ = vec3(0.0, 0.0, 1.0);
    vec2 pos = position.xz;

    vec2 d0 = normalize(vec2(1.0, 0.3));
    vec2 d1 = normalize(vec2(0.6, 0.8));
    vec2 d2 = normalize(vec2(-0.4, 0.9));
    vec2 d3 = normalize(vec2(0.9, -0.2));
    vec2 d4 = normalize(vec2(-0.7, -0.5));
    vec2 d5 = normalize(vec2(0.2, 1.0));

    d0 = rotateDir(d0, uSwellDir);
    d1 = rotateDir(d1, uSwellDir);
    d2 = rotateDir(d2, uSwellDir);

    float windMix = uWindWeight;
    d3 = normalize(mix(d3, rotateDir(d3, uWindDir), windMix * 0.5));
    d4 = normalize(mix(d4, rotateDir(d4, uWindDir), windMix * 0.6));
    d5 = normalize(mix(d5, rotateDir(d5, uWindDir), windMix * 0.7));

    gerstner(pos, d0, 4.5, 0.35, 1.1, 1.0, displaced, tangentX, tangentZ);
    gerstner(pos, d1, 2.8, 0.28, 1.4, 0.7, displaced, tangentX, tangentZ);
    gerstner(pos, d2, 1.6, 0.22, 1.8, 0.45, displaced, tangentX, tangentZ);
    gerstner(pos, d3, 1.1, 0.18, 2.2, 0.3, displaced, tangentX, tangentZ);
    gerstner(pos, d4, 0.7, 0.12, 2.8, 0.2, displaced, tangentX, tangentZ);
    gerstner(pos, d5, 0.45, 0.08, 3.5, 0.12, displaced, tangentX, tangentZ);

    vNormal = normalize(cross(tangentZ, tangentX));
    vWorldPos = (modelMatrix * vec4(displaced, 1.0)).xyz;
    vHeight = displaced.y;
    vFoam = smoothstep(uAmplitude * 0.35, uAmplitude * 0.85, displaced.y);

    gl_Position = projectionMatrix * viewMatrix * vec4(vWorldPos, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  uniform vec3 uWaterColor;
  uniform vec3 uGlowColor;
  uniform float uPulse;
  uniform float uTime;

  varying vec3 vWorldPos;
  varying vec3 vNormal;
  varying float vHeight;
  varying float vFoam;

  void main() {
    vec3 lightDir = normalize(vec3(0.4, 1.0, 0.3));
    float diffuse = max(dot(vNormal, lightDir), 0.0);
    float spec = pow(max(dot(reflect(-lightDir, vNormal), normalize(cameraPosition - vWorldPos)), 0.0), 48.0);

    vec3 base = uWaterColor * (0.35 + diffuse * 0.65);
    vec3 crest = mix(base, uGlowColor, vFoam * 0.55);
    vec3 col = crest + spec * uGlowColor * 0.35;

    float pulseRing = sin(uTime * 2.0) * 0.5 + 0.5;
    col += uGlowColor * uPulse * pulseRing * vFoam * 0.25;

    float fogFactor = exp(-0.035 * length(vWorldPos - cameraPosition) * 0.12);
    col = mix(vec3(0.04, 0.06, 0.1), col, fogFactor);

    gl_FragColor = vec4(col, 0.92);
  }
`;

// ── DOM chrome ──────────────────────────────────────────────────────────────
const heroEl = document.getElementById('hero')!;
const stampEl = document.getElementById('stamp')!;
const descEl = document.getElementById('desc')!;
const infoEl = document.getElementById('info')!;
const legendEl = document.getElementById('legend')!;

function injectStyles(): void {
  const style = document.createElement('style');
  style.textContent = `
    body { touch-action: manipulation; font-family: system-ui, sans-serif; }
    #hero {
      position: fixed; top: 24px; left: 24px;
      font: 56px/1 system-ui, sans-serif; color: white;
      pointer-events: none; z-index: 10;
      transition: text-shadow var(--motion-slow) var(--ease-out-expo);
    }
    #hero .unit { font-size: 28px; opacity: 0.55; margin-left: 4px; }
    #hero .label {
      display: block; font-size: 11px; opacity: 0.5;
      margin-top: 6px; letter-spacing: 0.04em;
    }
    #hero.cue { text-shadow: 0 0 24px ${PALETTE.glow}, 0 0 48px ${PALETTE.accent1}; }
    #stamp {
      position: fixed; bottom: 20px; left: 16px;
      font: 10px system-ui, sans-serif; opacity: 0.4; color: ${PALETTE.text};
      pointer-events: none; z-index: 10;
    }
    #desc {
      position: fixed; bottom: 68px; left: 50%; transform: translateX(-50%);
      font: 11px system-ui, sans-serif; opacity: 0.45; color: ${PALETTE.text};
      text-align: center; max-width: 65ch; padding: 0 16px;
      pointer-events: none; z-index: 10;
    }
    #info {
      position: fixed; bottom: 100px; left: 50%; transform: translateX(-50%);
      pointer-events: none; z-index: 10;
      opacity: 0; transition: opacity var(--motion-base) var(--ease-out-expo);
      background: rgba(10, 14, 23, 0.88);
      border: 1px solid rgba(0, 188, 212, 0.25);
      border-radius: 8px; padding: 14px 18px;
      font: 11px/1.6 system-ui, sans-serif; color: ${PALETTE.text};
      min-width: 220px; backdrop-filter: blur(8px);
    }
    #info.visible { opacity: 1; }
    #info .title {
      color: ${PALETTE.accent1}; font-size: 10px;
      text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 8px;
    }
    #info .row { display: flex; justify-content: space-between; gap: 16px; }
    #info .val { color: white; font-weight: 600; }
    #legend {
      position: fixed; bottom: 20px; right: 20px;
      pointer-events: none; z-index: 10;
      font: 9px system-ui, sans-serif; color: ${PALETTE.text}; opacity: 0.5;
    }
    #legend .bar {
      width: 120px; height: 8px; border-radius: 4px; margin-bottom: 4px;
      background: linear-gradient(to right, #0d47a1, #00bcd4, #4dd0e1);
    }
    #legend .labels { display: flex; justify-content: space-between; }
    .annotation {
      position: fixed; pointer-events: none; z-index: 5;
      font: 9px system-ui, sans-serif; color: rgba(77, 208, 225, 0.45);
      transform: translate(-50%, -100%); white-space: nowrap;
      text-shadow: 0 1px 4px rgba(0,0,0,0.6);
    }
    @media (prefers-reduced-motion: reduce) {
      #hero, #info { transition: none; }
    }
  `;
  document.head.appendChild(style);
}

function setupChrome(): void {
  injectStyles();

  descEl.textContent =
    'Wave height drives the ocean surface - taller waves = more displacement. Swell direction rotates the wave pattern. Water temperature tints the color.';

  legendEl.innerHTML = `
    <div class="bar"></div>
    <div class="labels"><span>14°C</span><span>22°C</span></div>
  `;
}

function updateHero(waveHeight: number): void {
  heroEl.innerHTML = `
    <span class="value">${waveHeight.toFixed(1)}</span><span class="unit">m</span>
    <span class="label">significant wave height</span>
  `;
}

function updateStamp(live: boolean, secondsAgo: number): void {
  const status = live ? 'live' : 'fallback';
  stampEl.textContent = `Open-Meteo Marine · SF Buoy · ${status} · ${formatAgo(secondsAgo)}`;
}

function showInfoPanel(data: MarineState, localHeight: number, x: number, z: number): void {
  infoEl.innerHTML = `
    <div class="title">Quiet zone · ${x.toFixed(1)}, ${z.toFixed(1)}</div>
    <div class="row"><span>Significant wave height</span><span class="val">${data.waveHeight.toFixed(1)} m</span></div>
    <div class="row"><span>Local surface height</span><span class="val">${localHeight.toFixed(2)} m</span></div>
    <div class="row"><span>Swell height</span><span class="val">${data.swellHeight.toFixed(1)} m</span></div>
    <div class="row"><span>Swell direction</span><span class="val">${Math.round(data.swellDir)}° ${compassLabel(data.swellDir)}</span></div>
    <div class="row"><span>Wind wave height</span><span class="val">${data.windWaveHeight.toFixed(1)} m</span></div>
    <div class="row"><span>Sea surface temp</span><span class="val">${data.sst.toFixed(1)}°C</span></div>
  `;
  infoEl.classList.add('visible');
}

function hideInfoPanel(): void {
  infoEl.classList.remove('visible');
}

// ── Scene ───────────────────────────────────────────────────────────────────
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x0a0e17, C.fogDensity);

function createGradientBackground(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 2;
  canvas.height = 512;
  const ctx = canvas.getContext('2d')!;
  const grad = ctx.createLinearGradient(0, 0, 0, 512);
  grad.addColorStop(0, PALETTE.bg);
  grad.addColorStop(1, PALETTE.secondary);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 2, 512);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

scene.background = createGradientBackground();

const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.copy(C.cameraPos);
camera.lookAt(0, 0, 0);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.maxPolarAngle = Math.PI / 2 - 0.05;
controls.minDistance = 6;
controls.maxDistance = 30;
controls.target.set(0, 0, 0);

const clock = new THREE.Clock();

// Marine state with smooth transitions
const current: MarineState = { ...FALLBACK };
const target: MarineState = { ...FALLBACK };
let isLive = false;
let lastFetchTime = Date.now();
let infoHideTimer: ReturnType<typeof setTimeout> | null = null;
const cueStart = performance.now();
let labelAccumulator = 0;

const waterColor = lerpColor(FALLBACK.sst);
const glowColor = new THREE.Color(PALETTE.glow);

const uniforms = {
  uTime: { value: 0 },
  uAmplitude: {
    value: mapRange(
      FALLBACK.waveHeight,
      C.waveHeightInMin,
      C.waveHeightInMax,
      C.waveAmpOutMin,
      C.waveAmpOutMax,
    ),
  },
  uSwellDir: { value: degToRad(FALLBACK.swellDir) },
  uWindDir: { value: degToRad(FALLBACK.windWaveDir) },
  uWindWeight: { value: Math.min(1, FALLBACK.windWaveHeight / 2) },
  uAnimate: { value: reducedMotion ? 0 : 1 },
  uWaterColor: { value: waterColor },
  uGlowColor: { value: glowColor },
  uPulse: { value: 1 },
};

const geometry = new THREE.PlaneGeometry(C.planeSize, C.planeSize, C.planeSegments, C.planeSegments);
geometry.rotateX(-Math.PI / 2);

const material = new THREE.ShaderMaterial({
  vertexShader,
  fragmentShader,
  uniforms,
  transparent: true,
  side: THREE.DoubleSide,
});

const ocean = new THREE.Mesh(geometry, material);
ocean.name = 'ocean';
scene.add(ocean);

// Ambient + directional light for shader normals reference
const ambient = new THREE.AmbientLight(0x1a3050, 0.6);
scene.add(ambient);
const dirLight = new THREE.DirectionalLight(0x4dd0e1, 0.4);
dirLight.position.set(5, 10, 3);
scene.add(dirLight);

// Annotation labels at grid points
interface AnnotationLabel {
  el: HTMLDivElement;
  gx: number;
  gz: number;
}

const annotations: AnnotationLabel[] = [];
const half = C.planeSize / 2;
const gridStep = C.planeSize / (C.annotationGrid - 1);

for (let i = 0; i < C.annotationGrid; i++) {
  for (let j = 0; j < C.annotationGrid; j++) {
    const el = document.createElement('div');
    el.className = 'annotation';
    el.textContent = '0.0m';
    document.body.appendChild(el);
    const gx = -half + i * gridStep;
    const gz = -half + j * gridStep;
    annotations.push({ el, gx, gz });
  }
}

function updateAnnotations(time: number, amp: number, swellRad: number, windRad: number, windW: number): void {
  const tempVec = new THREE.Vector3();

  for (const ann of annotations) {
    const localY = sampleWaveHeight(ann.gx, ann.gz, time, amp, swellRad, windRad, windW);
    const displayH = mapRange(
      Math.abs(localY) + current.waveHeight * 0.15,
      0,
      amp * 2,
      0,
      current.waveHeight * 1.4,
    );
    ann.el.textContent = `${displayH.toFixed(1)}m`;

    tempVec.set(ann.gx, localY + 0.15, ann.gz);
    tempVec.project(camera);

    const sx = (tempVec.x * 0.5 + 0.5) * window.innerWidth;
    const sy = (-tempVec.y * 0.5 + 0.5) * window.innerHeight;

    if (tempVec.z > 1) {
      ann.el.style.display = 'none';
    } else {
      ann.el.style.display = 'block';
      ann.el.style.left = `${sx}px`;
      ann.el.style.top = `${sy}px`;
      ann.el.style.opacity = String(Math.min(0.45, 0.2 + displayH * 0.15));
    }
  }
}

// Raycaster for ocean tap
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();

function onPointerDown(event: PointerEvent): void {
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObject(ocean);
  if (hits.length === 0) return;

  const point = hits[0].point;
  const time = reducedMotion ? 0 : clock.getElapsedTime();
  const amp = uniforms.uAmplitude.value as number;
  const swellRad = uniforms.uSwellDir.value as number;
  const windRad = uniforms.uWindDir.value as number;
  const windW = uniforms.uWindWeight.value as number;
  const localY = sampleWaveHeight(point.x, point.z, time, amp, swellRad, windRad, windW);

  showInfoPanel(current, localY, point.x, point.z);

  if (infoHideTimer) clearTimeout(infoHideTimer);
  infoHideTimer = setTimeout(hideInfoPanel, C.infoFadeMs);
}

renderer.domElement.addEventListener('pointerdown', onPointerDown);

// ── API ─────────────────────────────────────────────────────────────────────
async function fetchMarineData(): Promise<void> {
  try {
    const res = await fetch(C.apiUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const hourly = json.hourly;
    if (!hourly) throw new Error('No hourly data');

    const idx = currentGmtHour();
    const waveHeight = hourly.wave_height?.[idx] ?? FALLBACK.waveHeight;
    const swellHeight = hourly.swell_wave_height?.[idx] ?? FALLBACK.swellHeight;
    const swellDir = hourly.swell_wave_direction?.[idx] ?? FALLBACK.swellDir;
    const windWaveHeight = hourly.wind_wave_height?.[idx] ?? FALLBACK.windWaveHeight;
    const windWaveDir = hourly.wind_wave_direction?.[idx] ?? FALLBACK.windWaveDir;
    const sst = hourly.sea_surface_temperature?.[idx] ?? FALLBACK.sst;

    target.waveHeight = waveHeight;
    target.swellHeight = swellHeight;
    target.swellDir = swellDir;
    target.windWaveHeight = windWaveHeight;
    target.windWaveDir = windWaveDir;
    target.sst = sst;

    isLive = true;
    lastFetchTime = Date.now();
  } catch {
    Object.assign(target, FALLBACK);
    isLive = false;
    lastFetchTime = Date.now();
  }
}

// Seed with fallback immediately, then fetch
setupChrome();
updateHero(current.waveHeight);
updateStamp(false, 0);
heroEl.classList.add('cue');

void fetchMarineData();
setInterval(() => void fetchMarineData(), C.pollIntervalMs);

// ── Resize ──────────────────────────────────────────────────────────────────
function onResize(): void {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}
window.addEventListener('resize', onResize);

// ── Animation loop ──────────────────────────────────────────────────────────
function animate(): void {
  requestAnimationFrame(animate);

  const elapsed = clock.getElapsedTime();
  const animateFlag = reducedMotion ? 0 : 1;
  uniforms.uAnimate.value = animateFlag;
  uniforms.uTime.value = elapsed * animateFlag;

  // Smooth transitions
  current.waveHeight = lerp(current.waveHeight, target.waveHeight, C.transitionSpeed);
  current.swellHeight = lerp(current.swellHeight, target.swellHeight, C.transitionSpeed);
  current.swellDir = lerp(current.swellDir, target.swellDir, C.transitionSpeed);
  current.windWaveHeight = lerp(current.windWaveHeight, target.windWaveHeight, C.transitionSpeed);
  current.windWaveDir = lerp(current.windWaveDir, target.windWaveDir, C.transitionSpeed);
  current.sst = lerp(current.sst, target.sst, C.transitionSpeed);

  const amp = mapRange(
    current.waveHeight,
    C.waveHeightInMin,
    C.waveHeightInMax,
    C.waveAmpOutMin,
    C.waveAmpOutMax,
  );
  uniforms.uAmplitude.value = amp;
  uniforms.uSwellDir.value = degToRad(current.swellDir);
  uniforms.uWindDir.value = degToRad(current.windWaveDir);
  uniforms.uWindWeight.value = Math.min(1, current.windWaveHeight / 1.5);

  const newColor = lerpColor(current.sst);
  (uniforms.uWaterColor.value as THREE.Color).copy(newColor);

  // First visit cue
  const cueElapsed = performance.now() - cueStart;
  if (cueElapsed < C.firstVisitCueMs) {
    uniforms.uPulse.value = 1 - cueElapsed / C.firstVisitCueMs;
    heroEl.classList.add('cue');
  } else {
    uniforms.uPulse.value = 0;
    heroEl.classList.remove('cue');
  }

  updateHero(current.waveHeight);
  const secondsAgo = Math.floor((Date.now() - lastFetchTime) / 1000);
  updateStamp(isLive, secondsAgo);

  labelAccumulator += clock.getDelta();
  if (labelAccumulator >= C.labelUpdateInterval) {
    labelAccumulator = 0;
    updateAnnotations(
      elapsed * animateFlag,
      amp,
      uniforms.uSwellDir.value as number,
      uniforms.uWindDir.value as number,
      uniforms.uWindWeight.value as number,
    );
  }

  controls.update();
  renderer.render(scene, camera);
}

animate();
