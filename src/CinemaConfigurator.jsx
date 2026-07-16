import React, {
  useEffect, useRef, useState, useCallback, useMemo,
} from 'react';
import * as THREE from 'three';
import { ColladaLoader } from 'three/examples/jsm/loaders/ColladaLoader.js';
import { BufferGeometryUtils } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// ============================================================================
// Configurador 3D de sala de cine — Cinemes Full HD (Centre Splau)
// Three.js r128 puro (sin OrbitControls, sin React Three Fiber).
// Assets originales del proyecto (en /public):
//   /Cine/butacavip/butacavip.dae (+ difuse/normal)  → butaca VIP
//   /images/texturagris.jpg                           → sala
//   /images/speaker_diff.JPG                          → altavoces K.C.S.
//   /images/maxima.JPG, minima.jpg                    → discos "IMMERSIÓ"
//   /images/proyector.JPG                             → cabina de proyección
//   /images/puerta3.jpg, senyalemer.jpg               → salidas de emergencia
//   /images/pantalla2.jpg                             → logo (pre-show)
//   /video/sintel_trailer-720p.mp4                    → trailer (CC-BY)
// ============================================================================

// El trailer trae letterbox incrustado: imagen real 1280×544 (2,35:1) con
// 88 px de barra negra arriba y abajo — se recorta vía UV.
const VIDEO_CROP = { y: 88 / 720, h: 544 / 720 };
const VIDEO_ASPECT = 1280 / 544;
const TRAILER_URL = '/video/sintel_trailer-720p.mp4';

const HALL_H = 9.6; // altura de la sala
const SCREEN_Z = -9; // z del punto más cercano de la pantalla
const SCREEN_BOTTOM = 1.0; // metro libre entre pantalla y suelo
const Z_START = 2.6; // z de la primera fila
const ROW_DEPTH_STD = 1.05;
const ROW_DEPTH_VIP = 1.55;
const AISLE_W = 1.1;
const FLY_MS = 1100;
const STORAGE_KEY = 'ticketing3d.sala';

const easeInOutCubic = (t) =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

// hash determinista → [0,1). Con él la ocupación simulada es estable: subir
// el slider añade butacas vendidas sin cambiar las que ya lo estaban.
const hash01 = (str) => {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return (h >>> 8) / 16777216;
};

const DEFAULT_PARAMS = {
  rows: 12,
  cols: 16,
  vipRows: 2,
  curvature: 35, // 0-100 %
  slope: 0.25, // m / fila
  spacing: 0.78, // m
  aisle: true,
  occupancy: 0, // % de butacas vendidas (simulación)
  screenWPct: 100, // % del ancho de sala que ocupa la pantalla
  screenH: 8.0, // alto de pantalla en metros
};
const DEFAULT_PRICES = { std: 8.5, vip: 13.5 };

// configuración inicial: hash de la URL (#c=...) > localStorage > defaults
const loadInitial = () => {
  try {
    const m = window.location.hash.match(/c=([^&]+)/);
    if (m) {
      return JSON.parse(
        decodeURIComponent(escape(atob(decodeURIComponent(m[1]))))
      );
    }
  } catch (err) { /* hash corrupto: se ignora */ }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (err) { /* storage no disponible */ }
  return {};
};

// iconos outline (trazo, sin relleno — estilo Feather)
const Ic = ({ children, size = 15, style }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    style={{ verticalAlign: '-2px', ...style }}
  >
    {children}
  </svg>
);
const icons = {
  menu: (
    <>
      <line x1="3" y1="6" x2="21" y2="6" />
      <line x1="3" y1="12" x2="21" y2="12" />
      <line x1="3" y1="18" x2="21" y2="18" />
    </>
  ),
  x: (
    <>
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </>
  ),
  eye: (
    <>
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  target: (
    <>
      <circle cx="12" cy="12" r="10" />
      <circle cx="12" cy="12" r="6" />
      <circle cx="12" cy="12" r="2" />
    </>
  ),
  volOff: (
    <>
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <line x1="23" y1="9" x2="17" y2="15" />
      <line x1="17" y1="9" x2="23" y2="15" />
    </>
  ),
  volOn: (
    <>
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
      <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
    </>
  ),
  download: (
    <>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </>
  ),
  upload: (
    <>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </>
  ),
  home: (
    <>
      <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <polyline points="9 22 9 12 15 12 15 22" />
    </>
  ),
  back: (
    <>
      <line x1="19" y1="12" x2="5" y2="12" />
      <polyline points="12 19 5 12 12 5" />
    </>
  ),
  undo: (
    <>
      <polyline points="1 4 1 10 7 10" />
      <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
    </>
  ),
  redo: (
    <>
      <polyline points="23 4 23 10 17 10" />
      <path d="M20.49 15a9 9 0 1 1-2.13-9.36L23 10" />
    </>
  ),
  play: <polygon points="5 3 19 12 5 21 5 3" />,
  camera: (
    <>
      <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
      <circle cx="12" cy="13" r="4" />
    </>
  ),
  share: (
    <>
      <circle cx="18" cy="5" r="3" />
      <circle cx="6" cy="12" r="3" />
      <circle cx="18" cy="19" r="3" />
      <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
      <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
    </>
  ),
  trash: (
    <>
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </>
  ),
  ticket: (
    <>
      <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.83z" />
      <line x1="7" y1="7" x2="7.01" y2="7" />
    </>
  ),
};

export default function CinemaConfigurator() {
  const mountRef = useRef(null);
  const tipRef = useRef(null);
  const markerLabelRef = useRef(null);
  const fileRef = useRef(null);
  const minimapRef = useRef(null);
  const T = useRef(null); // todo el estado three.js
  const initialRef = useRef(null);
  if (initialRef.current === null) initialRef.current = loadInitial();
  const seatStates = useRef(
    new Map(initialRef.current.states || [])
  ); // "fila-asiento" -> 'vip' | 'blocked'
  const modeRef = useRef('vip');
  const heatRef = useRef(false);
  const histRef = useRef({ stack: [], idx: -1 });
  const saveTimer = useRef(0);

  const [params, setParams] = useState(() => ({
    ...DEFAULT_PARAMS,
    ...(initialRef.current.params || {}),
  }));
  const [prices, setPrices] = useState(() => ({
    ...DEFAULT_PRICES,
    ...(initialRef.current.prices || {}),
  }));
  const [mode, setMode] = useState('vip'); // 'vip' | 'block' | 'clear' | 'pov'
  const [panelOpen, setPanelOpen] = useState(true);
  const [povUI, setPovUI] = useState(false);
  const [heatOn, setHeatOn] = useState(false);
  const [muted, setMuted] = useState(true);
  const [counts, setCounts] = useState({
    total: 0, vip: 0, blocked: 0, sold: 0, soldVip: 0,
  });
  const [vipDaeReady, setVipDaeReady] = useState(false);
  const [regenTick, setRegenTick] = useState(0);
  const [buyN, setBuyN] = useState(2);
  const [proposal, setProposal] = useState(null); // {keys, total, label}
  const [tourUI, setTourUI] = useState(false);
  const [shareMsg, setShareMsg] = useState('');
  const [isNarrow, setIsNarrow] = useState(false);

  modeRef.current = mode;

  // --------------------------------------------------------------------------
  // Serialización (export / compartir / autosave)
  // --------------------------------------------------------------------------
  const serialize = useCallback(
    () => ({
      app: 'ticketing3d',
      v: 3,
      params,
      prices,
      states: [...seatStates.current.entries()],
      sold: T.current ? [...T.current.soldSet] : [],
    }),
    [params, prices]
  );

  // --------------------------------------------------------------------------
  // Historial (deshacer / rehacer): estados de butaca + ventas manuales
  // --------------------------------------------------------------------------
  const snapshotHist = () => ({
    states: [...seatStates.current.entries()],
    sold: T.current ? [...T.current.soldSet] : [],
  });

  const pushHistory = useCallback(() => {
    const h = histRef.current;
    h.stack = h.stack.slice(0, h.idx + 1);
    h.stack.push(snapshotHist());
    if (h.stack.length > 60) h.stack.shift();
    h.idx = h.stack.length - 1;
  }, []);

  const restoreHist = useCallback((snap) => {
    const t = T.current;
    if (!t) return;
    seatStates.current = new Map(snap.states);
    t.soldSet = new Set(snap.sold);
    t.proposal = new Set();
    setProposal(null);
    if (t.seatsGroup) for (const s of t.seatsGroup.children) applySeatState(s);
    recount();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const undo = useCallback(() => {
    const h = histRef.current;
    if (h.idx < 0) return;
    // al deshacer por primera vez, guarda el presente para poder rehacer
    if (h.idx === h.stack.length - 1) {
      h.stack.push(snapshotHist());
    }
    restoreHist(h.stack[h.idx]);
    h.idx--;
  }, [restoreHist]);

  const redo = useCallback(() => {
    const h = histRef.current;
    if (h.idx >= h.stack.length - 2) return;
    h.idx++;
    restoreHist(h.stack[h.idx + 1]);
  }, [restoreHist]);

  // --------------------------------------------------------------------------
  // Montaje: escena, cámara, luces, pantalla + vídeo, audio, input, render
  // --------------------------------------------------------------------------
  useEffect(() => {
    const mount = mountRef.current;
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    mount.appendChild(renderer.domElement);
    renderer.domElement.style.touchAction = 'none';

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0b0a0e);
    scene.fog = new THREE.Fog(0x0b0a0e, 18, 90);

    const camera = new THREE.PerspectiveCamera(
      55,
      mount.clientWidth / mount.clientHeight,
      0.1,
      220
    );

    // ---- luces -------------------------------------------------------------
    scene.add(new THREE.AmbientLight(0x35343e, 0.7));

    const spot = new THREE.SpotLight(0xffd9a0, 0.85, 60, 0.95, 0.6, 1.5);
    spot.position.set(0, 9.4, 9);
    spot.castShadow = true;
    spot.shadow.mapSize.set(1024, 1024);
    spot.shadow.bias = -0.0005;
    spot.target.position.set(0, 0, 9);
    scene.add(spot, spot.target);

    const fill = new THREE.DirectionalLight(0x4a63b8, 0.28);
    fill.position.set(-10, 7, 22);
    scene.add(fill);

    // luz de "proyección": parpadea y se tiñe con el color medio del fotograma
    const projLight = new THREE.PointLight(0x7aa7ff, 1.3, 40, 2);
    projLight.position.set(0, 5, SCREEN_Z + 3.5);
    scene.add(projLight);
    const tintColor = new THREE.Color(0x7aa7ff);
    const tintCanvas = document.createElement('canvas');
    tintCanvas.width = 4;
    tintCanvas.height = 4;
    const tintCtx = tintCanvas.getContext('2d', { willReadFrequently: true });
    let tintBrightness = 0.5;

    // ---- texturas ------------------------------------------------------------
    const texLoader = new THREE.TextureLoader();
    const loadTex = (url, srgb = true) => {
      const t = texLoader.load(url);
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      if (srgb) t.encoding = THREE.sRGBEncoding;
      return t;
    };
    const texGrisFloor = loadTex('/images/texturagris.jpg');
    const texGrisWall = loadTex('/images/texturagris.jpg');
    const texLogoScreen = loadTex('/images/pantalla2.jpg');
    // ventana de la cabina de proyección (recorte del atlas proyector.JPG:
    // la versión nítida ocupa la esquina superior izquierda)
    const texProyector = loadTex('/images/proyector.JPG');
    texProyector.repeat.set(0.558, 0.352);
    texProyector.offset.set(0.008, 0.365);
    // puerta de emergencia y señal verde (assets originales)
    const texPuerta = loadTex('/images/puerta3.jpg');
    const texSenyal = loadTex('/images/senyalemer.jpg');
    // discos "MÀXIMA/MÍNIMA IMMERSIÓ": recorte al círculo dentro del atlas
    const cropDisc = (url) => {
      const tx = loadTex(url);
      tx.repeat.set(0.69, 0.68);
      tx.offset.set(0.055, 0.0);
      return tx;
    };
    const texMaxima = cropDisc('/images/maxima.JPG');
    const texMinima = cropDisc('/images/minima.jpg');
    // altavoz K.C.S.: solo la región frontal del atlas (rejilla + tweeter)
    const texSpeaker = loadTex('/images/speaker_diff.JPG');
    texSpeaker.repeat.set(0.829, 0.568);
    texSpeaker.offset.set(0.021, 0.001);
    // halo turquesa en anillo para los discos de pared (glow barato sin bloom:
    // gradiente radial con el centro transparente para no lavar el rótulo)
    const glowCv = document.createElement('canvas');
    glowCv.width = glowCv.height = 128;
    const gctx = glowCv.getContext('2d');
    const grad = gctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    grad.addColorStop(0.0, 'rgba(45,212,191,0)');
    grad.addColorStop(0.48, 'rgba(45,212,191,0)');
    grad.addColorStop(0.6, 'rgba(72,229,214,0.5)');
    grad.addColorStop(0.78, 'rgba(45,212,191,0.14)');
    grad.addColorStop(1.0, 'rgba(45,212,191,0)');
    gctx.fillStyle = grad;
    gctx.fillRect(0, 0, 128, 128);
    const texGlow = new THREE.CanvasTexture(glowCv);

    // ---- materiales compartidos ---------------------------------------------
    const mats = {
      std: new THREE.MeshStandardMaterial({ color: 0x4a4744, roughness: 0.92 }),
      vipMark: new THREE.MeshStandardMaterial({ color: 0xd8232a, roughness: 0.75 }),
      blocked: new THREE.MeshStandardMaterial({ color: 0x35323a, roughness: 0.95 }),
      sold: new THREE.MeshStandardMaterial({ color: 0x221d26, roughness: 0.95 }),
      proposal: new THREE.MeshStandardMaterial({
        color: 0x1f9d55,
        emissive: 0x34d399,
        emissiveIntensity: 0.45,
        roughness: 0.8,
      }),
      metal: new THREE.MeshStandardMaterial({ color: 0x8a8d94, metalness: 0.85, roughness: 0.35 }),
      shell: new THREE.MeshStandardMaterial({ color: 0x17161a, roughness: 0.6 }),
      tray: new THREE.MeshStandardMaterial({ color: 0x111013, roughness: 0.5 }),
      floor: new THREE.MeshStandardMaterial({ map: texGrisFloor, color: 0x8f8f96, roughness: 0.98 }),
      wall: new THREE.MeshStandardMaterial({ map: texGrisWall, color: 0x77747e, roughness: 0.95 }),
      ceiling: new THREE.MeshStandardMaterial({ color: 0x0d0c10, roughness: 1 }),
      platform: new THREE.MeshStandardMaterial({ color: 0x232028, roughness: 0.9 }),
      stair: new THREE.MeshStandardMaterial({ color: 0x2b2830, roughness: 0.9 }),
      led: new THREE.MeshStandardMaterial({
        color: 0x0a1a3a,
        emissive: 0x2b6bff,
        emissiveIntensity: 2.2,
      }),
      speakerFront: new THREE.MeshStandardMaterial({ map: texSpeaker, roughness: 0.85 }),
      speakerBox: new THREE.MeshStandardMaterial({ color: 0x0e0d10, roughness: 0.7 }),
      discMax: new THREE.MeshBasicMaterial({ map: texMaxima, toneMapped: false }),
      discMin: new THREE.MeshBasicMaterial({ map: texMinima, toneMapped: false }),
      discPlain: new THREE.MeshStandardMaterial({ color: 0x060609, roughness: 0.4 }),
      ring: new THREE.MeshStandardMaterial({
        color: 0x07211f,
        emissive: 0x2dd4bf, // azul turquesa
        emissiveIntensity: 0.85, // sin saturar a blanco con el tonemapping
      }),
      glow: new THREE.MeshBasicMaterial({
        map: texGlow,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
      proyector: new THREE.MeshBasicMaterial({ map: texProyector, toneMapped: false }),
      door: new THREE.MeshStandardMaterial({ map: texPuerta, roughness: 0.85 }),
      senyal: new THREE.MeshBasicMaterial({ map: texSenyal, toneMapped: false }),
      curtain: new THREE.MeshStandardMaterial({ color: 0x0a090d, roughness: 1 }),
      slab: new THREE.MeshStandardMaterial({ color: 0x141218, roughness: 0.8 }),
      heat: [
        new THREE.MeshStandardMaterial({ color: 0x2f9e44, emissive: 0x2f9e44, emissiveIntensity: 0.35, roughness: 0.85 }),
        new THREE.MeshStandardMaterial({ color: 0xe8a013, emissive: 0xe8a013, emissiveIntensity: 0.35, roughness: 0.85 }),
        new THREE.MeshStandardMaterial({ color: 0xd9480f, emissive: 0xd9480f, emissiveIntensity: 0.35, roughness: 0.85 }),
      ],
    };

    // geometrías unitarias compartidas (se escalan por mesh, nunca se disponen)
    const unitBox = new THREE.BoxGeometry(1, 1, 1);
    const unitPlane = new THREE.PlaneGeometry(1, 1);

    // ---- vídeo + pantalla (la geometría se construye en cada regeneración) ---
    const video = document.createElement('video');
    video.src = TRAILER_URL;
    video.crossOrigin = 'anonymous';
    video.loop = true;
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    const videoTex = new THREE.VideoTexture(video);
    videoTex.encoding = THREE.sRGBEncoding;
    videoTex.wrapS = THREE.RepeatWrapping;
    texLogoScreen.wrapS = THREE.RepeatWrapping;

    const screenMat = new THREE.MeshBasicMaterial({
      map: texLogoScreen, // logo del cine hasta que arranca el trailer
      side: THREE.BackSide,
      toneMapped: false,
    });
    video.addEventListener('playing', () => {
      screenMat.map = videoTex;
      screenMat.needsUpdate = true;
    });
    const tryPlay = () => video.play().catch(() => {});
    tryPlay();
    const gesturePlay = () => {
      tryPlay();
      window.removeEventListener('pointerdown', gesturePlay);
    };
    window.addEventListener('pointerdown', gesturePlay);

    const screenGroup = new THREE.Group();
    scene.add(screenGroup);

    // ---- baliza de butaca seleccionada (flecha + aro que saltan de butaca en
    // butaca mostrando cada posición de la propuesta de compra) ----------------
    const markerMat = new THREE.MeshStandardMaterial({
      color: 0x1f9d55,
      emissive: 0x34d399,
      emissiveIntensity: 1.1,
    });
    const markerGrp = new THREE.Group();
    const markerCone = new THREE.Mesh(
      new THREE.ConeGeometry(0.16, 0.36, 16),
      markerMat
    );
    markerCone.rotation.x = Math.PI; // apunta hacia abajo
    markerGrp.add(markerCone);
    const markerRing = new THREE.Mesh(
      new THREE.TorusGeometry(0.34, 0.028, 8, 36),
      markerMat
    );
    markerRing.rotation.x = Math.PI / 2;
    markerRing.position.y = -0.5;
    markerGrp.add(markerRing);
    markerGrp.visible = false;
    scene.add(markerGrp);
    const markerPos = new THREE.Vector3();

    // ---- audio posicional del trailer (arranca al pulsar Sonido) --------------
    const listener = new THREE.AudioListener();
    camera.add(listener);
    let posAudio = null;
    try {
      posAudio = new THREE.PositionalAudio(listener);
      posAudio.setMediaElementSource(video);
      posAudio.setRefDistance(9);
      posAudio.setRolloffFactor(1.1);
      scene.add(posAudio);
    } catch (err) {
      posAudio = null; // sin audio posicional: el vídeo sonará en estéreo
    }

    // recorte UV tipo "object-fit: cover": la imagen llena la superficie sin
    // deformarse, recortando lo que sobre. En el cilindro visto desde dentro
    // la U va invertida (espejo).
    const coverUV = (tex, contentAspect, surfaceAspect, vBase) => {
      const v0 = vBase ? vBase.y : 0;
      const vh = vBase ? vBase.h : 1;
      if (contentAspect >= surfaceAspect) {
        const fw = surfaceAspect / contentAspect;
        tex.repeat.set(-fw, vh);
        tex.offset.set((1 + fw) / 2, v0);
      } else {
        const fh = contentAspect / surfaceAspect;
        tex.repeat.set(-1, vh * fh);
        tex.offset.set(1, v0 + (vh * (1 - fh)) / 2);
      }
    };

    // construye la pantalla (superficie de vídeo + panel con grosor) para un
    // ancho/alto dados. Se llama en cada regeneración.
    const buildScreen = (hallW, screenWPct, screenHParam) => {
      const t = T.current;
      // limpiar la construcción anterior (geometrías propias → dispose)
      [...screenGroup.children].forEach((ch) => {
        screenGroup.remove(ch);
        if (ch.geometry) ch.geometry.dispose();
      });

      const W = Math.max(4, (hallW - 0.8) * (screenWPct / 100));
      const H = Math.min(screenHParam, HALL_H - SCREEN_BOTTOM - 0.4);
      const halfW = W / 2;
      const R = Math.max(16, halfW * 2.2); // radio grande → curvatura suave
      const h = Math.asin(halfW / R);
      const cy = SCREEN_BOTTOM + H / 2;
      const cz = SCREEN_Z + R;
      const TH = 0.3; // grosor del panel

      screenGroup.position.set(0, cy, cz);

      const surf = new THREE.Mesh(
        new THREE.CylinderGeometry(R, R, H, 64, 1, true, Math.PI - h, h * 2),
        screenMat
      );
      screenGroup.add(surf);

      const backShell = new THREE.Mesh(
        new THREE.CylinderGeometry(R + TH, R + TH, H, 64, 1, true, Math.PI - h, h * 2),
        mats.slab
      );
      screenGroup.add(backShell);

      const lidTop = new THREE.Mesh(
        new THREE.RingGeometry(R, R + TH, 48, 1, Math.PI / 2 - h, h * 2),
        mats.slab
      );
      lidTop.rotation.x = -Math.PI / 2;
      lidTop.position.y = H / 2;
      const lidBot = new THREE.Mesh(
        new THREE.RingGeometry(R, R + TH, 48, 1, -Math.PI / 2 - h, h * 2),
        mats.slab
      );
      lidBot.rotation.x = Math.PI / 2;
      lidBot.position.y = -H / 2;
      screenGroup.add(lidTop, lidBot);

      for (const s of [-1, 1]) {
        const cap = new THREE.Mesh(new THREE.BoxGeometry(TH, H, 0.06), mats.slab);
        const rMid = R + TH / 2;
        cap.position.set(s * rMid * Math.sin(h), 0, -rMid * Math.cos(h));
        cap.rotation.y = Math.PI / 2 - s * h;
        screenGroup.add(cap);
      }

      // encaje del vídeo/logo sin deformación (cover) sobre el arco real
      const surfaceAspect = (2 * h * R) / H;
      coverUV(videoTex, VIDEO_ASPECT, surfaceAspect, VIDEO_CROP);
      coverUV(texLogoScreen, 1, surfaceAspect, null);

      t.screenInfo = { W, H, cy };
      t.screenCenter.set(0, cy, SCREEN_Z);
      projLight.position.set(0, cy, SCREEN_Z + 3.5);
      if (posAudio) posAudio.position.set(0, cy, SCREEN_Z + 0.5);
    };

    // ---- plantillas de butaca (fusionadas en pocos meshes por butaca) --------
    // bake: aplasta un grupo de primitivas en 1 mesh por material — de ~11
    // draw calls por butaca a 3 (clave para salas de 700+ butacas)
    const bakeTemplate = (group) => {
      group.updateMatrixWorld(true);
      const buckets = new Map();
      group.traverse((m) => {
        if (!m.isMesh) return;
        const swap = m.name === 'swap';
        const key = swap ? 'swap' : m.material.uuid;
        if (!buckets.has(key)) buckets.set(key, { mat: m.material, swap, geos: [] });
        const g = m.geometry.clone();
        g.applyMatrix4(m.matrixWorld);
        buckets.get(key).geos.push(g);
      });
      const out = new THREE.Group();
      for (const b of buckets.values()) {
        const merged = BufferGeometryUtils.mergeBufferGeometries(b.geos, false);
        b.geos.forEach((g) => g.dispose());
        const mesh = new THREE.Mesh(merged, b.mat);
        if (b.swap) mesh.name = 'swap';
        mesh.castShadow = true;
        out.add(mesh);
      }
      return out;
    };

    function buildStandardTemplate() {
      const g = new THREE.Group();
      const cyl = new THREE.CylinderGeometry(1, 1, 1, 12);
      const add = (parent, geo, mat, x, y, z, sx, sy, sz, swap = false) => {
        const m = new THREE.Mesh(geo, mat);
        m.position.set(x, y, z);
        m.scale.set(sx, sy, sz);
        if (swap) m.name = 'swap';
        parent.add(m);
        return m;
      };
      // placa cuadrada + pie central metálico (sin patas)
      add(g, unitBox, mats.metal, 0, 0.012, 0.04, 0.42, 0.024, 0.42);
      add(g, cyl, mats.metal, 0, 0.19, 0.04, 0.045, 0.34, 0.045);
      // cojín grueso con frontal redondeado
      add(g, unitBox, mats.std, 0, 0.43, 0.02, 0.5, 0.15, 0.46, true);
      const front = add(g, cyl, mats.std, 0, 0.43, -0.215, 0.075, 0.5, 0.075, true);
      front.rotation.z = Math.PI / 2;
      // respaldo inclinado ~8° (grupo pivotado)
      const tilt = new THREE.Group();
      tilt.position.set(0, 0.36, 0.17);
      tilt.rotation.x = (8 * Math.PI) / 180;
      g.add(tilt);
      add(tilt, unitBox, mats.std, 0, 0.3, 0.02, 0.5, 0.58, 0.11, true); // respaldo
      const top = add(tilt, cyl, mats.std, 0, 0.59, 0.02, 0.055, 0.5, 0.055, true);
      top.rotation.z = Math.PI / 2; // remate superior redondeado
      add(tilt, unitBox, mats.std, 0, 0.09, -0.05, 0.44, 0.22, 0.06, true); // lumbar
      add(tilt, unitBox, mats.shell, 0, 0.31, 0.09, 0.53, 0.66, 0.035); // carcasa
      // reposabrazos flotantes sobre soporte fino
      for (const s of [-1, 1]) {
        add(g, cyl, mats.metal, s * 0.31, 0.4, 0.06, 0.018, 0.32, 0.018);
        add(g, unitBox, mats.std, s * 0.31, 0.585, 0.02, 0.11, 0.055, 0.42, true);
      }
      return bakeTemplate(g);
    }

    function buildVipFallbackTemplate() {
      const g = new THREE.Group();
      const cyl = new THREE.CylinderGeometry(1, 1, 1, 12);
      const add = (parent, geo, mat, x, y, z, sx, sy, sz, swap = false) => {
        const m = new THREE.Mesh(geo, mat);
        m.position.set(x, y, z);
        m.scale.set(sx, sy, sz);
        if (swap) m.name = 'swap';
        parent.add(m);
        return m;
      };
      add(g, unitBox, mats.metal, 0, 0.012, 0.06, 0.5, 0.024, 0.5);
      add(g, cyl, mats.metal, 0, 0.16, 0.06, 0.05, 0.28, 0.05);
      add(g, unitBox, mats.vipMark, 0, 0.38, 0, 0.62, 0.17, 0.52, true); // cojín
      add(g, unitBox, mats.vipMark, 0, 0.3, -0.42, 0.56, 0.09, 0.34, true); // reposapiés
      const tilt = new THREE.Group();
      tilt.position.set(0, 0.32, 0.2);
      tilt.rotation.x = (14 * Math.PI) / 180;
      g.add(tilt);
      add(tilt, unitBox, mats.vipMark, 0, 0.22, 0.02, 0.6, 0.42, 0.13, true);
      add(tilt, unitBox, mats.vipMark, 0, 0.52, 0.04, 0.58, 0.22, 0.12, true);
      add(tilt, unitBox, mats.vipMark, 0, 0.68, 0.02, 0.4, 0.12, 0.1, true); // almohada
      add(tilt, unitBox, mats.shell, 0, 0.4, 0.11, 0.62, 0.72, 0.04);
      for (const s of [-1, 1])
        add(g, unitBox, mats.vipMark, s * 0.37, 0.5, 0, 0.13, 0.1, 0.46, true);
      // brazo-bandeja negro con portavasos (derecha)
      add(g, unitBox, mats.tray, 0.49, 0.52, -0.05, 0.16, 0.035, 0.3);
      add(g, cyl, mats.tray, 0.49, 0.55, -0.14, 0.05, 0.05, 0.05);
      return bakeTemplate(g);
    }

    // ---- estado three --------------------------------------------------------
    T.current = {
      renderer, scene, camera, mats, unitBox, unitPlane, video, videoTex,
      projLight, spot, screenGroup, buildScreen, posAudio, listener,
      stdTemplate: buildStandardTemplate(),
      vipTemplate: buildVipFallbackTemplate(),
      vipModel: 'proc', // 'proc' | 'dae'
      vipBaseMats: {}, // nombre de mesh -> material original del dae
      seatsGroup: null, standGroup: null, roomGroup: null, signsGroup: null,
      seatList: [], // [{key, autoVip, row, col, px, pz, score}]
      seatByKey: new Map(),
      rowMeta: new Map(), // fila -> {n, isVip}
      occupiedSet: new Set(), // ventas simuladas (slider)
      soldSet: new Set(initialRef.current.sold || []), // ventas manuales
      proposal: new Set(), // propuesta de compra activa
      disposables: [], // geometrías creadas por regeneración
      labelCache: {}, // texto -> material con CanvasTexture (números de fila)
      rowBands: [], // [{z0, z1, y}] para colisión de cámara con el graderío
      hallBounds: { halfW: 10, zBack: 20 },
      screenInfo: { W: 12, H: 8, cy: 5 },
      screenCenter: new THREE.Vector3(0, 5, SCREEN_Z),
      orbit: { theta: 0, phi: 0.16, radius: 30, target: new THREE.Vector3(0, 0, 3) },
      homeView: { theta: 0, phi: 0.16, radius: 30, target: new THREE.Vector3(0, 0, 3) },
      pov: { active: false, eye: new THREE.Vector3(), yaw: 0, pitch: 0 },
      flight: null,
      tourActive: false,
      tourTimer: 0,
      marker: markerGrp,
      markerKeys: [],
      markerIdx: 0,
      markerNextAt: 0,
      lastLookTarget: new THREE.Vector3(0, 0, 3),
      raycaster: new THREE.Raycaster(),
      pointers: new Map(),
      downInfo: null,
      painting: false,
      lastPaintKey: null,
      lastPaintTime: 0,
      lastHoverTime: 0,
      lastTintTime: 0,
      pinchDist: 0,
      raf: 0,
    };

    // ---- carga del modelo VIP real (butacavip.dae) ---------------------------
    const daeLoader = new ColladaLoader();
    daeLoader.load(
      '/Cine/butacavip/butacavip.dae',
      (collada) => {
        const t = T.current;
        if (!t) return;
        const root = collada.scene;
        root.updateMatrixWorld(true);
        const meshes = [];
        root.traverse((o) => o.isMesh && meshes.push(o));
        if (!meshes.length) return;
        const tpl = new THREE.Group();
        const normalTex = texLoader.load('/Cine/butacavip/images/normal.JPG');
        meshes.forEach((m, i) => {
          const src = Array.isArray(m.material) ? m.material[0] : m.material;
          // material estándar propio: el Phong del Collada responde mal a la
          // iluminación de la escena (especular plástico, tonos apagados)
          const mat = new THREE.MeshStandardMaterial({
            map: (src && src.map) || null,
            normalMap: normalTex,
            roughness: 0.72,
            metalness: 0.05,
          });
          if (mat.map) mat.map.encoding = THREE.sRGBEncoding;
          const mesh = new THREE.Mesh(m.geometry, mat);
          mesh.applyMatrix4(m.matrixWorld);
          mesh.name = 'swap_' + i;
          mesh.castShadow = true;
          t.vipBaseMats[mesh.name] = mat;
          tpl.add(mesh);
        });
        // normalizar: apoyada en el suelo, centrada, ~1.05 m de alto, mirando -z.
        // El giro de 180° (el .dae viene mirando a +z) va en un grupo intermedio
        // para que el rotation.y por butaca (curvatura) no lo machaque.
        const bb = new THREE.Box3().setFromObject(tpl);
        const size = bb.getSize(new THREE.Vector3());
        const s = 1.05 / size.y;
        const wrap = new THREE.Group();
        const spin = new THREE.Group();
        spin.rotation.y = Math.PI;
        spin.add(tpl);
        wrap.add(spin);
        tpl.scale.setScalar(s);
        bb.setFromObject(tpl);
        const c = bb.getCenter(new THREE.Vector3());
        tpl.position.set(-c.x, -bb.min.y, -c.z);
        t.vipTemplate = wrap;
        t.vipModel = 'dae';
        setVipDaeReady(true);
      },
      undefined,
      () => {} // si falla, se mantiene el fallback procedural
    );

    // ---- cámara: helpers ------------------------------------------------------
    const orbitPos = (o) =>
      new THREE.Vector3(
        o.target.x + o.radius * Math.sin(o.phi) * Math.sin(o.theta),
        o.target.y + o.radius * Math.cos(o.phi),
        o.target.z + o.radius * Math.sin(o.phi) * Math.cos(o.theta)
      );

    // altura del graderío bajo un punto (colisión suave de cámara)
    const standTopAt = (x, z) => {
      const t = T.current;
      if (Math.abs(x) > t.hallBounds.halfW + 1.5) return 0;
      for (const band of t.rowBands) {
        if (z >= band.z0 && z <= band.z1) return band.y;
      }
      return 0;
    };

    const flyTo = (toPos, toTgt, onDone, dur = FLY_MS) => {
      const t = T.current;
      t.flight = {
        t0: performance.now(),
        dur,
        fromPos: camera.position.clone(),
        toPos: toPos.clone(),
        fromTgt: t.lastLookTarget.clone(),
        toTgt: toTgt.clone(),
        onDone,
      };
    };

    const dirFromYawPitch = (yaw, pitch) =>
      new THREE.Vector3(
        Math.cos(pitch) * Math.sin(yaw),
        Math.sin(pitch),
        Math.cos(pitch) * Math.cos(yaw)
      );

    // ---- tooltip de butaca -----------------------------------------------------
    const hideTip = () => {
      if (tipRef.current) tipRef.current.style.display = 'none';
    };
    const showTip = (x, y, text) => {
      const el2 = tipRef.current;
      if (!el2) return;
      el2.textContent = text;
      el2.style.display = 'block';
      el2.style.left = `${x + 14}px`;
      el2.style.top = `${y + 14}px`;
    };

    const enterPovAt = (seatGroup) => {
      const t = T.current;
      const p = seatGroup.getWorldPosition(new THREE.Vector3());
      const eye = new THREE.Vector3(p.x, p.y + 1.15, p.z);
      setPanelOpen(false);
      hideTip();
      flyTo(eye, t.screenCenter, () => {
        t.pov.active = true;
        t.pov.eye.copy(eye);
        const d = t.screenCenter.clone().sub(eye).normalize();
        t.pov.yaw = Math.atan2(d.x, d.z);
        t.pov.pitch = Math.asin(THREE.MathUtils.clamp(d.y, -1, 1));
        setPovUI(true);
      });
    };
    T.current.enterPovAt = enterPovAt;

    // volver a la vista cenital que encuadra toda la sala (desde POV o desde
    // cualquier posición orbital)
    T.current.goHome = () => {
      const t = T.current;
      if (t.flight) return;
      const home = t.homeView;
      t.orbit.theta = home.theta;
      t.orbit.phi = home.phi;
      t.orbit.radius = home.radius;
      t.orbit.target.copy(home.target);
      setPovUI(false);
      flyTo(orbitPos(t.orbit), t.orbit.target, () => {
        t.pov.active = false;
      });
    };

    // ---- recorrido cinemático por la sala --------------------------------------
    // Un paseo continuo y legible: la cámara entra por lo alto del pasillo
    // central, baja siguiendo la rampa del graderío mirando siempre a la
    // pantalla, llega a primera fila, se gira frente al patio de butacas y
    // vuelve a la vista general. Sin cortes ni saltos de objetivo.
    T.current.startTour = () => {
      const t = T.current;
      if (t.flight || t.tourActive) return;
      t.tourActive = true;
      t.pov.active = false;
      setPovUI(false);
      setTourUI(true);
      setPanelOpen(false);
      const hb = t.hallBounds;
      const sc = t.screenCenter;
      const midZ = (Z_START + hb.zBack) / 2;
      const topY = t.rowBands.length
        ? t.rowBands[t.rowBands.length - 1].y
        : 2.2;
      const v3 = (a) => new THREE.Vector3(a[0], a[1], a[2]);
      const legs = [
        // 1. alto del pasillo central, tras la última fila
        { p: [0, topY + 2.3, hb.zBack - 1.2], t: [0, sc.y, SCREEN_Z], d: 2400 },
        // 2. bajando la rampa por el pasillo, a media sala
        { p: [0, topY / 2 + 1.9, midZ], t: [0, sc.y * 0.9, SCREEN_Z], d: 2600 },
        // 3. llegada a primera fila, a pie de pantalla
        { p: [0, 1.7, Z_START - 1.4], t: [0, sc.y, SCREEN_Z], d: 2600 },
        // 4. giro lateral frente al graderío: se ve toda la sala de butacas
        {
          p: [-Math.min(hb.halfW - 1.4, 6.5), 2.8, SCREEN_Z + 6.5],
          t: [0, 1.8, midZ],
          d: 2800,
        },
      ];
      let i = 0;
      const next = () => {
        const tt = T.current;
        if (!tt || !tt.tourActive) return;
        if (i >= legs.length) {
          tt.tourActive = false;
          setTourUI(false);
          tt.goHome();
          return;
        }
        const L = legs[i++];
        flyTo(v3(L.p), v3(L.t), next, L.d);
      };
      next();
    };

    // ---- captura PNG de la vista actual -----------------------------------------
    T.current.snapshot = () => {
      renderer.render(scene, camera);
      return renderer.domElement.toDataURL('image/png');
    };

    // ---- picking ----------------------------------------------------------------
    const pickAt = (clientX, clientY) => {
      const t = T.current;
      const rect = renderer.domElement.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((clientX - rect.left) / rect.width) * 2 - 1,
        -((clientY - rect.top) / rect.height) * 2 + 1
      );
      t.raycaster.setFromCamera(ndc, camera);
      const targets = [t.seatsGroup, t.signsGroup].filter(Boolean);
      if (!targets.length) return null;
      const hits = t.raycaster.intersectObjects(targets, true);
      for (const hh of hits) {
        let o = hh.object;
        if (o.userData.rowSign !== undefined) return { sign: o.userData.rowSign };
        while (o && !o.userData.isSeat) o = o.parent;
        if (o) return { seat: o };
      }
      return null;
    };

    const applyModeTo = (seat) => {
      const m = modeRef.current;
      const key = seat.userData.key;
      if (m === 'vip') seatStates.current.set(key, 'vip');
      else if (m === 'block') seatStates.current.set(key, 'blocked');
      else if (m === 'clear') {
        seatStates.current.delete(key);
        T.current.soldSet.delete(key); // Normal también libera la venta manual
      }
      applySeatState(seat);
      recount();
    };
    T.current.applyModeTo = applyModeTo;

    const applyModeToRow = (row) => {
      const t = T.current;
      for (const seat of t.seatsGroup.children) {
        if (seat.userData.row !== row) continue;
        applyModeTo(seat);
      }
      recount();
    };

    // ---- interacción: puntero / táctil / rueda --------------------------------
    const el = renderer.domElement;
    const MARK_MODES = ['vip', 'block', 'clear'];

    const onPointerDown = (e) => {
      const t = T.current;
      hideTip();
      // cancelar el recorrido demo con cualquier gesto
      if (t.tourActive) {
        t.tourActive = false;
        setTourUI(false);
        t.flight = null;
        t.goHome();
        return;
      }
      // un ratón solo puede tener un puntero: purga posibles "fantasmas"
      // (pointerup perdidos) que bloquearían los clicks para siempre
      if (e.pointerType === 'mouse') t.pointers.clear();
      t.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (t.pointers.size === 2) {
        const [a, b] = [...t.pointers.values()];
        t.pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
      }
      t.downInfo = { x: e.clientX, y: e.clientY, dragged: false };
      el.setPointerCapture && el.setPointerCapture(e.pointerId);

      // modo pintar: si el gesto EMPIEZA sobre una butaca en un modo de marcado,
      // el arrastre marca butacas en vez de orbitar
      if (
        !t.flight && !t.pov.active &&
        t.pointers.size === 1 &&
        MARK_MODES.includes(modeRef.current)
      ) {
        const res = pickAt(e.clientX, e.clientY);
        if (res && res.seat) {
          pushHistory();
          t.painting = true;
          t.lastPaintKey = res.seat.userData.key;
          applyModeTo(res.seat);
        }
      }
    };

    const onPointerMove = (e) => {
      const t = T.current;
      if (!t.pointers.has(e.pointerId)) {
        // puntero sin botón pulsado → hover con tooltip
        const now = performance.now();
        if (t.pov.active || t.flight || now - t.lastHoverTime < 90) return;
        t.lastHoverTime = now;
        const res = pickAt(e.clientX, e.clientY);
        if (res && res.seat) {
          const u = res.seat.userData;
          const st = seatStates.current.get(u.key);
          let extra = '';
          if (st === 'blocked') extra = ' · Bloqueada';
          else if (t.soldSet.has(u.key) || t.occupiedSet.has(u.key))
            extra = ' · Vendida';
          else if (st === 'vip' || u.autoVip) extra = ' · VIP';
          showTip(e.clientX, e.clientY, `Fila ${u.row + 1} · Butaca ${u.col + 1}${extra}`);
        } else if (res && res.sign !== undefined) {
          showTip(e.clientX, e.clientY, `Fila ${res.sign + 1} — toca para marcar toda la fila`);
        } else {
          hideTip();
        }
        return;
      }

      const prev = t.pointers.get(e.pointerId);
      const dx = e.clientX - prev.x;
      const dy = e.clientY - prev.y;
      t.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (t.downInfo) {
        const totalDx = e.clientX - t.downInfo.x;
        const totalDy = e.clientY - t.downInfo.y;
        if (Math.hypot(totalDx, totalDy) > 6) t.downInfo.dragged = true;
      }
      if (t.flight) return;

      if (t.painting) {
        const now = performance.now();
        if (now - t.lastPaintTime < 40) return;
        t.lastPaintTime = now;
        const res = pickAt(e.clientX, e.clientY);
        if (res && res.seat && res.seat.userData.key !== t.lastPaintKey) {
          t.lastPaintKey = res.seat.userData.key;
          applyModeTo(res.seat);
        }
        return;
      }

      if (t.pointers.size === 2) {
        // pellizco = zoom (solo vista orbital)
        const [a, b] = [...t.pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (t.pinchDist > 0 && !t.pov.active) {
          t.orbit.radius = THREE.MathUtils.clamp(
            t.orbit.radius * (t.pinchDist / d), 6, 55
          );
        }
        t.pinchDist = d;
        return;
      }
      if (!t.downInfo || !t.downInfo.dragged) return;

      if (t.pov.active) {
        t.pov.yaw -= dx * 0.0032;
        t.pov.pitch = THREE.MathUtils.clamp(t.pov.pitch - dy * 0.0032, -1.2, 1.2);
      } else {
        t.orbit.theta -= dx * 0.0055;
        t.orbit.phi = THREE.MathUtils.clamp(t.orbit.phi - dy * 0.0045, 0.15, 1.45);
      }
    };

    const onPointerUp = (e) => {
      const t = T.current;
      t.pointers.delete(e.pointerId);
      const info = t.downInfo;
      const wasPainting = t.painting;
      if (t.pointers.size === 0) {
        t.downInfo = null;
        t.painting = false;
        t.lastPaintKey = null;
      }
      if (wasPainting) return; // el pintado ya aplicó los cambios
      if (!info || info.dragged || t.flight || t.pointers.size > 0) return;

      // click limpio → raycast a butacas y rótulos de fila
      const res = pickAt(e.clientX, e.clientY);
      if (!res) return;
      if (res.sign !== undefined) {
        if (MARK_MODES.includes(modeRef.current)) {
          pushHistory();
          applyModeToRow(res.sign);
        }
        return;
      }
      const seat = res.seat;
      const m = modeRef.current;
      if (m === 'pov' || t.pov.active) {
        enterPovAt(seat);
        return;
      }
      applyModeTo(seat);
    };

    const onWheel = (e) => {
      const t = T.current;
      if (t.pov.active || t.flight) return;
      e.preventDefault();
      t.orbit.radius = THREE.MathUtils.clamp(
        t.orbit.radius * (1 + e.deltaY * 0.001), 6, 55
      );
    };

    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('pointermove', onPointerMove);
    // pointerup en window: si el gesto termina fuera del canvas no se pierde
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
    el.addEventListener('wheel', onWheel, { passive: false });

    const onResize = () => {
      camera.aspect = mount.clientWidth / mount.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(mount.clientWidth, mount.clientHeight);
    };
    window.addEventListener('resize', onResize);

    // ---- bucle de render -------------------------------------------------------
    const animate = () => {
      const t = T.current;
      const now = performance.now();

      // tinte de la luz de proyección con el color medio del fotograma
      if (now - t.lastTintTime > 240 && video.readyState >= 2 && !video.paused) {
        t.lastTintTime = now;
        try {
          tintCtx.drawImage(video, 0, 0, 4, 4);
          const d = tintCtx.getImageData(0, 0, 4, 4).data;
          let r = 0, g = 0, b = 0;
          for (let i = 0; i < d.length; i += 4) {
            r += d[i]; g += d[i + 1]; b += d[i + 2];
          }
          const n = d.length / 4;
          r /= 255 * n; g /= 255 * n; b /= 255 * n;
          tintBrightness = Math.max(r, g, b);
          const v = Math.max(tintBrightness, 0.001);
          // normaliza el tono y mézclalo con un azul base de proyector
          tintColor.setRGB(
            (r / v) * 0.85 + 0.15 * 0.48,
            (g / v) * 0.85 + 0.15 * 0.65,
            (b / v) * 0.85 + 0.15 * 1.0
          );
        } catch (err) { /* el fotograma aún no está disponible */ }
      }
      const s = now * 0.001;
      const flicker =
        1 + 0.22 * Math.sin(s * 13.7) * Math.sin(s * 7.3) + 0.08 * Math.sin(s * 2.1);
      projLight.color.lerp(tintColor, 0.12);
      projLight.intensity = flicker * (0.55 + 1.5 * tintBrightness);

      if (t.flight) {
        const k = Math.min(1, (now - t.flight.t0) / (t.flight.dur || FLY_MS));
        const e = easeInOutCubic(k);
        camera.position.lerpVectors(t.flight.fromPos, t.flight.toPos, e);
        t.lastLookTarget.lerpVectors(t.flight.fromTgt, t.flight.toTgt, e);
        camera.lookAt(t.lastLookTarget);
        if (k >= 1) {
          const done = t.flight.onDone;
          t.flight = null;
          done && done();
        }
      } else if (t.pov.active) {
        // balanceo de cabeza muy sutil
        camera.position.set(
          t.pov.eye.x,
          t.pov.eye.y + Math.sin(now * 0.0013) * 0.012,
          t.pov.eye.z
        );
        const d = dirFromYawPitch(t.pov.yaw, t.pov.pitch);
        t.lastLookTarget.copy(camera.position).add(d);
        camera.lookAt(t.lastLookTarget);
      } else {
        const pos = orbitPos(t.orbit);
        // no dejar que la cámara se hunda en el graderío ni bajo el suelo
        const minY = Math.max(0.6, standTopAt(pos.x, pos.z) + 0.9);
        if (pos.y < minY) pos.y = minY;
        camera.position.copy(pos);
        t.lastLookTarget.copy(t.orbit.target);
        camera.lookAt(t.orbit.target);
      }

      // baliza de butacas seleccionadas: salta de una a otra cada 1,6 s,
      // flota sobre la butaca activa y proyecta su etiqueta "Fila · Butaca"
      const mk = t.markerKeys;
      const lbl = markerLabelRef.current;
      if (mk.length && t.seatByKey.size) {
        if (now >= t.markerNextAt) {
          t.markerIdx = (t.markerIdx + 1) % mk.length;
          t.markerNextAt = now + 1600;
        }
        const seat = t.seatByKey.get(mk[t.markerIdx % mk.length]);
        if (seat) {
          seat.getWorldPosition(markerPos);
          const bob = Math.sin(now * 0.005) * 0.07;
          t.marker.position.set(
            markerPos.x,
            markerPos.y + 1.6 + bob,
            markerPos.z
          );
          t.marker.rotation.y = now * 0.0012;
          t.marker.visible = true;
          if (lbl) {
            markerPos.y += 2.1;
            markerPos.project(camera);
            if (markerPos.z < 1) {
              const u = seat.userData;
              lbl.textContent = `Fila ${u.row + 1} · Butaca ${u.col + 1}  (${
                (t.markerIdx % mk.length) + 1
              }/${mk.length})`;
              lbl.style.display = 'block';
              lbl.style.left = `${(markerPos.x * 0.5 + 0.5) * mount.clientWidth}px`;
              lbl.style.top = `${(-markerPos.y * 0.5 + 0.5) * mount.clientHeight}px`;
            } else {
              lbl.style.display = 'none';
            }
          }
        }
      } else {
        t.marker.visible = false;
        if (lbl) lbl.style.display = 'none';
      }

      renderer.render(scene, camera);
      t.raf = requestAnimationFrame(animate);
    };
    T.current.raf = requestAnimationFrame(animate);

    // ---- limpieza ---------------------------------------------------------------
    return () => {
      const t = T.current;
      cancelAnimationFrame(t.raf);
      window.clearTimeout(t.tourTimer);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('pointerdown', gesturePlay);
      el.removeEventListener('pointerdown', onPointerDown);
      el.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
      el.removeEventListener('wheel', onWheel);
      video.pause();
      video.removeAttribute('src');
      video.load();
      if (posAudio) {
        try { posAudio.disconnect(); } catch (err) { /* ya desconectado */ }
      }
      renderer.dispose();
      mount.removeChild(renderer.domElement);
      T.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --------------------------------------------------------------------------
  // Estado visual de una butaca (solo material, nunca la geometría)
  // Prioridad: mapa de visión > bloqueada > propuesta > vendida > VIP > base
  // --------------------------------------------------------------------------
  const applySeatState = useCallback((seatGroup) => {
    const t = T.current;
    if (!t) return;
    const key = seatGroup.userData.key;
    const state = seatStates.current.get(key) || null;
    const isDae = seatGroup.userData.model === 'dae';
    const isVipProc = seatGroup.userData.model === 'vipproc';
    let override = null;
    if (heatRef.current) override = t.mats.heat[seatGroup.userData.heat || 0];
    else if (state === 'blocked') override = t.mats.blocked;
    else if (t.proposal.has(key)) override = t.mats.proposal;
    else if (t.soldSet.has(key) || t.occupiedSet.has(key)) override = t.mats.sold;
    else if (state === 'vip' && !isDae) override = t.mats.vipMark;
    seatGroup.traverse((m) => {
      if (!m.isMesh || !m.name.startsWith('swap')) return;
      if (override) m.material = override;
      else
        m.material = isDae
          ? t.vipBaseMats[m.name]
          : isVipProc
            ? t.mats.vipMark
            : t.mats.std;
    });
  }, []);

  // --------------------------------------------------------------------------
  // Minimapa 2D sincronizado
  // --------------------------------------------------------------------------
  const drawMinimap = useCallback(() => {
    const t = T.current;
    const cv = minimapRef.current;
    if (!t || !cv || !t.seatList.length) return;
    const seats = t.seatList;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const s of seats) {
      if (s.px < minX) minX = s.px;
      if (s.px > maxX) maxX = s.px;
      if (s.pz < minZ) minZ = s.pz;
      if (s.pz > maxZ) maxZ = s.pz;
    }
    const cssW = 178;
    const pad = 10;
    const scale = (cssW - pad * 2) / Math.max(1, maxX - minX);
    const cssH = (maxZ - minZ) * scale + pad * 2 + 12;
    const dpr = 2;
    cv.width = cssW * dpr;
    cv.height = cssH * dpr;
    cv.style.width = `${cssW}px`;
    cv.style.height = `${cssH}px`;
    const ctx = cv.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, cssW, cssH);
    // línea de pantalla arriba
    ctx.strokeStyle = '#8fa3c8';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(pad, 6);
    ctx.quadraticCurveTo(cssW / 2, 2, cssW - pad, 6);
    ctx.stroke();
    const dot = Math.max(2.6, scale * 0.55);
    const off = 14;
    for (const s of seats) {
      const st = seatStates.current.get(s.key);
      let c = '#8d8a96'; // libre estándar
      if (heatRef.current) {
        const seat = t.seatByKey.get(s.key);
        const h = seat ? seat.userData.heat : 0;
        c = h === 0 ? '#2f9e44' : h === 1 ? '#e8a013' : '#d9480f';
      } else if (st === 'blocked') c = '#403c48';
      else if (t.proposal.has(s.key)) c = '#34d399';
      else if (t.soldSet.has(s.key) || t.occupiedSet.has(s.key)) c = '#6b5a20';
      else if (st === 'vip' || s.autoVip) c = '#d8232a';
      ctx.fillStyle = c;
      const x = pad + (s.px - minX) * scale;
      const y = off + (s.pz - minZ) * scale;
      ctx.fillRect(x - dot / 2, y - dot / 2, dot, dot);
    }
    t.miniMap = { minX, minZ, scale, pad, off };
  }, []);

  const onMinimapClick = useCallback(
    (e) => {
      const t = T.current;
      const cv = minimapRef.current;
      if (!t || !cv || !t.miniMap) return;
      const rect = cv.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      const { minX, minZ, scale, pad, off } = t.miniMap;
      let best = null;
      let bestD = 9e9;
      for (const s of t.seatList) {
        const x = pad + (s.px - minX) * scale;
        const y = off + (s.pz - minZ) * scale;
        const d = Math.hypot(x - cx, y - cy);
        if (d < bestD) { bestD = d; best = s; }
      }
      if (!best || bestD > 9) return;
      const seat = t.seatByKey.get(best.key);
      if (!seat) return;
      if (modeRef.current === 'pov' || t.pov.active) {
        t.enterPovAt(seat);
      } else {
        pushHistory();
        t.applyModeTo(seat);
      }
    },
    [pushHistory]
  );

  const recount = useCallback(() => {
    const t = T.current;
    if (!t) return;
    let vip = 0, blocked = 0, sold = 0, soldVip = 0;
    for (const s of t.seatList) {
      const st = seatStates.current.get(s.key);
      const isVip = s.autoVip || st === 'vip';
      if (st === 'blocked') { blocked++; continue; }
      if (t.soldSet.has(s.key) || t.occupiedSet.has(s.key)) {
        sold++;
        if (isVip) soldVip++;
      }
      if (isVip) vip++;
    }
    setCounts({ total: t.seatList.length, vip, blocked, sold, soldVip });
    drawMinimap();
  }, [drawMinimap]);

  // toggle del mapa de calidad de visión: solo cambia materiales
  useEffect(() => {
    heatRef.current = heatOn;
    const t = T.current;
    if (!t || !t.seatsGroup) return;
    for (const seat of t.seatsGroup.children) applySeatState(seat);
    drawMinimap();
  }, [heatOn, applySeatState, drawMinimap]);

  // deshacer / rehacer con teclado
  useEffect(() => {
    const onKey = (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z') return;
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo]);

  // media query móvil: el panel pasa a hoja inferior
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 640px)');
    const on = () => setIsNarrow(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);

  // autoguardado en localStorage (la config sobrevive al F5)
  useEffect(() => {
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(serialize()));
      } catch (err) { /* storage lleno o bloqueado */ }
    }, 400);
    return () => window.clearTimeout(saveTimer.current);
  }, [params, prices, counts, serialize]);

  // --------------------------------------------------------------------------
  // Regeneración procedural de la sala
  // --------------------------------------------------------------------------
  useEffect(() => {
    const t = T.current;
    if (!t) return;
    const { scene, mats, unitBox, unitPlane } = t;
    const {
      rows, cols, vipRows, curvature, slope, spacing, aisle,
      occupancy, screenWPct, screenH,
    } = params;

    for (const k of ['seatsGroup', 'standGroup', 'roomGroup', 'signsGroup']) {
      if (t[k]) {
        scene.remove(t[k]);
        t[k] = null;
      }
    }
    t.disposables.forEach((d) => d.dispose());
    t.disposables = [];
    t.proposal = new Set();
    t.markerKeys = [];
    setProposal(null);

    const seatsGroup = new THREE.Group();
    const standGroup = new THREE.Group();
    const roomGroup = new THREE.Group();
    const signsGroup = new THREE.Group();
    t.seatsGroup = seatsGroup;
    t.standGroup = standGroup;
    t.roomGroup = roomGroup;
    t.signsGroup = signsGroup;
    scene.add(seatsGroup, standGroup, roomGroup, signsGroup);
    t.seatList = [];
    t.seatByKey = new Map();
    t.rowMeta = new Map();
    t.rowBands = [];

    const c = curvature / 100;
    const R = 150 - 137 * c; // radio del arco (decrece al curvar más)
    const zc = Z_START - R; // centro común de los arcos (detrás de la pantalla)

    // anchura máxima de fila (para tarimas, escaleras y sala)
    const vipSpacing = spacing * 1.45;
    const vipCols = Math.max(2, Math.round(cols * 0.6));
    const stdWidth = (cols - 1) * spacing + (aisle ? AISLE_W : 0);
    const vipWidth = (vipCols - 1) * vipSpacing + (aisle ? AISLE_W : 0);
    const maxRowWidth = Math.max(stdWidth, vipRows > 0 ? vipWidth : 0) + 0.6;
    const halfW = maxRowWidth / 2;
    const stairX = halfW + 0.95;

    // dimensiones de la sala (la pantalla depende del ancho)
    const hallW = maxRowWidth + 5.5;
    const zFront = -10.6;

    // pantalla parametrizable (por defecto: todo el ancho, casi todo el alto)
    t.buildScreen(hallW, screenWPct, screenH);

    // cortinas de enmascarado flanqueando la pantalla (como en salas reales)
    for (const sx of [-1, 1]) {
      const curtain = new THREE.Mesh(unitBox, mats.curtain);
      curtain.scale.set(0.7, t.screenInfo.H + 1.0, 0.5);
      curtain.position.set(
        sx * (t.screenInfo.W / 2 + 0.4),
        t.screenInfo.cy,
        SCREEN_Z + 0.18
      );
      roomGroup.add(curtain);
    }

    // ocupación simulada, estable por butaca
    t.occupiedSet = new Set();

    // rótulos de fila (texturas canvas cacheadas)
    const rowLabelMat = (nLabel) => {
      const text = String(nLabel);
      if (!t.labelCache[text]) {
        const cv = document.createElement('canvas');
        cv.width = 96;
        cv.height = 64;
        const ctx = cv.getContext('2d');
        ctx.fillStyle = '#0c0c14';
        ctx.fillRect(0, 0, 96, 64);
        ctx.strokeStyle = '#2b6bff';
        ctx.lineWidth = 4;
        ctx.strokeRect(3, 3, 90, 58);
        ctx.fillStyle = '#dfe7ff';
        ctx.font = 'bold 40px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, 48, 34);
        const tx = new THREE.CanvasTexture(cv);
        tx.encoding = THREE.sRGBEncoding;
        t.labelCache[text] = new THREE.MeshBasicMaterial({
          map: tx,
          toneMapped: false,
        });
      }
      return t.labelCache[text];
    };

    let z = Z_START;
    let lastZBack = Z_START;

    for (let r = 0; r < rows; r++) {
      const isVipRow = r >= rows - vipRows;
      const n = isVipRow ? vipCols : cols;
      const sp = isVipRow ? vipSpacing : spacing;
      const depth = isVipRow ? ROW_DEPTH_VIP : ROW_DEPTH_STD;
      const y = slope * r;
      const zRow = z;
      z += depth;
      lastZBack = zRow + depth;
      t.rowBands.push({ z0: zRow - 0.6, z1: zRow + depth + 0.2, y });
      t.rowMeta.set(r, { n, isVip: isVipRow });

      const Rr = R + (zRow - Z_START);
      const maxHalfArc = ((n - 1) * sp + (aisle ? AISLE_W : 0)) / 2;
      const maxAlpha = c > 0 ? maxHalfArc / Rr : 0;
      const sag = c > 0 ? Rr * (1 - Math.cos(maxAlpha)) : 0;

      // tarima de la fila
      const platH = Math.max(0.09, y);
      const platD = depth + sag + 0.35;
      const plat = new THREE.Mesh(unitBox, mats.platform);
      plat.scale.set(maxRowWidth + 0.7, platH, platD);
      plat.position.set(0, y - platH / 2, zRow - sag - 0.15 + platD / 2);
      plat.receiveShadow = true;
      standGroup.add(plat);

      // escaleras laterales + tira LED azul + rótulo de fila
      for (const sx of [-1, 1]) {
        const step = new THREE.Mesh(unitBox, mats.stair);
        step.scale.set(1.25, platH, depth);
        step.position.set(sx * stairX, y - platH / 2, zRow + depth / 2 - 0.2);
        step.receiveShadow = true;
        standGroup.add(step);
        const led = new THREE.Mesh(unitBox, mats.led);
        led.scale.set(1.25, 0.025, 0.06);
        led.position.set(sx * stairX, y + 0.012, zRow - 0.2 + 0.03);
        standGroup.add(led);

        const sign = new THREE.Mesh(unitPlane, rowLabelMat(r + 1));
        sign.scale.set(0.5, 0.34, 1);
        sign.rotation.x = -Math.PI / 2;
        sign.position.set(sx * stairX, y + 0.02, zRow + depth / 2 - 0.1);
        sign.userData.rowSign = r;
        signsGroup.add(sign);
      }

      // tiras LED del pasillo central
      if (aisle) {
        const strip = new THREE.Mesh(unitBox, mats.led);
        strip.scale.set(AISLE_W - 0.2, 0.02, 0.06);
        strip.position.set(0, y + 0.011, zRow - 0.17);
        standGroup.add(strip);
      }

      // butacas de la fila
      const template = isVipRow ? t.vipTemplate : t.stdTemplate;
      for (let i = 0; i < n; i++) {
        let off = (i - (n - 1) / 2) * sp;
        if (aisle) off += i < n / 2 ? -AISLE_W / 2 : AISLE_W / 2;

        let px, pz, rotY;
        if (c > 0) {
          const alpha = off / Rr;
          px = Rr * Math.sin(alpha);
          pz = zc + Rr * Math.cos(alpha);
          rotY = alpha;
        } else {
          px = off;
          pz = zRow;
          rotY = 0;
        }

        const seat = template.clone();
        seat.position.set(px, y, pz);
        seat.rotation.y = rotY;
        const key = `${r}-${i}`;

        // calidad de visión: ángulo hacia el borde superior de la pantalla +
        // desviación lateral (0 verde · 1 ámbar · 2 rojo)
        const eyeY = y + 1.15;
        const distXZ = Math.hypot(px, pz - SCREEN_Z);
        const upTop = Math.atan2(
          t.screenInfo.cy + t.screenInfo.H / 2 - eyeY,
          distXZ
        );
        const lat = Math.atan2(Math.abs(px), pz - SCREEN_Z);
        const score = Math.max(0, upTop) + lat * 0.5;
        const heat = score < 0.42 ? 0 : score < 0.6 ? 1 : 2;

        seat.userData = {
          isSeat: true,
          key,
          row: r,
          col: i,
          autoVip: isVipRow,
          heat,
          score,
          model: isVipRow ? (t.vipModel === 'dae' ? 'dae' : 'vipproc') : 'std',
        };
        seatsGroup.add(seat);
        t.seatList.push({ key, autoVip: isVipRow, row: r, col: i, px, pz, score });
        t.seatByKey.set(key, seat);
        if (hash01(key) < occupancy / 100) t.occupiedSet.add(key);
        applySeatState(seat);
      }
    }

    seatsGroup.updateMatrixWorld(true);
    seatsGroup.traverse((o) => (o.matrixAutoUpdate = false));

    // ---- sala (suelo, paredes, techo, discos, altavoces, cabina, puertas) -----
    const zBack = lastZBack + 2.6;
    const hallD = zBack - zFront;
    const zMid = (zFront + zBack) / 2;
    t.hallBounds = { halfW: hallW / 2, zBack };

    mats.floor.map.repeat.set(hallW / 3.2, hallD / 3.2);
    mats.wall.map.repeat.set(hallD / 4.5, HALL_H / 4.5);

    const floor = new THREE.Mesh(unitPlane, mats.floor);
    floor.scale.set(hallW, hallD, 1);
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(0, -0.005, zMid);
    floor.receiveShadow = true;
    roomGroup.add(floor);

    const ceiling = new THREE.Mesh(unitPlane, mats.ceiling);
    ceiling.scale.set(hallW, hallD, 1);
    ceiling.rotation.x = Math.PI / 2;
    ceiling.position.set(0, HALL_H, zMid);
    roomGroup.add(ceiling);

    const mkWall = (w, h) => {
      const m = new THREE.Mesh(unitPlane, mats.wall);
      m.scale.set(w, h, 1);
      m.receiveShadow = true;
      roomGroup.add(m);
      return m;
    };
    const wallL = mkWall(hallD, HALL_H);
    wallL.rotation.y = Math.PI / 2;
    wallL.position.set(-hallW / 2, HALL_H / 2, zMid);
    const wallR = mkWall(hallD, HALL_H);
    wallR.rotation.y = -Math.PI / 2;
    wallR.position.set(hallW / 2, HALL_H / 2, zMid);
    const wallBack = mkWall(hallW, HALL_H);
    wallBack.rotation.y = Math.PI;
    wallBack.position.set(0, HALL_H / 2, zBack);
    const wallFront = mkWall(hallW, HALL_H);
    wallFront.position.set(0, HALL_H / 2, zFront);

    // discos "IMMERSIÓ" (asset original): disco negro + aro LED turquesa con
    // halo, tamaños y alturas variadas como en la sala real
    const mkDisc = (radius, kind) => {
      const g = new THREE.Group();
      const discGeo = new THREE.CircleGeometry(radius, 40);
      t.disposables.push(discGeo);
      const mat =
        kind === 0 ? mats.discMax : kind === 1 ? mats.discMin : mats.discPlain;
      const disc = new THREE.Mesh(discGeo, mat);
      g.add(disc);
      const ringGeo = new THREE.TorusGeometry(radius * 1.01, 0.032, 8, 48);
      t.disposables.push(ringGeo);
      const ring = new THREE.Mesh(ringGeo, mats.ring);
      ring.position.z = -0.015;
      g.add(ring);
      // halo suave alrededor del aro
      const glow = new THREE.Mesh(unitPlane, mats.glow);
      glow.scale.set(radius * 3.4, radius * 3.4, 1);
      glow.position.z = 0.03;
      g.add(glow);
      return g;
    };
    const nDiscs = Math.max(4, Math.floor(hallD / 4.2));
    for (const sx of [-1, 1]) {
      for (let i = 0; i < nDiscs; i++) {
        const h1 = hash01(`disc${sx}-${i}-a`);
        const h2 = hash01(`disc${sx}-${i}-b`);
        const h3 = hash01(`disc${sx}-${i}-c`);
        const radius = 0.32 + h1 * 0.5;
        const pz =
          zFront + 3 + ((i + 0.5) / nDiscs) * (hallD - 5) + (h2 - 0.5) * 1.6;
        const py = 5.1 + h3 * (HALL_H - 5.1 - radius - 0.4);
        // uno de cada tres lleva el rótulo neón (alterna màxima/mínima)
        const kind = i % 3 === 0 ? i % 2 : 2;
        const disc = mkDisc(radius, kind);
        disc.position.set(sx * (hallW / 2 - 0.06), py, pz);
        disc.rotation.y = (sx * -Math.PI) / 2;
        roomGroup.add(disc);
      }
    }

    // altavoces K.C.S. a media altura, bajo los discos
    const mkSpeaker = () => {
      const box = new THREE.Mesh(unitBox, [
        mats.speakerBox, mats.speakerBox, mats.speakerBox,
        mats.speakerBox, mats.speakerFront, mats.speakerBox,
      ]);
      box.scale.set(1.1, 0.75, 0.42);
      return box;
    };
    const nSp = Math.max(2, Math.floor(hallD / 8));
    for (const sx of [-1, 1]) {
      for (let i = 0; i < nSp; i++) {
        const sp2 = mkSpeaker();
        const pz = zFront + 4.5 + ((i + 0.5) / nSp) * (hallD - 7);
        sp2.position.set(sx * (hallW / 2 - 0.24), 3.6, pz);
        sp2.rotation.y = (sx * -Math.PI) / 2;
        roomGroup.add(sp2);
      }
    }

    // ventana de la cabina de proyección en la pared trasera, alineada con la
    // luz de proyección (el proyector asoma tras el cristal)
    const booth = new THREE.Mesh(unitPlane, mats.proyector);
    booth.scale.set(2.5, 1.57, 1); // aspecto real del recorte (~1,59:1)
    booth.rotation.y = Math.PI;
    booth.position.set(0, 6.6, zBack - 0.05);
    roomGroup.add(booth);

    // puertas de emergencia con señal verde en las esquinas traseras
    for (const sx of [-1, 1]) {
      const door = new THREE.Mesh(unitPlane, mats.door);
      door.scale.set(1.9, 2.3, 1);
      door.rotation.y = Math.PI;
      door.position.set(sx * (hallW / 2 - 2.3), 1.15, zBack - 0.04);
      roomGroup.add(door);
      const senyal = new THREE.Mesh(unitPlane, mats.senyal);
      senyal.scale.set(0.72, 0.38, 1);
      senyal.rotation.y = Math.PI;
      senyal.position.set(sx * (hallW / 2 - 2.3), 2.6, zBack - 0.05);
      roomGroup.add(senyal);
    }

    // el foco cenital sigue el centro del graderío al crecer la sala
    const midZ = (Z_START + lastZBack) / 2;
    t.spot.position.set(0, 9.4, midZ + 1.5);
    t.spot.target.position.set(0, 0, midZ);

    // vista "home": cenital, encuadrando todo el cine según su tamaño actual
    t.homeView.theta = 0;
    t.homeView.phi = 0.16;
    t.homeView.radius = Math.min(55, Math.max(26, hallD * 1.08));
    t.homeView.target.set(0, 0, zMid);

    recount();
  }, [params, vipDaeReady, regenTick, applySeatState, recount]);

  // --------------------------------------------------------------------------
  // Compra de entradas: sugerir los mejores N asientos contiguos
  // --------------------------------------------------------------------------
  const priceOf = useCallback(
    (s) =>
      s.autoVip || seatStates.current.get(s.key) === 'vip'
        ? prices.vip
        : prices.std,
    [prices]
  );

  const clearProposal = useCallback(() => {
    const t = T.current;
    if (!t) return;
    const old = [...t.proposal];
    t.proposal = new Set();
    t.markerKeys = [];
    for (const k of old) {
      const seat = t.seatByKey.get(k);
      if (seat) applySeatState(seat);
    }
    setProposal(null);
    drawMinimap();
  }, [applySeatState, drawMinimap]);

  const proposeSeats = useCallback(() => {
    const t = T.current;
    if (!t) return;
    clearProposal();
    const N = Math.max(1, Math.min(8, buyN));
    const sellable = (s) => {
      const st = seatStates.current.get(s.key);
      return (
        st !== 'blocked' && !t.soldSet.has(s.key) && !t.occupiedSet.has(s.key)
      );
    };
    // por fila: ventanas de N asientos consecutivos sin cruzar el pasillo
    const byRow = new Map();
    for (const s of t.seatList) {
      if (!byRow.has(s.row)) byRow.set(s.row, []);
      byRow.get(s.row)[s.col] = s;
    }
    let best = null;
    for (const [row, arr] of byRow) {
      const meta = t.rowMeta.get(row);
      const n = meta ? meta.n : arr.length;
      for (let c0 = 0; c0 + N <= n; c0++) {
        // no atravesar el pasillo central
        if (params.aisle && c0 < n / 2 && c0 + N > n / 2) continue;
        let ok = true;
        let sum = 0;
        for (let k = 0; k < N; k++) {
          const s = arr[c0 + k];
          if (!s || !sellable(s)) { ok = false; break; }
          sum += s.score;
        }
        if (!ok) continue;
        if (!best || sum < best.sum) best = { row, c0, sum, seats: arr.slice(c0, c0 + N) };
      }
    }
    if (!best) {
      setProposal({ keys: [], total: 0, label: 'No hay sitio contiguo para ese grupo' });
      return;
    }
    const keys = best.seats.map((s) => s.key);
    t.proposal = new Set(keys);
    // baliza cíclica: irá mostrando la posición de cada butaca propuesta
    t.markerKeys = keys;
    t.markerIdx = -1;
    t.markerNextAt = 0;
    for (const k of keys) {
      const seat = t.seatByKey.get(k);
      if (seat) applySeatState(seat);
    }
    const total = best.seats.reduce((acc, s) => acc + priceOf(s), 0);
    setProposal({
      keys,
      total,
      label: `Fila ${best.row + 1} · butacas ${best.c0 + 1}–${best.c0 + keys.length}`,
    });
    drawMinimap();
  }, [buyN, params.aisle, priceOf, applySeatState, clearProposal, drawMinimap]);

  const confirmProposal = useCallback(() => {
    const t = T.current;
    if (!t || !proposal || !proposal.keys.length) return;
    pushHistory();
    for (const k of proposal.keys) t.soldSet.add(k);
    t.proposal = new Set();
    t.markerKeys = [];
    for (const k of proposal.keys) {
      const seat = t.seatByKey.get(k);
      if (seat) applySeatState(seat);
    }
    setProposal(null);
    recount();
  }, [proposal, pushHistory, applySeatState, recount]);

  // --------------------------------------------------------------------------
  // Acciones de UI
  // --------------------------------------------------------------------------
  const toggleSound = () => {
    const t = T.current;
    if (!t) return;
    if (t.listener && t.listener.context.state === 'suspended') {
      t.listener.context.resume().catch(() => {});
    }
    t.video.muted = !t.video.muted;
    t.video.play().catch(() => {});
    setMuted(t.video.muted);
  };

  const exportConfig = () => {
    const blob = new Blob([JSON.stringify(serialize(), null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `sala-${params.rows}x${params.cols}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  };

  const importConfig = (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    file
      .text()
      .then((txt) => {
        const data = JSON.parse(txt);
        if (!data || data.app !== 'ticketing3d' || !data.params) {
          throw new Error('formato');
        }
        pushHistory();
        seatStates.current = new Map(data.states || []);
        if (T.current) T.current.soldSet = new Set(data.sold || []);
        if (data.prices) setPrices({ ...DEFAULT_PRICES, ...data.prices });
        setParams({ ...DEFAULT_PARAMS, ...data.params });
        setRegenTick((k) => k + 1);
      })
      .catch(() => {
        window.alert('El archivo no es una configuración de sala válida.');
      });
  };

  const shareLink = () => {
    try {
      const json = JSON.stringify(serialize());
      const b64 = encodeURIComponent(btoa(unescape(encodeURIComponent(json))));
      const url = `${window.location.origin}${window.location.pathname}#c=${b64}`;
      window.history.replaceState(null, '', `#c=${b64}`);
      const done = () => {
        setShareMsg('¡Enlace copiado!');
        setTimeout(() => setShareMsg(''), 2500);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(done, done);
      } else done();
    } catch (err) {
      window.alert('No se pudo generar el enlace.');
    }
  };

  const resetAll = () => {
    if (!window.confirm('¿Restablecer la sala a los valores por defecto?')) return;
    pushHistory();
    seatStates.current = new Map();
    if (T.current) T.current.soldSet = new Set();
    try { window.localStorage.removeItem(STORAGE_KEY); } catch (err) { /* noop */ }
    window.history.replaceState(null, '', window.location.pathname);
    setPrices(DEFAULT_PRICES);
    setParams({ ...DEFAULT_PARAMS });
    setRegenTick((k) => k + 1);
  };

  const takeSnapshot = () => {
    const t = T.current;
    if (!t || !t.snapshot) return;
    const a = document.createElement('a');
    a.href = t.snapshot();
    a.download = 'sala-captura.png';
    a.click();
  };

  const setP = (k) => (e) =>
    setParams((p) => ({
      ...p,
      [k]: k === 'aisle' ? e.target.checked : Number(e.target.value),
    }));

  const slider = (label, key, min, max, step, unit = '') => (
    <div style={ui.row} key={key}>
      <div style={ui.rowTop}>
        <span>{label}</span>
        <span style={ui.value}>
          {params[key]}
          {unit}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={params[key]}
        onChange={setP(key)}
        style={ui.range}
      />
    </div>
  );

  const modeBtn = (m, label, color) => (
    <button
      key={m}
      onClick={() => setMode(m)}
      style={{
        ...ui.modeBtn,
        background: mode === m ? color : 'rgba(255,255,255,.06)',
        borderColor: mode === m ? color : 'rgba(255,255,255,.15)',
        color: mode === m ? '#fff' : '#c9c6cf',
      }}
    >
      {label}
    </button>
  );

  const libres = counts.total - counts.blocked - counts.sold;
  const revenue =
    counts.soldVip * prices.vip + (counts.sold - counts.soldVip) * prices.std;
  const potential = useMemo(() => {
    const t = T.current;
    if (!t) return 0;
    let sum = 0;
    for (const s of t.seatList) {
      if (seatStates.current.get(s.key) === 'blocked') continue;
      sum += priceOf(s);
    }
    return sum;
  }, [counts, priceOf]); // eslint-disable-line react-hooks/exhaustive-deps

  const panelStyle = isNarrow
    ? {
        ...ui.panel,
        ...ui.panelNarrow,
        transform: panelOpen ? 'translateY(0)' : 'translateY(calc(100% + 30px))',
      }
    : {
        ...ui.panel,
        transform: panelOpen ? 'translateX(0)' : 'translateX(calc(100% + 30px))',
      };

  return (
    <div style={{ position: 'fixed', inset: 0, userSelect: 'none' }}>
      <div ref={mountRef} style={{ position: 'absolute', inset: 0 }} />

      {/* tooltip de butaca */}
      <div ref={tipRef} style={ui.tip} />

      {/* etiqueta de la baliza de butacas seleccionadas */}
      <div ref={markerLabelRef} style={ui.markerLabel} />

      {/* aviso superior en modo POV */}
      {povUI && (
        <div style={ui.povHint}>
          Vista desde la butaca — arrastra para mirar · toca otra butaca para
          saltar a ella
        </div>
      )}

      {/* aviso durante el recorrido */}
      {tourUI && (
        <div style={ui.povHint}>
          Recorrido por la sala — toca en cualquier sitio para salir
        </div>
      )}

      {/* volver de POV */}
      {povUI && (
        <button style={ui.backBtn} onClick={() => T.current && T.current.goHome()}>
          <Ic style={{ marginRight: 7 }}>{icons.back}</Ic>
          Volver a la vista general
        </button>
      )}

      {/* vista top / posición original (abajo izquierda) */}
      {!povUI && (
        <button
          style={ui.homeBtn}
          title="Vista general (top)"
          onClick={() => T.current && T.current.goHome()}
        >
          <Ic size={19}>{icons.home}</Ic>
        </button>
      )}

      {/* minimapa 2D (plano de butacas) */}
      <canvas
        ref={minimapRef}
        onClick={onMinimapClick}
        style={{
          ...ui.minimap,
          display: isNarrow && panelOpen ? 'none' : 'block',
        }}
      />

      {/* hamburguesa (cuando el editor está cerrado) */}
      {!povUI && (
        <button
          style={{
            ...ui.burgerBtn,
            opacity: panelOpen ? 0 : 1,
            pointerEvents: panelOpen ? 'none' : 'auto',
          }}
          onClick={() => setPanelOpen(true)}
        >
          <Ic size={20}>{icons.menu}</Ic>
        </button>
      )}

      {/* panel de configuración: drawer lateral animado */}
      <div style={panelStyle}>
        <div>
          <div style={ui.panelHead}>
            <strong style={{ letterSpacing: '.5px' }}>
              CINEMES <span style={{ color: '#d8232a' }}>FULL HD</span> · Sala 3D
            </strong>
            <button style={ui.closeBtn} onClick={() => setPanelOpen(false)}>
              <Ic size={17}>{icons.x}</Ic>
            </button>
          </div>

          <div style={ui.counters}>
            <div style={ui.counter}>
              <div style={{ ...ui.counterNum, color: '#7ce38b' }}>{libres}</div>
              <div style={ui.counterLbl}>Libres</div>
            </div>
            <div style={{ ...ui.counter, borderColor: 'rgba(216,35,42,.5)' }}>
              <div style={{ ...ui.counterNum, color: '#ff5a60' }}>{counts.vip}</div>
              <div style={ui.counterLbl}>VIP</div>
            </div>
            <div style={ui.counter}>
              <div style={{ ...ui.counterNum, color: '#9a95a3' }}>
                {counts.blocked}
              </div>
              <div style={ui.counterLbl}>Bloq.</div>
            </div>
            <div style={ui.counter}>
              <div style={{ ...ui.counterNum, color: '#c9a145' }}>{counts.sold}</div>
              <div style={ui.counterLbl}>Vendidas</div>
            </div>
          </div>

          {/* recaudación */}
          <div style={ui.revenue}>
            <span>
              Recaudación: <b style={{ color: '#7ce38b' }}>{revenue.toFixed(2)} €</b>
            </span>
            <span style={{ opacity: 0.6 }}>
              aforo completo {potential.toFixed(0)} €
            </span>
          </div>
          <div style={ui.priceRow}>
            <label style={ui.priceLbl}>
              Precio estándar
              <input
                type="number"
                min="0"
                step="0.5"
                value={prices.std}
                onChange={(e) =>
                  setPrices((p) => ({ ...p, std: Number(e.target.value) || 0 }))
                }
                style={ui.priceInput}
              />
            </label>
            <label style={ui.priceLbl}>
              Precio VIP
              <input
                type="number"
                min="0"
                step="0.5"
                value={prices.vip}
                onChange={(e) =>
                  setPrices((p) => ({ ...p, vip: Number(e.target.value) || 0 }))
                }
                style={ui.priceInput}
              />
            </label>
          </div>

          {/* compra de entradas */}
          <div style={ui.buyBox}>
            <div style={ui.buyHead}>
              <Ic style={{ marginRight: 6 }}>{icons.ticket}</Ic>
              Comprar entradas
            </div>
            <div style={ui.buyRow}>
              <input
                type="number"
                min="1"
                max="8"
                value={buyN}
                onChange={(e) =>
                  setBuyN(Math.max(1, Math.min(8, Number(e.target.value) || 1)))
                }
                style={ui.buyInput}
              />
              <button onClick={proposeSeats} style={ui.buyBtn}>
                Sugerir mejores asientos
              </button>
            </div>
            {proposal && (
              <div style={ui.proposalBox}>
                {proposal.keys.length ? (
                  <>
                    <div style={{ marginBottom: 6 }}>
                      <b style={{ color: '#34d399' }}>{proposal.label}</b>
                      {' · '}
                      {proposal.total.toFixed(2)} €
                    </div>
                    <div style={{ display: 'flex', gap: 7 }}>
                      <button onClick={confirmProposal} style={ui.confirmBtn}>
                        Confirmar venta
                      </button>
                      <button onClick={clearProposal} style={ui.cancelBtn}>
                        Cancelar
                      </button>
                    </div>
                  </>
                ) : (
                  <div style={{ opacity: 0.75 }}>{proposal.label}</div>
                )}
              </div>
            )}
          </div>

          {slider('Filas', 'rows', 3, 24, 1)}
          {slider('Butacas por fila', 'cols', 6, 32, 1)}
          {slider('Filas VIP traseras', 'vipRows', 0, 6, 1)}
          {slider('Curvatura', 'curvature', 0, 100, 1, '%')}
          {slider('Pendiente', 'slope', 0, 0.6, 0.01, ' m/fila')}
          {slider('Separación', 'spacing', 0.68, 1.0, 0.01, ' m')}
          {slider('Ocupación simulada', 'occupancy', 0, 100, 1, '%')}
          {slider('Ancho pantalla', 'screenWPct', 40, 100, 1, '%')}
          {slider('Alto pantalla', 'screenH', 2, 8.2, 0.1, ' m')}

          <label style={ui.checkRow}>
            <input
              type="checkbox"
              checked={params.aisle}
              onChange={setP('aisle')}
              style={{ accentColor: '#d8232a' }}
            />
            Pasillo central
          </label>

          <div style={ui.modesLbl}>
            Al tocar una butaca (arrastra para pintar varias · toca el número de
            fila para marcarla entera):
          </div>
          <div style={ui.modes}>
            {modeBtn('vip', 'VIP', '#d8232a')}
            {modeBtn('block', 'Bloquear', '#4d4956')}
            {modeBtn('clear', 'Normal', '#2e6b46')}
          </div>
          <button
            onClick={() => setMode('pov')}
            style={{
              ...ui.povBtn,
              background: mode === 'pov' ? '#1d4ed8' : 'rgba(255,255,255,.06)',
              borderColor: mode === 'pov' ? '#1d4ed8' : 'rgba(255,255,255,.15)',
            }}
          >
            <Ic style={{ marginRight: 7 }}>{icons.eye}</Ic>
            Ver desde la butaca
          </button>

          <div style={ui.toolRow}>
            <button
              onClick={() => setHeatOn((v) => !v)}
              style={{
                ...ui.toolBtn,
                background: heatOn ? '#7048e8' : 'rgba(255,255,255,.06)',
                borderColor: heatOn ? '#7048e8' : 'rgba(255,255,255,.15)',
                color: heatOn ? '#fff' : '#c9c6cf',
              }}
            >
              <Ic style={{ marginRight: 6 }}>{icons.target}</Ic>
              Mapa de visión
            </button>
            <button onClick={toggleSound} style={ui.toolBtn}>
              <Ic style={{ marginRight: 6 }}>{muted ? icons.volOff : icons.volOn}</Ic>
              {muted ? 'Sonido' : 'Silenciar'}
            </button>
          </div>
          <div style={ui.toolRow}>
            <button
              onClick={() => T.current && T.current.startTour()}
              style={ui.toolBtn}
            >
              <Ic style={{ marginRight: 6 }}>{icons.play}</Ic>
              Recorrido
            </button>
            <button onClick={takeSnapshot} style={ui.toolBtn}>
              <Ic style={{ marginRight: 6 }}>{icons.camera}</Ic>
              Captura
            </button>
          </div>
          <div style={ui.toolRow}>
            <button onClick={undo} style={ui.toolBtn}>
              <Ic style={{ marginRight: 6 }}>{icons.undo}</Ic>
              Deshacer
            </button>
            <button onClick={redo} style={ui.toolBtn}>
              <Ic style={{ marginRight: 6 }}>{icons.redo}</Ic>
              Rehacer
            </button>
          </div>
          <div style={ui.toolRow}>
            <button onClick={exportConfig} style={ui.toolBtn}>
              <Ic style={{ marginRight: 6 }}>{icons.download}</Ic>
              Exportar
            </button>
            <button
              onClick={() => fileRef.current && fileRef.current.click()}
              style={ui.toolBtn}
            >
              <Ic style={{ marginRight: 6 }}>{icons.upload}</Ic>
              Importar
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              onChange={importConfig}
              style={{ display: 'none' }}
            />
          </div>
          <div style={ui.toolRow}>
            <button onClick={shareLink} style={ui.toolBtn}>
              <Ic style={{ marginRight: 6 }}>{icons.share}</Ic>
              {shareMsg || 'Compartir'}
            </button>
            <button onClick={resetAll} style={ui.toolBtn}>
              <Ic style={{ marginRight: 6 }}>{icons.trash}</Ic>
              Reiniciar
            </button>
          </div>

          <div style={ui.help}>
            Arrastra para orbitar · rueda/pellizco para zoom · toca una butaca
            para marcarla · Ctrl+Z deshace
          </div>
        </div>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------
// estilos (drawer glassmorphism, acento rojo #d8232a en los controles)
// ----------------------------------------------------------------------------
const ui = {
  panel: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    width: 'min(340px, calc(100vw - 20px))',
    overflowY: 'auto',
    background: 'rgba(16,14,20,.78)',
    backdropFilter: 'blur(16px)',
    WebkitBackdropFilter: 'blur(16px)',
    borderLeft: '1px solid rgba(255,255,255,.1)',
    padding: '16px 16px 14px',
    color: '#e8e6ec',
    fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif",
    fontSize: 13,
    boxShadow: '-12px 0 44px rgba(0,0,0,.5)',
    transition: 'transform .38s cubic-bezier(.22, 1, .36, 1)',
    willChange: 'transform',
  },
  panelNarrow: {
    top: 'auto',
    left: 0,
    right: 0,
    bottom: 0,
    width: '100%',
    height: '58%',
    borderLeft: 'none',
    borderTop: '1px solid rgba(255,255,255,.1)',
    borderRadius: '16px 16px 0 0',
    boxShadow: '0 -12px 44px rgba(0,0,0,.5)',
  },
  panelHead: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
    fontSize: 13.5,
  },
  closeBtn: {
    background: 'none',
    border: 'none',
    color: '#9a95a3',
    cursor: 'pointer',
    padding: 4,
  },
  counters: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr 1fr 1fr',
    gap: 6,
    marginBottom: 10,
  },
  counter: {
    border: '1px solid rgba(255,255,255,.14)',
    borderRadius: 10,
    padding: '7px 2px',
    textAlign: 'center',
    background: 'rgba(255,255,255,.04)',
  },
  counterNum: { fontSize: 17, fontWeight: 700, lineHeight: 1.1 },
  counterLbl: { fontSize: 10, opacity: 0.65, marginTop: 2 },
  revenue: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    fontSize: 12.5,
    marginBottom: 8,
    padding: '7px 10px',
    borderRadius: 9,
    background: 'rgba(255,255,255,.04)',
    border: '1px solid rgba(255,255,255,.1)',
  },
  priceRow: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: 7,
    marginBottom: 10,
  },
  priceLbl: {
    fontSize: 11,
    opacity: 0.85,
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },
  priceInput: {
    width: '100%',
    padding: '6px 8px',
    borderRadius: 8,
    border: '1px solid rgba(255,255,255,.15)',
    background: 'rgba(255,255,255,.06)',
    color: '#e8e6ec',
    fontSize: 13,
  },
  buyBox: {
    border: '1px solid rgba(52,211,153,.35)',
    borderRadius: 10,
    padding: '10px 10px 9px',
    marginBottom: 12,
    background: 'rgba(52,211,153,.05)',
  },
  buyHead: { fontSize: 12.5, fontWeight: 600, marginBottom: 8 },
  buyRow: { display: 'flex', gap: 7 },
  buyInput: {
    width: 52,
    padding: '7px 8px',
    borderRadius: 8,
    border: '1px solid rgba(255,255,255,.15)',
    background: 'rgba(255,255,255,.06)',
    color: '#e8e6ec',
    fontSize: 13,
    textAlign: 'center',
  },
  buyBtn: {
    flex: 1,
    padding: '8px 4px',
    borderRadius: 8,
    border: '1px solid rgba(52,211,153,.5)',
    background: 'rgba(52,211,153,.12)',
    color: '#a7f3d0',
    cursor: 'pointer',
    fontSize: 12.5,
    fontWeight: 600,
  },
  proposalBox: {
    marginTop: 9,
    fontSize: 12.5,
    padding: '8px 9px',
    borderRadius: 8,
    background: 'rgba(255,255,255,.05)',
  },
  confirmBtn: {
    flex: 1,
    padding: '8px 4px',
    borderRadius: 8,
    border: '1px solid #1f9d55',
    background: '#1f9d55',
    color: '#fff',
    cursor: 'pointer',
    fontSize: 12.5,
    fontWeight: 600,
  },
  cancelBtn: {
    padding: '8px 12px',
    borderRadius: 8,
    border: '1px solid rgba(255,255,255,.2)',
    background: 'rgba(255,255,255,.06)',
    color: '#c9c6cf',
    cursor: 'pointer',
    fontSize: 12.5,
  },
  row: { marginBottom: 9 },
  rowTop: {
    display: 'flex',
    justifyContent: 'space-between',
    marginBottom: 3,
    opacity: 0.9,
  },
  value: { color: '#ff8a8e', fontVariantNumeric: 'tabular-nums' },
  range: { width: '100%', accentColor: '#d8232a', margin: 0 },
  checkRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    margin: '4px 0 12px',
    cursor: 'pointer',
  },
  modesLbl: { fontSize: 11, opacity: 0.65, marginBottom: 6, lineHeight: 1.45 },
  modes: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr 1fr',
    gap: 7,
    marginBottom: 8,
  },
  modeBtn: {
    padding: '10px 4px',
    borderRadius: 9,
    border: '1px solid',
    cursor: 'pointer',
    fontSize: 12.5,
    fontWeight: 600,
    transition: 'all .15s',
  },
  povBtn: {
    width: '100%',
    padding: '10px 4px',
    borderRadius: 9,
    border: '1px solid',
    color: '#fff',
    cursor: 'pointer',
    fontSize: 13,
    fontWeight: 600,
    marginBottom: 8,
  },
  toolRow: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: 7,
    marginBottom: 8,
  },
  toolBtn: {
    padding: '10px 4px',
    borderRadius: 9,
    border: '1px solid rgba(255,255,255,.15)',
    background: 'rgba(255,255,255,.06)',
    color: '#c9c6cf',
    cursor: 'pointer',
    fontSize: 12.5,
    fontWeight: 600,
  },
  help: {
    fontSize: 11,
    opacity: 0.55,
    lineHeight: 1.5,
    borderTop: '1px solid rgba(255,255,255,.1)',
    paddingTop: 8,
  },
  burgerBtn: {
    position: 'absolute',
    top: 14,
    right: 14,
    width: 44,
    height: 44,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    border: '1px solid rgba(255,255,255,.16)',
    background: 'rgba(16,14,20,.74)',
    backdropFilter: 'blur(14px)',
    WebkitBackdropFilter: 'blur(14px)',
    color: '#e8e6ec',
    cursor: 'pointer',
    boxShadow: '0 10px 40px rgba(0,0,0,.55)',
    transition: 'opacity .25s',
  },
  homeBtn: {
    position: 'absolute',
    bottom: 16,
    left: 16,
    width: 44,
    height: 44,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    border: '1px solid rgba(255,255,255,.16)',
    background: 'rgba(16,14,20,.74)',
    backdropFilter: 'blur(14px)',
    WebkitBackdropFilter: 'blur(14px)',
    color: '#e8e6ec',
    cursor: 'pointer',
    boxShadow: '0 10px 40px rgba(0,0,0,.55)',
  },
  minimap: {
    position: 'absolute',
    bottom: 16,
    left: 72,
    borderRadius: 10,
    border: '1px solid rgba(255,255,255,.14)',
    background: 'rgba(12,10,16,.78)',
    backdropFilter: 'blur(10px)',
    WebkitBackdropFilter: 'blur(10px)',
    cursor: 'pointer',
    boxShadow: '0 10px 40px rgba(0,0,0,.5)',
  },
  povHint: {
    position: 'absolute',
    top: 12,
    left: '50%',
    transform: 'translateX(-50%)',
    background: 'rgba(16,14,20,.8)',
    backdropFilter: 'blur(10px)',
    border: '1px solid rgba(255,255,255,.16)',
    borderRadius: 999,
    padding: '8px 18px',
    color: '#e8e6ec',
    fontSize: 12.5,
    fontFamily: 'system-ui, sans-serif',
    whiteSpace: 'nowrap',
    maxWidth: 'calc(100vw - 24px)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  backBtn: {
    position: 'absolute',
    bottom: 22,
    left: '50%',
    transform: 'translateX(-50%)',
    padding: '11px 22px',
    borderRadius: 999,
    border: '1px solid rgba(216,35,42,.6)',
    background: 'rgba(216,35,42,.9)',
    color: '#fff',
    fontSize: 14,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'system-ui, sans-serif',
    boxShadow: '0 8px 30px rgba(0,0,0,.5)',
    display: 'flex',
    alignItems: 'center',
  },
  tip: {
    position: 'absolute',
    display: 'none',
    pointerEvents: 'none',
    background: 'rgba(12,10,16,.92)',
    border: '1px solid rgba(216,35,42,.45)',
    borderRadius: 8,
    padding: '5px 10px',
    color: '#e8e6ec',
    fontSize: 12,
    fontFamily: 'system-ui, sans-serif',
    whiteSpace: 'nowrap',
    zIndex: 10,
  },
  markerLabel: {
    position: 'absolute',
    display: 'none',
    transform: 'translate(-50%, -115%)',
    pointerEvents: 'none',
    background: 'rgba(10,26,20,.92)',
    border: '1px solid rgba(52,211,153,.6)',
    borderRadius: 999,
    padding: '6px 14px',
    color: '#a7f3d0',
    fontSize: 12.5,
    fontWeight: 600,
    fontFamily: 'system-ui, sans-serif',
    whiteSpace: 'nowrap',
    zIndex: 9,
  },
};
