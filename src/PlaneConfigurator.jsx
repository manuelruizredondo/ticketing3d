import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import * as THREE from 'three';
import { BufferGeometryUtils } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import {
  easeInOutCubic, hash01, readStorage, writeStorage, useNarrow, disposeThree,
  Ic, icons, fmtEUR, Panel, PanelHeader, Section, Row, RowButton, Stats,
  SliderRow, Segmented, Stepper, NumberRow, Tile, Tabs, ToolBar, ProposalCard,
  useToast, useKeys, useUiPref,
} from './shared.jsx';

// ============================================================================
// Configurador 3D de cabina — modelo low-cost al estilo Vueling
// Flota A319 / A320 / A321 con zonas tarifarias reales:
//   · Space One   (fila 1, +espacio, embarque prioritario)
//   · Space Plus  (filas 2-4)
//   · Space       (filas de salida de emergencia, +espacio)
//   · Delanteros y traseros (más baratos)
//   · Regular     (incluido en la tarifa)
// Detalles reales: sin fila 13, fila 1 solo en el lado izquierdo (A319/A320),
// salidas overwing por modelo, reposacabezas de color por zona.
// El fuselaje se ve por dentro con ventanillas recortadas: desde el POV se ve
// el cielo, las nubes y el ala — lo que compras de verdad al elegir asiento.
// ============================================================================

const R_FUS = 2.4; // radio interior (forro de cabina)
const R_OUT = 2.52; // radio exterior del casco
// altura del corte de la maqueta: por encima de respaldos y ventanillas.
// En la vista desde el asiento el corte sube y el techo se cierra.
const CUT_Y = 1.72;
const CUT_CLOSED = 6;
const YC = 1.35;
const WIN_Y = 1.18; // centro de ventanilla a la altura del hombro sentado
const WIN_EVERY = 0.55;
const Z_FRONT = -1.6;
const FLY_MS = 1100;

const SEAT_X = [-1.55, -1.05, -0.55, 0.55, 1.05, 1.55];
const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];
const seatKind = (x) =>
  Math.abs(x) > 1.3 ? 'ventanilla' : Math.abs(x) < 0.8 ? 'pasillo' : 'centro';

// filas físicas y salidas overwing (en numeración mostrada, que salta el 13)
const AIRCRAFT = {
  a319: { label: 'A319', rows: 18, exits: [8], row1LeftOnly: true },
  a320: { label: 'A320', rows: 24, exits: [10, 11], row1LeftOnly: true },
  a321: { label: 'A321', rows: 30, exits: [12, 14], row1LeftOnly: false },
};
// numeración mostrada: como en los aviones reales, la fila 13 no existe
const displayNum = (i) => (i + 1 >= 13 ? i + 2 : i + 1);

const ZONE_LABELS = {
  one: 'Space One',
  plus: 'Space Plus',
  space: 'Space · salida',
  front: 'Delantero/trasero',
  regular: 'Regular',
};
const ZONE_COLORS = {
  one: '#f2d21f',
  plus: '#17b8ae',
  space: '#8b2fc9',
  front: '#cfc7b8',
  regular: '#8d94a1',
};

const DEFAULT_PARAMS = { aircraft: 'a320', pitch: 0.78, occupancy: 0 };
const DEFAULT_PRICES = { one: 30, plus: 20, space: 15, front: 8 };
const STORAGE_KEY = 'ticketing3d.avion';
// mitad de lo que tapa el panel lateral: la escena se desplaza esto a la izquierda
const PANEL_OFFSET = 175;
// colores de estado compartidos por minimapa y leyenda del panel
const STATE_COLORS = {
  free: '#8d94a1',
  sel: '#4ade80',
  blocked: '#6b7280',
  sold: '#2a2e36',
  proposal: '#34d399',
};

export default function PlaneConfigurator({ onExit }) {
  const mountRef = useRef(null);
  const tipRef = useRef(null);
  const markerLabelRef = useRef(null);
  const minimapRef = useRef(null);
  const miniBtnRef = useRef(null);
  // en móvil el minimapa va plegado en un botón y se abre a demanda
  const [miniOpen, setMiniOpen] = useState(false);
  // hueco del minimapa (para que los avisos inferiores no lo pisen)
  const miniBox = () => {
    const cv = [minimapRef.current, miniBtnRef.current].find((el) => el && el.offsetWidth);
    if (!cv) return { right: 0, above: 0 };
    return {
      right: cv.offsetLeft + cv.offsetWidth,
      above: cv.offsetParent ? cv.offsetParent.clientHeight - cv.offsetTop : 0,
    };
  };
  const T = useRef(null);
  const initialRef = useRef(null);
  if (initialRef.current === null) initialRef.current = readStorage(STORAGE_KEY) || {};
  const seatStates = useRef(new Map());
  // estado por modelo: las claves "fila-índice" se repiten entre A319/A320/A321,
  // así que cada avión guarda sus propias selecciones y ventas
  const layoutsRef = useRef(initialRef.current.byAircraft || {});
  const saveTimer = useRef(0);
  const modeRef = useRef('sel');
  const wingViewRef = useRef(false);

  const [params, setParams] = useState(() => ({
    ...DEFAULT_PARAMS,
    ...(initialRef.current.params || {}),
  }));
  const [prices, setPrices] = useState(() => ({
    ...DEFAULT_PRICES,
    ...(initialRef.current.prices || {}),
  }));
  const [mode, setMode] = useState('sel');
  const [panelOpen, setPanelOpen] = useState(true);
  const [povUI, setPovUI] = useState(false);
  const [wingView, setWingView] = useState(false);
  const [counts, setCounts] = useState({
    total: 0, sel: 0, blocked: 0, sold: 0,
    soldZ: {}, totZ: {},
  });
  const [buyN, setBuyN] = useState(2);
  const [buyPref, setBuyPref] = useState('best'); // 'best' | 'cheap'
  const [proposal, setProposal] = useState(null);
  const [hist, setHist] = useState({ u: false, r: false });
  const [uiPref, setUiPref] = useUiPref('ticketing3d.ui.avion', { tab: 'venta' });
  const isNarrow = useNarrow();
  const { toast, showToast } = useToast();
  const histRef = useRef({ stack: [], idx: -1 });
  const panelOpenRef = useRef(true);
  const narrowRef = useRef(false);

  modeRef.current = mode;
  panelOpenRef.current = panelOpen;
  narrowRef.current = isNarrow;
  const setTab = (tab) => setUiPref((u) => ({ ...u, tab }));

  // --------------------------------------------------------------------------
  // Historial (deshacer / rehacer) del avión que se está editando
  // --------------------------------------------------------------------------
  const snapshotHist = () => ({
    states: [...seatStates.current.entries()],
    sold: T.current ? [...T.current.soldSet] : [],
  });
  const syncHist = () => {
    const h = histRef.current;
    setHist({ u: h.idx >= 0, r: h.idx < h.stack.length - 2 });
  };
  const pushHistory = useCallback(() => {
    const h = histRef.current;
    h.stack = h.stack.slice(0, h.idx + 1);
    h.stack.push(snapshotHist());
    if (h.stack.length > 60) h.stack.shift();
    h.idx = h.stack.length - 1;
    syncHist();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const clearHistory = () => {
    histRef.current = { stack: [], idx: -1 };
    syncHist();
  };
  const restoreHist = (snap) => {
    const t = T.current;
    if (!t) return;
    seatStates.current = new Map(snap.states);
    t.soldSet = new Set(snap.sold);
    t.proposal = new Set();
    t.markerKeys = [];
    setProposal(null);
    if (t.seatsGroup) for (const g of t.seatsGroup.children) applySeatState(g);
    recount();
  };
  const undo = () => {
    const h = histRef.current;
    if (h.idx < 0) return;
    if (h.idx === h.stack.length - 1) h.stack.push(snapshotHist());
    restoreHist(h.stack[h.idx]);
    h.idx--;
    syncHist();
  };
  const redo = () => {
    const h = histRef.current;
    if (h.idx >= h.stack.length - 2) return;
    h.idx++;
    restoreHist(h.stack[h.idx + 1]);
    syncHist();
  };

  // --------------------------------------------------------------------------
  // Montaje
  // --------------------------------------------------------------------------
  useEffect(() => {
    const mount = mountRef.current;
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.localClippingEnabled = true;
    mount.appendChild(renderer.domElement);
    renderer.domElement.style.touchAction = 'none';

    const scene = new THREE.Scene();
    // cielo: degradado vertical de azul profundo a horizonte claro
    const skyCv = document.createElement('canvas');
    skyCv.width = 2;
    skyCv.height = 256;
    const skctx = skyCv.getContext('2d');
    const skg = skctx.createLinearGradient(0, 0, 0, 256);
    skg.addColorStop(0, '#3f7ed0');
    skg.addColorStop(0.55, '#8dbbe8');
    skg.addColorStop(1, '#d7e8f6');
    skctx.fillStyle = skg;
    skctx.fillRect(0, 0, 2, 256);
    const skyTex = new THREE.CanvasTexture(skyCv);
    skyTex.encoding = THREE.sRGBEncoding;
    scene.background = skyTex;
    scene.fog = new THREE.Fog(0xc4dcf2, 70, 240);

    const camera = new THREE.PerspectiveCamera(
      55, mount.clientWidth / mount.clientHeight, 0.1, 400
    );

    scene.add(new THREE.HemisphereLight(0xdcebff, 0x8a8f99, 0.5));
    const sun = new THREE.DirectionalLight(0xfff4e2, 1.1);
    sun.position.set(30, 40, 10);
    scene.add(sun);

    // iluminación de estudio para reflejos en la pintura y el metal
    const pmrem = new THREE.PMREMGenerator(renderer);
    const room = new RoomEnvironment();
    const envRT = pmrem.fromScene(room, 0.04);
    const envTex = envRT.texture;
    scene.environment = envTex;
    pmrem.dispose();
    disposeThree(room, null);

    // plano de corte de la maqueta (ver CUT_Y)
    const cutPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), CUT_Y);
    const clip = [cutPlane];

    // ---- texturas procedurales ------------------------------------------------
    const winCv = document.createElement('canvas');
    winCv.width = 1024;
    winCv.height = 512;
    const wctx = winCv.getContext('2d');
    wctx.fillStyle = '#fff';
    wctx.fillRect(0, 0, 1024, 512);
    wctx.fillStyle = '#000';
    wctx.shadowColor = '#000';
    wctx.shadowBlur = 6;
    // óvalos a la altura de WIN_Y y con tamaño realista (~0,48 × 0,30 m)
    for (const cx of [244, 780]) {
      wctx.beginPath();
      wctx.ellipse(cx, 256, 16, 140, 0, 0, Math.PI * 2);
      wctx.fill();
      wctx.fill();
    }
    const winAlpha = new THREE.CanvasTexture(winCv);
    winAlpha.wrapS = winAlpha.wrapT = THREE.RepeatWrapping;

    // forro interior: bisel hundido alrededor de cada ventanilla (mismo
    // trazado que winAlpha; u = perímetro, v = a lo largo de la cabina)
    const linCv = document.createElement('canvas');
    linCv.width = 1024;
    linCv.height = 512;
    const lnctx = linCv.getContext('2d');
    lnctx.fillStyle = '#e7eaef';
    lnctx.fillRect(0, 0, 1024, 512);
    for (const cx of [244, 780]) {
      lnctx.save();
      lnctx.translate(cx, 256);
      lnctx.scale(1, 205 / 28); // óvalo: el eje largo va a lo largo de la cabina
      const bz = lnctx.createRadialGradient(0, 0, 14, 0, 0, 28);
      bz.addColorStop(0, '#b9bfc8');
      bz.addColorStop(0.55, '#d3d8df');
      bz.addColorStop(1, 'rgba(231,234,239,0)');
      lnctx.fillStyle = bz;
      lnctx.beginPath();
      lnctx.arc(0, 0, 28, 0, Math.PI * 2);
      lnctx.fill();
      lnctx.restore();
    }
    const linerTex = new THREE.CanvasTexture(linCv);
    linerTex.encoding = THREE.sRGBEncoding;
    linerTex.wrapS = linerTex.wrapT = THREE.RepeatWrapping;

    const livCv = document.createElement('canvas');
    livCv.width = 1024;
    livCv.height = 8;
    const lvctx = livCv.getContext('2d');
    const lvg = lvctx.createLinearGradient(0, 0, 1024, 0);
    lvg.addColorStop(0, '#c2c7ce');
    lvg.addColorStop(0.15, '#c2c7ce');
    lvg.addColorStop(0.172, '#f6f7f9');
    lvg.addColorStop(0.828, '#f6f7f9');
    lvg.addColorStop(0.85, '#c2c7ce');
    lvg.addColorStop(1, '#c2c7ce');
    lvctx.fillStyle = lvg;
    lvctx.fillRect(0, 0, 1024, 8);
    // línea de librea bajo las ventanillas, a ambos costados
    lvctx.fillStyle = '#1e3a8a';
    lvctx.fillRect(0.19 * 1024, 0, 0.014 * 1024, 8);
    lvctx.fillRect(0.796 * 1024, 0, 0.014 * 1024, 8);
    lvctx.fillStyle = '#3b82f6';
    lvctx.fillRect(0.207 * 1024, 0, 0.004 * 1024, 8);
    lvctx.fillRect(0.789 * 1024, 0, 0.004 * 1024, 8);
    const livery = new THREE.CanvasTexture(livCv);
    livery.encoding = THREE.sRGBEncoding;
    livery.wrapS = livery.wrapT = THREE.RepeatWrapping;

    const cloudCv = document.createElement('canvas');
    cloudCv.width = cloudCv.height = 128;
    const cctx = cloudCv.getContext('2d');
    const cg = cctx.createRadialGradient(64, 64, 4, 64, 64, 62);
    cg.addColorStop(0, 'rgba(255,255,255,.95)');
    cg.addColorStop(0.55, 'rgba(255,255,255,.55)');
    cg.addColorStop(1, 'rgba(255,255,255,0)');
    cctx.fillStyle = cg;
    cctx.fillRect(0, 0, 128, 128);
    const cloudTex = new THREE.CanvasTexture(cloudCv);

    const exitCv = document.createElement('canvas');
    exitCv.width = 128;
    exitCv.height = 48;
    const ectx = exitCv.getContext('2d');
    ectx.fillStyle = '#c0261e';
    ectx.fillRect(0, 0, 128, 48);
    ectx.fillStyle = '#fff';
    ectx.font = 'bold 30px system-ui, sans-serif';
    ectx.textAlign = 'center';
    ectx.textBaseline = 'middle';
    ectx.fillText('EXIT', 64, 26);
    const exitTex = new THREE.CanvasTexture(exitCv);
    exitTex.encoding = THREE.sRGBEncoding;

    // oclusión ambiental fake: mancha radial para sombras de contacto bajo
    // los asientos y degradado vertical para la junta suelo-pared
    const aoCv = document.createElement('canvas');
    aoCv.width = aoCv.height = 128;
    const actx = aoCv.getContext('2d');
    const ag = actx.createRadialGradient(64, 64, 6, 64, 64, 62);
    ag.addColorStop(0, 'rgba(0,0,0,0.5)');
    ag.addColorStop(0.55, 'rgba(0,0,0,0.28)');
    ag.addColorStop(1, 'rgba(0,0,0,0)');
    actx.fillStyle = ag;
    actx.fillRect(0, 0, 128, 128);
    const aoTex = new THREE.CanvasTexture(aoCv);

    const aoWallCv = document.createElement('canvas');
    aoWallCv.width = 8;
    aoWallCv.height = 64;
    const awctx = aoWallCv.getContext('2d');
    const wg = awctx.createLinearGradient(0, 64, 0, 0);
    wg.addColorStop(0, 'rgba(0,0,0,0.34)'); // abajo (junta con el suelo)
    wg.addColorStop(1, 'rgba(0,0,0,0)');
    awctx.fillStyle = wg;
    awctx.fillRect(0, 0, 8, 64);
    const aoWallTex = new THREE.CanvasTexture(aoWallCv);

    // degradado lineal oscuro→transparente para la junta cojín-respaldo
    const aoSeatCv = document.createElement('canvas');
    aoSeatCv.width = 8;
    aoSeatCv.height = 64;
    const asctx = aoSeatCv.getContext('2d');
    const sg = asctx.createLinearGradient(0, 64, 0, 0);
    sg.addColorStop(0, 'rgba(0,0,0,0.45)'); // pegado a la junta
    sg.addColorStop(1, 'rgba(0,0,0,0)');
    asctx.fillStyle = sg;
    asctx.fillRect(0, 0, 8, 64);
    const aoSeatTex = new THREE.CanvasTexture(aoSeatCv);

    // ---- materiales -----------------------------------------------------------
    // interior: apenas reflejo de entorno (lo reserva para la pintura exterior)
    // para que los asientos contrasten sobre la moqueta en el plano cenital
    const mkStd = (opts) => new THREE.MeshStandardMaterial({ envMapIntensity: 0.15, ...opts });
    const srgb = (hex) => new THREE.Color(hex).convertSRGBToLinear();
    const mats = {
      liner: mkStd({
        map: linerTex, roughness: 0.92, side: THREE.BackSide,
        alphaMap: winAlpha, alphaTest: 0.5, clippingPlanes: clip,
      }),
      glass: new THREE.MeshBasicMaterial({
        color: 0xcfe6fa, transparent: true, opacity: 0.16, depthWrite: false,
        clippingPlanes: clip,
      }),
      // casco exterior: pintura con barniz y ventanillas recortadas
      shell: new THREE.MeshPhysicalMaterial({
        map: livery, alphaMap: winAlpha, alphaTest: 0.5,
        roughness: 0.32, metalness: 0, clearcoat: 0.7, clearcoatRoughness: 0.18,
        clippingPlanes: clip,
      }),
      paint: new THREE.MeshPhysicalMaterial({
        color: srgb(0xf4f6f8), roughness: 0.32, clearcoat: 0.7, clearcoatRoughness: 0.18,
      }),
      tailPaint: new THREE.MeshPhysicalMaterial({
        color: srgb(0x1e3a8a), roughness: 0.3, clearcoat: 0.8, clearcoatRoughness: 0.15,
      }),
      cockpit: new THREE.MeshPhysicalMaterial({
        color: srgb(0x0e131b), roughness: 0.06, metalness: 0.3, clearcoat: 1,
      }),
      rim: mkStd({ color: srgb(0xdde1e6), roughness: 0.7 }),
      fan: mkStd({ color: srgb(0x2a2e36), metalness: 0.6, roughness: 0.45 }),
      // tintado de ventanillas visible solo desde fuera (cara hacia el exterior)
      winTint: new THREE.MeshBasicMaterial({
        color: srgb(0x131a26), transparent: true, opacity: 0.72, clippingPlanes: clip,
      }),
      floor: mkStd({ color: 0x9aa0ab, roughness: 0.95 }), // moqueta clara
      aisle: mkStd({ color: 0x4a5160, roughness: 0.95 }),
      bin: mkStd({ color: 0xdadfe6, roughness: 0.85, clippingPlanes: clip }),
      bulkhead: mkStd({ color: 0xd6dbe2, roughness: 0.9 }),
      lightStrip: mkStd({
        color: 0xf5f2ea, emissive: 0xfff3df, emissiveIntensity: 0.9, clippingPlanes: clip,
      }),
      seat: mkStd({ color: 0x3a4356, roughness: 0.9 }), // tapizado gris oscuro
      metal: mkStd({ color: 0x9aa0a8, metalness: 0.8, roughness: 0.4 }),
      selMark: mkStd({ color: 0x1f9d55, emissive: 0x2f9e44, emissiveIntensity: 0.25, roughness: 0.85 }),
      blocked: mkStd({ color: 0x8b919c, roughness: 0.95 }),
      sold: mkStd({ color: 0x23262e, roughness: 0.95 }),
      proposal: mkStd({ color: 0x1f9d55, emissive: 0x34d399, emissiveIntensity: 0.5, roughness: 0.8 }),
      wing: new THREE.MeshPhysicalMaterial({
        color: srgb(0xc9ced6), metalness: 0.3, roughness: 0.38, clearcoat: 0.35,
      }),
      engine: mkStd({ color: 0xb8bec7, metalness: 0.75, roughness: 0.3 }),
      intake: mkStd({ color: 0x1c1f26, roughness: 0.6 }),
      exit: new THREE.MeshBasicMaterial({ map: exitTex, toneMapped: false, clippingPlanes: clip }),
      heat: [
        mkStd({ color: 0x2f9e44, emissive: 0x2f9e44, emissiveIntensity: 0.3, roughness: 0.85 }),
        mkStd({ color: 0xe8a013, emissive: 0xe8a013, emissiveIntensity: 0.3, roughness: 0.85 }),
        mkStd({ color: 0xd9480f, emissive: 0xd9480f, emissiveIntensity: 0.3, roughness: 0.85 }),
      ],
      cloud: new THREE.SpriteMaterial({ map: cloudTex, opacity: 0.9, depthWrite: false }),
      armrest: mkStd({ color: 0x646b78, roughness: 0.85 }),
      aoBlob: new THREE.MeshBasicMaterial({
        map: aoTex, transparent: true, depthWrite: false,
      }),
      aoWall: new THREE.MeshBasicMaterial({
        map: aoWallTex, transparent: true, depthWrite: false,
      }),
      aoSeat: new THREE.MeshBasicMaterial({
        map: aoSeatTex, transparent: true, depthWrite: false,
      }),
      // reposacabezas de color por zona tarifaria (como las fundas reales)
      zone: {
        one: mkStd({ color: 0xf2d21f, roughness: 0.85 }),
        plus: mkStd({ color: 0x17b8ae, roughness: 0.85 }),
        space: mkStd({ color: 0x8b2fc9, roughness: 0.85 }),
        front: mkStd({ color: 0xcfc7b8, roughness: 0.9 }),
        regular: mkStd({ color: 0xe8e4da, roughness: 0.9 }),
      },
    };

    const unitBox = new THREE.BoxGeometry(1, 1, 1);
    const unitPlane = new THREE.PlaneGeometry(1, 1);

    // mar de nubes muy por debajo: cúmulos que la niebla funde con el horizonte
    const deckMat = new THREE.SpriteMaterial({
      map: cloudTex, opacity: 0.6, depthWrite: false, fog: true,
    });
    const deckClouds = [];
    for (let i = 0; i < 90; i++) {
      const sp = new THREE.Sprite(deckMat);
      const sc = 26 + hash01(`dk${i}c`) * 46;
      sp.position.set(
        (hash01(`dk${i}a`) - 0.5) * 420,
        -40 - hash01(`dk${i}d`) * 12,
        (hash01(`dk${i}b`) - 0.5) * 420
      );
      sp.scale.set(sc, sc * 0.7, 1);
      scene.add(sp);
      deckClouds.push(sp);
    }

    // nubes exteriores
    const clouds = [];
    for (let i = 0; i < 22; i++) {
      const s = new THREE.Sprite(mats.cloud);
      const h = hash01(`cloud${i}`);
      const h2 = hash01(`cloudb${i}`);
      const h3 = hash01(`cloudc${i}`);
      const side = i % 2 === 0 ? 1 : -1;
      s.position.set(side * (14 + h * 60), -6 + h2 * 10, -30 + h3 * 90);
      const sc = 7 + h * 12;
      s.scale.set(sc, sc * 0.42, 1);
      scene.add(s);
      clouds.push(s);
    }

    // ---- plantilla de asiento --------------------------------------------------
    // bake que conserva los meshes con nombre ('swap' = tapizado que cambia de
    // estado, 'hr' = reposacabezas que toma el color de la zona tarifaria)
    const bakeTemplate = (group) => {
      group.updateMatrixWorld(true);
      const buckets = new Map();
      group.traverse((m) => {
        if (!m.isMesh) return;
        const named = m.name === 'swap' || m.name === 'hr';
        const key = named ? m.name : m.material.uuid;
        if (!buckets.has(key)) {
          buckets.set(key, { mat: m.material, name: named ? m.name : '', geos: [] });
        }
        const g = m.geometry.clone();
        g.applyMatrix4(m.matrixWorld);
        buckets.get(key).geos.push(g);
      });
      const out = new THREE.Group();
      for (const b of buckets.values()) {
        const merged = BufferGeometryUtils.mergeBufferGeometries(b.geos, false);
        b.geos.forEach((g) => g.dispose());
        const mesh = new THREE.Mesh(merged, b.mat);
        mesh.name = b.name;
        out.add(mesh);
      }
      return out;
    };

    const buildSeat = () => {
      const w = 0.48;
      const g = new THREE.Group();
      const add = (geo, mat, x, y, z, sx, sy, sz, name = '') => {
        const m = new THREE.Mesh(geo, mat);
        m.position.set(x, y, z);
        m.scale.set(sx, sy, sz);
        m.name = name;
        g.add(m);
        return m;
      };
      add(unitBox, mats.metal, 0, 0.16, 0, w * 0.8, 0.06, 0.42);
      add(unitBox, mats.metal, -w * 0.38, 0.08, 0.1, 0.05, 0.16, 0.05);
      add(unitBox, mats.metal, w * 0.38, 0.08, 0.1, 0.05, 0.16, 0.05);
      add(unitBox, mats.seat, 0, 0.34, 0, w, 0.13, 0.46, 'swap');
      const tilt = new THREE.Group();
      tilt.position.set(0, 0.32, 0.2);
      tilt.rotation.x = 0.14;
      g.add(tilt);
      // respaldo de UNA pieza, alto y con el reposacabezas integrado
      const back = new THREE.Mesh(unitBox, mats.seat);
      back.position.set(0, 0.46, 0);
      back.scale.set(w, 0.92, 0.075);
      back.name = 'swap';
      tilt.add(back);
      // funda de zona tarifaria: envuelve la parte alta del respaldo (se ve
      // de frente y también desde arriba en el plano de asientos)
      const cover = new THREE.Mesh(unitBox, mats.zone.regular);
      cover.position.set(0, 0.81, 0);
      cover.scale.set(w * 0.94, 0.26, 0.115);
      cover.name = 'hr';
      tilt.add(cover);
      // oclusión de la junta cojín-respaldo: degradado oscuro→transparente
      // subiendo por la base del respaldo y retrocediendo sobre el cojín
      const creaseBack = new THREE.Mesh(unitPlane, mats.aoSeat);
      creaseBack.scale.set(w * 0.98, 0.2, 1);
      creaseBack.position.set(0, 0.1, -0.043);
      creaseBack.rotation.y = Math.PI;
      tilt.add(creaseBack);
      const creaseSeat = new THREE.Mesh(unitPlane, mats.aoSeat);
      creaseSeat.scale.set(w * 0.98, 0.17, 1);
      creaseSeat.rotation.x = -Math.PI / 2;
      creaseSeat.position.set(0, 0.409, 0.135);
      g.add(creaseSeat);
      // sin reposabrazos propios: en un avión se COMPARTEN entre asientos y se
      // generan aparte por fila (uno entre cada par + los dos extremos)
      return bakeTemplate(g);
    };

    // plantillas para geometría fusionada por cabina: reposabrazos compartidos
    // y manchas de oclusión bajo cada asiento
    const armTpl = (() => {
      const pad = new THREE.BoxGeometry(0.07, 0.045, 0.42);
      pad.translate(0, 0.46, 0.04);
      const sup = new THREE.BoxGeometry(0.05, 0.16, 0.05);
      sup.translate(0, 0.37, 0.2);
      const merged = BufferGeometryUtils.mergeBufferGeometries([pad, sup], false);
      pad.dispose();
      sup.dispose();
      return merged;
    })();
    const blobTpl = new THREE.PlaneGeometry(0.66, 0.62);
    blobTpl.rotateX(-Math.PI / 2);

    T.current = {
      renderer, scene, camera, mats, unitBox, unitPlane, sun, clouds, winAlpha,
      livery, linerTex, envTex, cutPlane, cutTarget: CUT_Y,
      armTpl, blobTpl,
      seatTemplate: buildSeat(),
      seatsGroup: null, cabinGroup: null,
      seatList: [],
      seatByKey: new Map(),
      rowMeta: new Map(),
      rims: [],
      occupiedSet: new Set(),
      soldSet: new Set(),
      proposal: new Set(),
      disposables: [],
      cabin: { len: 24, zEnd: 22 },
      wingZ: { c: 9, half: 2.4 },
      orbit: { theta: 0, phi: 0.16, radius: 26, target: new THREE.Vector3(0, 0.6, 10) },
      homeView: { theta: 0, phi: 0.16, radius: 26, target: new THREE.Vector3(0, 0.6, 10) },
      pov: { active: false, eye: new THREE.Vector3(), yaw: Math.PI, pitch: 0 },
      flight: null,
      lastLookTarget: new THREE.Vector3(0, 0.6, 10),
      raycaster: new THREE.Raycaster(),
      pointers: new Map(),
      downInfo: null,
      painting: false,
      lastPaintKey: null,
      lastPaintTime: 0,
      lastHoverTime: 0,
      pinchDist: 0,
      markerKeys: [],
      markerIdx: 0,
      markerNextAt: 0,
      viewOff: 0,
      lastAircraft: null,
      introStart: 0,
      raf: 0,
    };

    // baliza de asiento propuesto
    const markerMat = new THREE.MeshStandardMaterial({
      color: 0x1f9d55, emissive: 0x34d399, emissiveIntensity: 1.1,
    });
    const markerGrp = new THREE.Group();
    const cone = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.28, 14), markerMat);
    cone.rotation.x = Math.PI;
    markerGrp.add(cone);
    const mring = new THREE.Mesh(new THREE.TorusGeometry(0.26, 0.022, 8, 30), markerMat);
    mring.rotation.x = Math.PI / 2;
    mring.position.y = -0.4;
    markerGrp.add(mring);
    markerGrp.visible = false;
    scene.add(markerGrp);
    T.current.marker = markerGrp;
    const markerPos = new THREE.Vector3();

    // ---- cámara ---------------------------------------------------------------
    const orbitPos = (o) =>
      new THREE.Vector3(
        o.target.x + o.radius * Math.sin(o.phi) * Math.sin(o.theta),
        o.target.y + o.radius * Math.cos(o.phi),
        o.target.z + o.radius * Math.sin(o.phi) * Math.cos(o.theta)
      );

    const flyTo = (toPos, toTgt, onDone, dur = FLY_MS) => {
      const t = T.current;
      t.flight = {
        t0: performance.now(), dur,
        fromPos: camera.position.clone(), toPos: toPos.clone(),
        fromTgt: t.lastLookTarget.clone(), toTgt: toTgt.clone(),
        onDone,
      };
    };

    const dirFromYawPitch = (yaw, pitch) =>
      new THREE.Vector3(
        Math.cos(pitch) * Math.sin(yaw),
        Math.sin(pitch),
        Math.cos(pitch) * Math.cos(yaw)
      );

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
      const eye = new THREE.Vector3(p.x * 0.82, p.y + 1.14, p.z + 0.05);
      setPanelOpen(false);
      hideTip();
      const u = seatGroup.userData;
      const tgt =
        u.kind === 'ventanilla'
          ? new THREE.Vector3(Math.sign(p.x) * 9, WIN_Y - 0.45, p.z - 0.6)
          : new THREE.Vector3(p.x * 0.3, 1.3, p.z - 8);
      t.cutTarget = CUT_CLOSED;
      flyTo(eye, tgt, () => {
        t.pov.active = true;
        t.pov.eye.copy(eye);
        const d = tgt.clone().sub(eye).normalize();
        t.pov.yaw = Math.atan2(d.x, d.z);
        t.pov.pitch = Math.asin(THREE.MathUtils.clamp(d.y, -1, 1));
        setPovUI(true);
      });
    };
    T.current.enterPovAt = enterPovAt;

    T.current.goHome = () => {
      const t = T.current;
      if (t.flight) return;
      const home = t.homeView;
      t.orbit.theta = home.theta;
      t.orbit.phi = home.phi;
      t.orbit.radius = home.radius;
      t.orbit.target.copy(home.target);
      setPovUI(false);
      t.cutTarget = CUT_Y;
      flyTo(orbitPos(t.orbit), t.orbit.target, () => {
        t.pov.active = false;
      });
    };

    // ---- picking / pintado ----------------------------------------------------
    const pickAt = (clientX, clientY) => {
      const t = T.current;
      const rect = renderer.domElement.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((clientX - rect.left) / rect.width) * 2 - 1,
        -((clientY - rect.top) / rect.height) * 2 + 1
      );
      t.raycaster.setFromCamera(ndc, camera);
      if (!t.seatsGroup) return null;
      const hits = t.raycaster.intersectObjects([t.seatsGroup], true);
      for (const hh of hits) {
        let o = hh.object;
        while (o && !o.userData.isSeat) o = o.parent;
        if (o) return { seat: o };
      }
      return null;
    };

    const applyModeTo = (seat) => {
      const m = modeRef.current;
      const key = seat.userData.key;
      if (m === 'sel') seatStates.current.set(key, 'sel');
      else if (m === 'block') seatStates.current.set(key, 'blocked');
      else if (m === 'clear') {
        seatStates.current.delete(key);
        T.current.soldSet.delete(key);
      }
      applySeatState(seat);
      recount();
    };
    T.current.applyModeTo = applyModeTo;

    const el = renderer.domElement;
    const MARK_MODES = ['sel', 'block', 'clear'];

    const onPointerDown = (e) => {
      const t = T.current;
      hideTip();
      if (e.pointerType === 'mouse') t.pointers.clear();
      t.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (t.pointers.size === 2) {
        const [a, b] = [...t.pointers.values()];
        t.pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
      }
      t.downInfo = { x: e.clientX, y: e.clientY, dragged: false };
      el.setPointerCapture && el.setPointerCapture(e.pointerId);
      if (
        !t.flight && !t.pov.active && t.pointers.size === 1 &&
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
        const now = performance.now();
        if (t.pov.active || t.flight || now - t.lastHoverTime < 90) return;
        t.lastHoverTime = now;
        const res = pickAt(e.clientX, e.clientY);
        if (res && res.seat) {
          const u = res.seat.userData;
          const st = seatStates.current.get(u.key);
          let extra = ` · ${ZONE_LABELS[u.zone]}`;
          if (st === 'blocked') extra += ' · Bloqueado';
          else if (t.soldSet.has(u.key) || t.occupiedSet.has(u.key)) extra += ' · Vendido';
          else if (st === 'sel') extra += ' · Seleccionado';
          showTip(e.clientX, e.clientY, `${u.num}${u.letter} · ${u.kind}${extra}`);
        } else hideTip();
        return;
      }
      const prev = t.pointers.get(e.pointerId);
      const dx = e.clientX - prev.x;
      const dy = e.clientY - prev.y;
      t.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (t.downInfo) {
        if (Math.hypot(e.clientX - t.downInfo.x, e.clientY - t.downInfo.y) > 6)
          t.downInfo.dragged = true;
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
        const [a, b] = [...t.pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (t.pinchDist > 0 && !t.pov.active) {
          t.orbit.radius = THREE.MathUtils.clamp(t.orbit.radius * (t.pinchDist / d), 5, 60);
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
        t.orbit.phi = THREE.MathUtils.clamp(t.orbit.phi - dy * 0.0045, 0.12, 1.5);
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
      if (wasPainting) return;
      if (!info || info.dragged || t.flight || t.pointers.size > 0) return;
      const res = pickAt(e.clientX, e.clientY);
      if (!res) return;
      const m = modeRef.current;
      if (m === 'pov' || t.pov.active) {
        enterPovAt(res.seat);
        return;
      }
      applyModeTo(res.seat);
    };

    const onWheel = (e) => {
      const t = T.current;
      if (t.pov.active || t.flight) return;
      e.preventDefault();
      t.orbit.radius = THREE.MathUtils.clamp(t.orbit.radius * (1 + e.deltaY * 0.001), 5, 60);
    };

    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
    el.addEventListener('wheel', onWheel, { passive: false });

    // desplaza la proyección para centrar la escena en la parte visible
    const applyViewOffset = () => {
      const t = T.current;
      const w = mount.clientWidth;
      const h = mount.clientHeight;
      if (t.viewOff) camera.setViewOffset(w, h, t.viewOff, 0, w, h);
      else camera.clearViewOffset();
    };

    const onResize = () => {
      camera.aspect = mount.clientWidth / mount.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(mount.clientWidth, mount.clientHeight);
      applyViewOffset();
    };
    window.addEventListener('resize', onResize);

    // ---- bucle ----------------------------------------------------------------
    const animate = () => {
      const t = T.current;
      const now = performance.now();

      const wantOff = panelOpenRef.current && !narrowRef.current ? PANEL_OFFSET : 0;
      if (t.viewOff !== wantOff) {
        t.viewOff += (wantOff - t.viewOff) * 0.14;
        if (Math.abs(wantOff - t.viewOff) < 0.5) t.viewOff = wantOff;
        applyViewOffset();
      }

      // corte de la maqueta: baja al plano abierto, sube en la vista de asiento
      const cp = t.cutPlane;
      if (cp.constant !== t.cutTarget) {
        cp.constant += (t.cutTarget - cp.constant) * 0.09;
        if (Math.abs(t.cutTarget - cp.constant) < 0.01) cp.constant = t.cutTarget;
        // el canto solo existe mientras la maqueta está abierta
        if (t.rims) for (const r of t.rims) r.visible = cp.constant < CUT_Y + 0.05;
      }
      for (const c of deckClouds) {
        c.position.z += 0.05;
        if (c.position.z > 210) c.position.z -= 420;
      }

      for (const c of clouds) {
        c.position.z += 0.028;
        if (c.position.z > t.cabin.zEnd + 60) c.position.z -= 150;
      }

      // animación de cambio de avión: el fuselaje se estira hasta su longitud
      if (t.introStart) {
        const k = Math.min(1, (now - t.introStart) / 700);
        const e = 1 - Math.pow(1 - k, 3);
        const s = 0.86 + 0.14 * e;
        if (t.cabinGroup) t.cabinGroup.scale.z = s;
        if (t.seatsGroup) t.seatsGroup.scale.z = s;
        if (k >= 1) {
          t.introStart = 0;
          if (t.cabinGroup) t.cabinGroup.scale.z = 1;
          if (t.seatsGroup) t.seatsGroup.scale.z = 1;
        }
      }

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
        camera.position.set(
          t.pov.eye.x,
          t.pov.eye.y + Math.sin(now * 0.0013) * 0.01,
          t.pov.eye.z
        );
        const d = dirFromYawPitch(t.pov.yaw, t.pov.pitch);
        t.lastLookTarget.copy(camera.position).add(d);
        camera.lookAt(t.lastLookTarget);
      } else {
        const pos = orbitPos(t.orbit);
        if (pos.y < 0.5) pos.y = 0.5;
        camera.position.copy(pos);
        t.lastLookTarget.copy(t.orbit.target);
        camera.lookAt(t.orbit.target);
      }

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
          const bob = Math.sin(now * 0.005) * 0.05;
          t.marker.position.set(markerPos.x, markerPos.y + 1.45 + bob, markerPos.z);
          t.marker.rotation.y = now * 0.0012;
          t.marker.visible = true;
          if (lbl) {
            markerPos.y += 1.8;
            markerPos.project(camera);
            if (markerPos.z < 1) {
              const u = seat.userData;
              lbl.textContent = `${u.num}${u.letter} · ${u.kind}  (${(t.markerIdx % mk.length) + 1}/${mk.length})`;
              lbl.style.display = 'block';
              lbl.style.left = `${(markerPos.x * 0.5 + 0.5) * mount.clientWidth}px`;
              lbl.style.top = `${(-markerPos.y * 0.5 + 0.5) * mount.clientHeight}px`;
            } else lbl.style.display = 'none';
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

    return () => {
      const t = T.current;
      cancelAnimationFrame(t.raf);
      window.removeEventListener('resize', onResize);
      el.removeEventListener('pointerdown', onPointerDown);
      el.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
      el.removeEventListener('wheel', onWheel);
      envRT.dispose(); // el mapa de entorno vive en su propio render target
      disposeThree(scene, renderer, [
        t.mats, t.seatTemplate, t.armTpl, t.blobTpl, t.marker, t.disposables,
      ]);
      mount.removeChild(renderer.domElement);
      T.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --------------------------------------------------------------------------
  // Estado visual del asiento (el reposacabezas conserva el color de zona)
  // --------------------------------------------------------------------------
  const applySeatState = useCallback((seatGroup) => {
    const t = T.current;
    if (!t) return;
    const key = seatGroup.userData.key;
    const state = seatStates.current.get(key) || null;
    let override = null;
    if (wingViewRef.current) override = t.mats.heat[seatGroup.userData.heat || 0];
    else if (state === 'blocked') override = t.mats.blocked;
    else if (t.proposal.has(key)) override = t.mats.proposal;
    else if (t.soldSet.has(key) || t.occupiedSet.has(key)) override = t.mats.sold;
    else if (state === 'sel') override = t.mats.selMark;
    seatGroup.traverse((m) => {
      if (!m.isMesh || m.name !== 'swap') return;
      m.material = override || t.mats.seat;
    });
  }, []);

  // ---- minimapa ---------------------------------------------------------------
  const drawMinimap = useCallback(() => {
    const t = T.current;
    const cv = minimapRef.current;
    if (!t || !cv || !t.seatList.length) return;
    const cssW = narrowRef.current ? 224 : 252;
    const pad = 8;
    const zMin = Z_FRONT - 4.4; // morro
    const zMax = t.cabin.zEnd + 6.2; // cola
    const len = zMax - zMin;
    const scale = (cssW - pad * 2) / len;
    const cssH = Math.max(3.96 * scale + pad * 2 + 8, 9.6 * scale + 8);
    const dpr = 2;
    cv.width = cssW * dpr;
    cv.height = cssH * dpr;
    cv.style.width = `${cssW}px`;
    cv.style.height = `${cssH}px`;
    const ctx = cv.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, cssW, cssH);
    const zx = (z) => pad + (z - zMin) * scale;
    const xy = (x) => cssH / 2 + x * scale;
    const yT = cssH / 2 - 1.98 * scale;
    const yB = cssH / 2 + 1.98 * scale;
    ctx.strokeStyle = 'rgba(255,255,255,.45)';
    ctx.lineWidth = 1.5;
    // tubo + morro redondeado + cono de cola
    ctx.beginPath();
    ctx.moveTo(zx(t.cabin.zEnd), yT);
    ctx.lineTo(zx(Z_FRONT), yT);
    ctx.quadraticCurveTo(zx(zMin), cssH / 2, zx(Z_FRONT), yB);
    ctx.lineTo(zx(t.cabin.zEnd), yB);
    ctx.quadraticCurveTo(zx(zMax) - 4, cssH / 2 + 2, zx(zMax), cssH / 2);
    ctx.quadraticCurveTo(zx(zMax) - 4, cssH / 2 - 2, zx(t.cabin.zEnd), yT);
    ctx.stroke();
    // parabrisas
    ctx.strokeStyle = 'rgba(255,255,255,.55)';
    ctx.beginPath();
    ctx.moveTo(zx(Z_FRONT - 2.2), cssH / 2 - 1.1 * scale);
    ctx.quadraticCurveTo(zx(Z_FRONT - 3.4), cssH / 2, zx(Z_FRONT - 2.2), cssH / 2 + 1.1 * scale);
    ctx.stroke();
    // estabilizadores de cola + deriva
    ctx.fillStyle = 'rgba(255,255,255,.28)';
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(zx(t.cabin.zEnd + 3.4), xy(s * 0.4));
      ctx.lineTo(zx(t.cabin.zEnd + 5.4), xy(s * 4.5));
      ctx.lineTo(zx(t.cabin.zEnd + 6.0), xy(s * 4.5));
      ctx.lineTo(zx(t.cabin.zEnd + 5.0), xy(s * 0.4));
      ctx.closePath();
      ctx.fill();
    }
    ctx.fillRect(zx(t.cabin.zEnd + 3.2), cssH / 2 - 1.5, 2.6 * scale, 3);
    ctx.fillStyle = 'rgba(255,255,255,.25)';
    const wz = zx(t.wingZ.c);
    ctx.beginPath();
    ctx.moveTo(wz - t.wingZ.half * scale, 2);
    ctx.lineTo(wz + t.wingZ.half * scale + 8, 2);
    ctx.lineTo(wz + 2, cssH / 2 - 1.9 * scale);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(wz - t.wingZ.half * scale, cssH - 2);
    ctx.lineTo(wz + t.wingZ.half * scale + 8, cssH - 2);
    ctx.lineTo(wz + 2, cssH / 2 + 1.9 * scale);
    ctx.closePath();
    ctx.fill();
    const dot = Math.max(2.4, scale * 0.42);
    for (const s of t.seatList) {
      const st = seatStates.current.get(s.key);
      let c = ZONE_COLORS[s.zone];
      if (wingViewRef.current) {
        c = s.heat === 0 ? '#2f9e44' : s.heat === 1 ? '#e8a013' : '#d9480f';
      } else if (st === 'blocked') c = STATE_COLORS.blocked;
      else if (t.proposal.has(s.key)) c = STATE_COLORS.proposal;
      else if (t.soldSet.has(s.key) || t.occupiedSet.has(s.key)) c = STATE_COLORS.sold;
      else if (st === 'sel') c = STATE_COLORS.sel;
      ctx.fillStyle = c;
      ctx.fillRect(zx(s.pz) - dot / 2, xy(s.px) - dot / 2, dot, dot);
    }
    t.miniMap = { scale, pad, cssH, zMin };
  }, []);

  // el minimapa cambia de ancho entre móvil y escritorio
  useEffect(() => {
    drawMinimap();
  }, [isNarrow, drawMinimap]);

  const onMinimapClick = useCallback((e) => {
    const t = T.current;
    const cv = minimapRef.current;
    if (!t || !cv || !t.miniMap) return;
    const rect = cv.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const { scale, pad, cssH, zMin } = t.miniMap;
    let best = null;
    let bestD = 9e9;
    for (const s of t.seatList) {
      const x = pad + (s.pz - zMin) * scale;
      const y = cssH / 2 + s.px * scale;
      const d = Math.hypot(x - cx, y - cy);
      if (d < bestD) { bestD = d; best = s; }
    }
    if (!best || bestD > 9) return;
    const seat = t.seatByKey.get(best.key);
    if (!seat) return;
    if (modeRef.current === 'pov' || t.pov.active) t.enterPovAt(seat);
    else {
      pushHistory();
      t.applyModeTo(seat);
    }
  }, [pushHistory]);

  const recount = useCallback(() => {
    const t = T.current;
    if (!t) return;
    let sel = 0, blocked = 0, sold = 0;
    const soldZ = { one: 0, plus: 0, space: 0, front: 0, regular: 0 };
    const totZ = { one: 0, plus: 0, space: 0, front: 0, regular: 0 };
    for (const s of t.seatList) {
      const st = seatStates.current.get(s.key);
      if (st === 'blocked') { blocked++; continue; }
      totZ[s.zone]++;
      if (t.soldSet.has(s.key) || t.occupiedSet.has(s.key)) {
        sold++;
        soldZ[s.zone]++;
      }
      if (st === 'sel') sel++;
    }
    setCounts({ total: t.seatList.length, sel, blocked, sold, soldZ, totZ });
    drawMinimap();
  }, [drawMinimap]);

  useEffect(() => {
    wingViewRef.current = wingView;
    const t = T.current;
    if (!t || !t.seatsGroup) return;
    for (const seat of t.seatsGroup.children) applySeatState(seat);
    drawMinimap();
  }, [wingView, applySeatState, drawMinimap]);


  // --------------------------------------------------------------------------
  // Regeneración de la cabina
  // --------------------------------------------------------------------------
  useEffect(() => {
    const t = T.current;
    if (!t) return;
    const { scene, mats, unitBox, unitPlane } = t;
    const { aircraft, pitch, occupancy } = params;
    const model = AIRCRAFT[aircraft] || AIRCRAFT.a320;

    // al cambiar de modelo, archivar el estado del anterior y cargar el suyo
    const prevAircraft = t.lastAircraft;
    const changed = prevAircraft !== aircraft;
    if (changed) {
      if (prevAircraft) {
        layoutsRef.current[prevAircraft] = {
          states: [...seatStates.current.entries()],
          sold: [...t.soldSet],
        };
      }
      const next = layoutsRef.current[aircraft] || {};
      seatStates.current = new Map(next.states || []);
      t.soldSet = new Set(next.sold || []);
      t.lastAircraft = aircraft;
      clearHistory();
    }

    for (const k of ['seatsGroup', 'cabinGroup']) {
      if (t[k]) { scene.remove(t[k]); t[k] = null; }
    }
    t.disposables.forEach((d) => d.dispose());
    t.disposables = [];
    t.proposal = new Set();
    t.markerKeys = [];
    setProposal(null);

    const seatsGroup = new THREE.Group();
    const cabinGroup = new THREE.Group();
    t.seatsGroup = seatsGroup;
    t.cabinGroup = cabinGroup;
    scene.add(seatsGroup, cabinGroup);
    t.seatList = [];
    t.seatByKey = new Map();
    t.rowMeta = new Map();
    t.occupiedSet = new Set();

    const maxNum = displayNum(model.rows - 1);
    const exitNums = new Set(model.exits);
    const zoneOf = (num) => {
      if (num === 1) return 'one';
      if (num >= 2 && num <= 4) return 'plus';
      if (exitNums.has(num)) return 'space';
      if (num <= 9 || num >= maxNum - 2) return 'front';
      return 'regular';
    };

    const mkGeo = (g) => { t.disposables.push(g); return g; };

    // ---- filas ----------------------------------------------------------------
    const armGeos = [];
    const blobGeos = [];
    let z = 0;
    for (let r = 0; r < model.rows; r++) {
      const num = displayNum(r);
      const zone = zoneOf(num);
      const isExit = exitNums.has(num);
      const rowPitch =
        pitch + (zone === 'one' ? 0.2 : zone === 'plus' ? 0.1 : 0) + (isExit ? 0.24 : 0);
      z += rowPitch;
      const zRow = z;
      // fila 1 solo en el lado izquierdo en A319/A320 (a la derecha va el galley)
      const idxs =
        num === 1 && model.row1LeftOnly ? [0, 1, 2] : [0, 1, 2, 3, 4, 5];
      t.rowMeta.set(r, { num, zone, exit: isExit, z: zRow, idxs });
      for (const i of idxs) {
        const px = SEAT_X[i];
        const seat = t.seatTemplate.clone();
        seat.position.set(px, 0, zRow);
        const key = `${r}-${i}`;
        const kind = seatKind(px);
        seat.userData = {
          isSeat: true, key, row: r, num, idx: i,
          letter: LETTERS[i], kind, zone, exit: isExit,
          heat: 0, score: 0,
        };
        // reposacabezas con el color de la zona tarifaria
        seat.traverse((m) => {
          if (m.isMesh && m.name === 'hr') m.material = mats.zone[zone];
        });
        seatsGroup.add(seat);
        t.seatByKey.set(key, seat);
        t.seatList.push({
          key, row: r, num, idx: i, letter: LETTERS[i], kind,
          zone, exit: isExit, px, pz: zRow, score: 0, heat: 0,
        });
        if (hash01(key) < occupancy / 100) t.occupiedSet.add(key);
        // mancha de oclusión bajo el asiento
        const blob = t.blobTpl.clone();
        blob.translate(px, 0.012, zRow + 0.03);
        blobGeos.push(blob);
      }
      // reposabrazos COMPARTIDOS: uno entre cada par de asientos del bloque
      // más los dos extremos (como en un avión real)
      const leftXs = idxs.filter((i) => i < 3).map((i) => SEAT_X[i]);
      const rightXs = idxs.filter((i) => i >= 3).map((i) => SEAT_X[i]);
      for (const xs of [leftXs, rightXs]) {
        if (!xs.length) continue;
        const arms = [xs[0] - 0.27];
        for (let k = 0; k < xs.length - 1; k++) arms.push((xs[k] + xs[k + 1]) / 2);
        arms.push(xs[xs.length - 1] + 0.27);
        for (const ax of arms) {
          const g = t.armTpl.clone();
          g.translate(ax, 0, zRow);
          armGeos.push(g);
        }
      }
    }
    const zEnd = z + 0.9;
    const len = zEnd - Z_FRONT;
    t.cabin = { len, zEnd };

    const wingC = Z_FRONT + len * 0.44;
    const wingHalf = 2.4;
    t.wingZ = { c: wingC, half: wingHalf };

    for (const s of t.seatList) {
      const overWing = Math.abs(s.pz - wingC) < wingHalf;
      const nearWing = Math.abs(s.pz - wingC) < wingHalf + 1.6;
      s.heat = overWing ? 2 : nearWing ? 1 : 0;
      const zoneBonus =
        s.zone === 'one' ? -1.2 : s.zone === 'plus' ? -0.8 : s.zone === 'space' ? -0.6 : 0;
      s.score =
        s.row * 0.045 +
        (s.kind === 'centro' ? 0.65 : s.kind === 'pasillo' ? 0.18 : 0) +
        zoneBonus;
      const g = t.seatByKey.get(s.key);
      g.userData.heat = s.heat;
      g.userData.score = s.score;
      applySeatState(g);
    }
    seatsGroup.updateMatrixWorld(true);
    // congela las matrices de las butacas pero deja vivo el nodo raíz para
    // poder animar la escala del grupo al cambiar de avión
    seatsGroup.traverse((o) => {
      if (o !== seatsGroup) o.matrixAutoUpdate = false;
    });

    // fusionar reposabrazos y manchas AO en un mesh cada uno (2 draw calls)
    if (armGeos.length) {
      const merged = mkGeo(BufferGeometryUtils.mergeBufferGeometries(armGeos, false));
      armGeos.forEach((g) => g.dispose());
      cabinGroup.add(new THREE.Mesh(merged, mats.armrest));
    }
    if (blobGeos.length) {
      const merged = mkGeo(BufferGeometryUtils.mergeBufferGeometries(blobGeos, false));
      blobGeos.forEach((g) => g.dispose());
      cabinGroup.add(new THREE.Mesh(merged, mats.aoBlob));
    }

    // ---- cabina ---------------------------------------------------------------
    // forro interior (visto por dentro) y casco exterior pintado, ambos con
    // las ventanillas recortadas y cortados a la altura CUT_Y
    const fusGeo = mkGeo(new THREE.CylinderGeometry(R_FUS, R_FUS, len, 64, 1, true));
    fusGeo.rotateX(Math.PI / 2);
    t.winAlpha.repeat.set(1, len / WIN_EVERY);
    // con map + alphaMap el material usa la transformación UV del map
    t.livery.repeat.set(1, len / WIN_EVERY);
    t.linerTex.repeat.set(1, len / WIN_EVERY);
    const fus = new THREE.Mesh(fusGeo, mats.liner);
    fus.position.set(0, YC, Z_FRONT + len / 2);
    cabinGroup.add(fus);
    const shellGeo = mkGeo(new THREE.CylinderGeometry(R_OUT, R_OUT, len, 64, 1, true));
    shellGeo.rotateX(Math.PI / 2);
    const shell = new THREE.Mesh(shellGeo, mats.shell);
    shell.position.copy(fus.position);
    cabinGroup.add(shell);
    for (const sx of [-1, 1]) {
      const tint = new THREE.Mesh(unitPlane, mats.winTint);
      tint.scale.set(len, 0.56, 1);
      tint.rotation.y = (sx * Math.PI) / 2; // mira hacia fuera
      // entre forro y casco en toda su altura (el casco es curvo: más fuera
      // asomaría por el borde inferior)
      tint.position.set(sx * (R_OUT - 0.08), WIN_Y, Z_FRONT + len / 2);
      cabinGroup.add(tint);
    }
    // canto del corte: tapa el grosor entre forro y casco en ambos costados
    {
      const dy = CUT_Y - YC;
      const xi = Math.sqrt(R_FUS * R_FUS - dy * dy);
      const xo = Math.sqrt(R_OUT * R_OUT - dy * dy);
      t.rims = [];
      for (const sx of [-1, 1]) {
        const rim = new THREE.Mesh(unitBox, mats.rim);
        rim.scale.set(xo - xi + 0.01, 0.025, len);
        rim.position.set(sx * (xi + xo) / 2, CUT_Y - 0.0125, Z_FRONT + len / 2);
        rim.visible = t.cutPlane.constant < CUT_Y + 0.05;
        cabinGroup.add(rim);
        t.rims.push(rim);
      }
    }

    for (const sx of [-1, 1]) {
      const strip = new THREE.Mesh(unitPlane, mats.glass);
      strip.scale.set(len, 0.72, 1);
      strip.rotation.y = (sx * -Math.PI) / 2;
      strip.rotation.z = sx * -0.09;
      strip.position.set(sx * (R_FUS - 0.06), WIN_Y, Z_FRONT + len / 2);
      cabinGroup.add(strip);
    }

    const floor = new THREE.Mesh(unitBox, mats.floor);
    floor.scale.set(3.96, 0.1, len);
    floor.position.set(0, -0.05, Z_FRONT + len / 2);
    cabinGroup.add(floor);
    const aisle = new THREE.Mesh(unitBox, mats.aisle);
    aisle.scale.set(0.56, 0.02, len);
    aisle.position.set(0, 0.012, Z_FRONT + len / 2);
    cabinGroup.add(aisle);

    // oclusión en la junta suelo-pared (degradado oscuro que sube por la pared)
    for (const sx of [-1, 1]) {
      const ao = new THREE.Mesh(unitPlane, mats.aoWall);
      ao.scale.set(len, 0.55, 1);
      ao.rotation.y = (sx * -Math.PI) / 2;
      ao.position.set(sx * 2.3, 0.28, Z_FRONT + len / 2);
      cabinGroup.add(ao);
    }

    for (const sx of [-1, 1]) {
      // maletero: panel horizontal mirando hacia abajo (visible desde dentro,
      // invisible en la vista cenital para no tapar el plano de asientos)
      const bin = new THREE.Mesh(unitPlane, mats.bin);
      bin.scale.set(0.85, len, 1);
      bin.rotation.x = Math.PI / 2; // horizontal, boca abajo, largo según Z
      bin.position.set(sx * 1.25, 2.08, Z_FRONT + len / 2);
      cabinGroup.add(bin);
      const strip = new THREE.Mesh(unitBox, mats.lightStrip);
      strip.scale.set(0.06, 0.03, len - 1);
      strip.position.set(sx * 0.78, 2.42, Z_FRONT + len / 2);
      cabinGroup.add(strip);
    }

    const bhGeoF = mkGeo(new THREE.CircleGeometry(R_OUT, 56));
    const bhF = new THREE.Mesh(bhGeoF, mats.bulkhead);
    bhF.position.set(0, YC, Z_FRONT);
    cabinGroup.add(bhF);
    const bhGeoB = mkGeo(new THREE.CircleGeometry(R_OUT, 56));
    const bhB = new THREE.Mesh(bhGeoB, mats.bulkhead);
    bhB.position.set(0, YC, zEnd);
    bhB.rotation.y = Math.PI;
    cabinGroup.add(bhB);

    for (const [, meta] of t.rowMeta) {
      if (!meta.exit) continue;
      for (const sx of [-1, 1]) {
        const sign = new THREE.Mesh(unitPlane, mats.exit);
        sign.scale.set(0.42, 0.16, 1);
        sign.rotation.y = (sx * -Math.PI) / 2;
        sign.position.set(sx * (R_FUS - 0.12), 2.0, meta.z);
        cabinGroup.add(sign);
      }
    }

    // ---- exterior en 3D: alas, motores, morro y cola ----------------------------
    // desplaza en Y cada vértice según su posición t ∈ [0,1] a lo largo de la pieza
    const bendY = (geo, len2, dir, fn) => {
      const pos = geo.getAttribute('position');
      for (let i = 0; i < pos.count; i++) {
        const tt = THREE.MathUtils.clamp((dir * pos.getZ(i)) / len2, 0, 1);
        pos.setY(i, pos.getY(i) + fn(tt));
      }
      pos.needsUpdate = true;
      geo.computeVertexNormals();
    };

    // morro: ojiva con el eje caído hacia la punta y parabrisas oscuro
    const L_NOSE = 4.8;
    const noseR = (tt) => R_OUT * Math.sqrt(Math.max(0, 1 - Math.pow(tt, 2.2)));
    const noseDroop = (tt) => -0.6 * tt * tt;
    const nosePts = [];
    for (let i = 0; i <= 28; i++) {
      const tt = i / 28;
      nosePts.push(new THREE.Vector2(Math.max(0.002, noseR(tt)), tt * L_NOSE));
    }
    const noseGeo = mkGeo(new THREE.LatheGeometry(nosePts, 56));
    noseGeo.rotateX(-Math.PI / 2); // +y → -z: la punta mira hacia delante
    bendY(noseGeo, L_NOSE, -1, noseDroop);
    const nose = new THREE.Mesh(noseGeo, mats.paint);
    nose.position.set(0, YC, Z_FRONT);
    cabinGroup.add(nose);
    // parabrisas: cuatro paneles sobre la banda superior del morro
    const wsPts = [];
    for (let i = 0; i <= 6; i++) {
      const tt = 0.5 + (i / 6) * 0.15;
      wsPts.push(new THREE.Vector2(noseR(tt) + 0.012, tt * L_NOSE));
    }
    for (const [ph0, ph1] of [[-1.0, -0.56], [-0.5, -0.03], [0.03, 0.5], [0.56, 1.0]]) {
      const g2 = mkGeo(new THREE.LatheGeometry(wsPts, 8, ph0, ph1 - ph0));
      g2.rotateX(-Math.PI / 2);
      bendY(g2, L_NOSE, -1, noseDroop);
      const pane = new THREE.Mesh(g2, mats.cockpit);
      pane.position.set(0, YC, Z_FRONT);
      cabinGroup.add(pane);
    }

    // cono de cola: el eje sube a medida que se estrecha (la panza se recoge)
    const L_TAIL = 6.8;
    const tailR = (tt) => R_OUT * (1 - 0.84 * Math.pow(tt, 1.5));
    const tailRise = (tt) => (R_OUT - tailR(tt)) * 0.82;
    const tailPts = [];
    for (let i = 0; i <= 24; i++) {
      const tt = i / 24;
      tailPts.push(new THREE.Vector2(tailR(tt), tt * L_TAIL));
    }
    const tailGeo = mkGeo(new THREE.LatheGeometry(tailPts, 56));
    tailGeo.rotateX(Math.PI / 2); // +y → +z: hacia atrás
    bendY(tailGeo, L_TAIL, 1, tailRise);
    const tail = new THREE.Mesh(tailGeo, mats.paint);
    tail.position.set(0, YC, zEnd);
    cabinGroup.add(tail);
    const apuGeo = mkGeo(new THREE.CircleGeometry(tailR(1), 24));
    const apu = new THREE.Mesh(apuGeo, mats.fan);
    apu.position.set(0, YC + tailRise(1), zEnd + L_TAIL);
    cabinGroup.add(apu);

    // deriva: trapecio en flecha con cantos redondeados, en el color de la librea
    const finShape = new THREE.Shape();
    finShape.moveTo(1.2, 0);
    finShape.lineTo(4.6, 4.5);
    finShape.lineTo(6.1, 4.5);
    finShape.lineTo(6.0, 0);
    finShape.closePath();
    const finGeo = mkGeo(new THREE.ExtrudeGeometry(finShape, {
      depth: 0.24, bevelEnabled: true, bevelThickness: 0.05, bevelSize: 0.05, bevelSegments: 2,
    }));
    finGeo.rotateY(-Math.PI / 2); // x de la forma → z del avión
    finGeo.translate(0.12, 0, 0);
    const fin = new THREE.Mesh(finGeo, mats.tailPaint);
    fin.position.set(0, YC + 1.95, zEnd);
    cabinGroup.add(fin);

    // estabilizadores horizontales
    const stabShape = new THREE.Shape();
    stabShape.moveTo(0, 3.0);
    stabShape.lineTo(4.6, 4.9);
    stabShape.lineTo(4.6, 5.7);
    stabShape.lineTo(0, 5.3);
    stabShape.closePath();
    const stabGeo = mkGeo(new THREE.ExtrudeGeometry(stabShape, {
      depth: 0.12, bevelEnabled: true, bevelThickness: 0.03, bevelSize: 0.03, bevelSegments: 2,
    }));
    stabGeo.rotateX(Math.PI / 2); // y de la forma → z; grosor hacia abajo
    stabGeo.translate(0, 0.06, 0);

    // ala: trapecio en flecha que se afina hacia la punta, con winglet
    const wingShape = new THREE.Shape();
    wingShape.moveTo(0, -1.8); // raíz, borde de ataque
    wingShape.lineTo(10.5, 1.4); // punta, borde de ataque (flecha ~31°)
    wingShape.lineTo(10.5, 2.5); // punta, borde de fuga
    wingShape.lineTo(0, 2.0); // raíz, borde de fuga
    wingShape.closePath();
    const wingGeo = mkGeo(new THREE.ExtrudeGeometry(wingShape, {
      depth: 0.24, bevelEnabled: true, bevelThickness: 0.05, bevelSize: 0.05, bevelSegments: 2,
    }));
    wingGeo.rotateX(Math.PI / 2);
    wingGeo.translate(0, 0.12, 0);
    {
      const pos = wingGeo.getAttribute('position');
      for (let i = 0; i < pos.count; i++) {
        const k = 1 - 0.62 * THREE.MathUtils.clamp(pos.getX(i) / 10.5, 0, 1);
        pos.setY(i, pos.getY(i) * k);
      }
      wingGeo.computeVertexNormals();
    }
    const wlShape = new THREE.Shape();
    wlShape.moveTo(0, 0);
    wlShape.lineTo(1.1, 0);
    wlShape.lineTo(1.05, 1.15);
    wlShape.lineTo(0.72, 1.15);
    wlShape.closePath();
    const wlGeo = mkGeo(new THREE.ExtrudeGeometry(wlShape, {
      depth: 0.06, bevelEnabled: true, bevelThickness: 0.02, bevelSize: 0.02, bevelSegments: 1,
    }));
    wlGeo.rotateY(-Math.PI / 2);
    wlGeo.translate(0.03, 0, 0);

    // motor: góndola torneada con fan, cono de admisión y tobera
    const nacPts = [
      [0.6, 0], [0.7, 0.08], [0.75, 0.35], [0.74, 1.5], [0.65, 2.2], [0.5, 2.55],
    ].map(([r, y]) => new THREE.Vector2(r, y));
    const nacGeo = mkGeo(new THREE.LatheGeometry(nacPts, 36));
    nacGeo.rotateX(Math.PI / 2);
    const fanGeo = mkGeo(new THREE.CircleGeometry(0.62, 32));
    fanGeo.rotateY(Math.PI);
    const spinGeo = mkGeo(new THREE.ConeGeometry(0.17, 0.42, 20));
    spinGeo.rotateX(-Math.PI / 2);
    const nozGeo = mkGeo(new THREE.ConeGeometry(0.34, 0.75, 24));
    nozGeo.rotateX(Math.PI / 2);

    // cada lado es un grupo; el izquierdo es el derecho con escala -1 en X
    // (three invierte la orientación de caras con determinante negativo)
    for (const sx of [-1, 1]) {
      const side = new THREE.Group();
      side.scale.x = sx;

      const wing = new THREE.Mesh(wingGeo, mats.wing);
      // raíz entre forro y casco: con el biselado (5 cm) a x=2,35 asomaba
      // dentro de la cabina a la altura de la ventanilla
      wing.position.set(2.45, 0.75, wingC);
      wing.rotation.z = 0.05; // diedro
      side.add(wing);
      const winglet = new THREE.Mesh(wlGeo, mats.tailPaint);
      winglet.position.set(10.45, 0.02, 1.4);
      winglet.rotation.z = -0.22; // inclinado hacia fuera
      wing.add(winglet);

      const eng = new THREE.Group();
      eng.position.set(4.7, -0.22, wingC - 2.55);
      eng.add(new THREE.Mesh(nacGeo, mats.paint));
      const fanM = new THREE.Mesh(fanGeo, mats.fan);
      fanM.position.z = 0.28;
      eng.add(fanM);
      const spin = new THREE.Mesh(spinGeo, mats.engine);
      spin.position.z = 0.12;
      eng.add(spin);
      const noz = new THREE.Mesh(nozGeo, mats.fan);
      noz.position.z = 2.85;
      eng.add(noz);
      side.add(eng);
      const pylon = new THREE.Mesh(unitBox, mats.paint);
      pylon.scale.set(0.16, 0.34, 1.9);
      pylon.position.set(4.7, 0.62, wingC - 1.35);
      side.add(pylon);

      const stab = new THREE.Mesh(stabGeo, mats.paint);
      stab.position.set(0.3, YC + 0.95, zEnd);
      side.add(stab);

      cabinGroup.add(side);
    }

    t.homeView.theta = 0;
    t.homeView.phi = 0.14;
    // del morro (L_NOSE por delante) a la cola (L_TAIL por detrás)
    t.homeView.radius = Math.min(64, Math.max(20, (len + L_NOSE + L_TAIL) * 1.18));
    t.homeView.target.set(0, 0.6, Z_FRONT + len / 2 + (L_TAIL - L_NOSE) / 2);

    // animación al cambiar de avión: la cabina se estira hasta su nueva
    // longitud mientras la cámara vuela a encuadrarla
    if (changed) {
      t.introStart = performance.now();
      cabinGroup.scale.z = 0.86;
      seatsGroup.scale.z = 0.86;
      if (!t.pov.active) t.goHome();
    }

    recount();
  }, [params, applySeatState, recount]);

  // autoguardado: modelo, precios y el estado de cada avión sobreviven al F5
  useEffect(() => {
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      const t = T.current;
      if (!t || !t.lastAircraft) return;
      writeStorage(STORAGE_KEY, {
        v: 1,
        params,
        prices,
        byAircraft: {
          ...layoutsRef.current,
          [t.lastAircraft]: {
            states: [...seatStates.current.entries()],
            sold: [...t.soldSet],
          },
        },
      });
    }, 400);
    return () => window.clearTimeout(saveTimer.current);
  }, [params, prices, counts]);

  const resetAll = () => {
    if (!window.confirm('¿Restablecer la cabina y borrar las ventas de todos los aviones?')) return;
    const t = T.current;
    layoutsRef.current = {};
    seatStates.current = new Map();
    if (t) {
      t.soldSet = new Set();
      t.lastAircraft = null; // fuerza la recarga limpia del modelo actual
    }
    writeStorage(STORAGE_KEY, null);
    setPrices(DEFAULT_PRICES);
    setParams({ ...DEFAULT_PARAMS });
    showToast('Cabina restablecida');
  };

  // atajos: ⌘Z/⇧⌘Z, Esc, 1-3 modos, V vista, H vista general, M panel
  useKeys((e) => {
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === 'z') {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const t = T.current;
    if (k === 'escape') {
      if (povUI && t) t.goHome();
      else if (panelOpen) setPanelOpen(false);
      return;
    }
    if (povUI) return;
    if (k === '1') setMode('sel');
    else if (k === '2') setMode('block');
    else if (k === '3') setMode('clear');
    else if (k === 'v') setMode((m) => (m === 'pov' ? 'sel' : 'pov'));
    else if (k === 'h' && t) t.goHome();
    else if (k === 'm') setPanelOpen((o) => !o);
  });

  // --------------------------------------------------------------------------
  // Compra: mejores N asientos contiguos (mismo bloque, sin cruzar pasillo)
  // --------------------------------------------------------------------------
  const priceOf = useCallback(
    (s) => (s.zone === 'regular' ? 0 : prices[s.zone] || 0),
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
    const N = Math.max(1, Math.min(3, buyN));
    const cheap = buyPref === 'cheap';
    const sellable = (s) => {
      const st = seatStates.current.get(s.key);
      if (st === 'blocked' || t.soldSet.has(s.key) || t.occupiedSet.has(s.key))
        return false;
      if (cheap && s.zone !== 'regular') return false;
      return true;
    };
    const byRow = new Map();
    for (const s of t.seatList) {
      if (!byRow.has(s.row)) byRow.set(s.row, []);
      byRow.get(s.row)[s.idx] = s;
    }
    const blocks = [[0, 1, 2], [3, 4, 5]];
    let best = null;
    for (const [row, arr] of byRow) {
      for (const block of blocks) {
        for (let b0 = 0; b0 + N <= block.length; b0++) {
          let ok = true;
          let sum = 0;
          const seats = [];
          for (let k = 0; k < N; k++) {
            const s = arr[block[b0 + k]];
            if (!s || !sellable(s)) { ok = false; break; }
            sum += s.score;
            seats.push(s);
          }
          if (!ok) continue;
          if (!best || sum < best.sum) best = { row, sum, seats };
        }
      }
    }
    if (!best) {
      setProposal({ keys: [], total: 0, label: 'No quedan asientos juntos con ese criterio' });
      return;
    }
    const keys = best.seats.map((s) => s.key);
    t.proposal = new Set(keys);
    t.markerKeys = keys;
    t.markerIdx = -1;
    t.markerNextAt = 0;
    for (const k of keys) {
      const seat = t.seatByKey.get(k);
      if (seat) applySeatState(seat);
    }
    const total = best.seats.reduce((a, s) => a + priceOf(s), 0);
    const names = best.seats.map((s) => `${s.num}${s.letter}`).join(', ');
    const zone = ZONE_LABELS[best.seats[0].zone];
    setProposal({ keys, total, label: `${names} · ${zone}` });
    drawMinimap();
  }, [buyN, buyPref, priceOf, applySeatState, clearProposal, drawMinimap]);

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
    showToast(`Venta confirmada · ${fmtEUR(proposal.total)}`);
    setProposal(null);
    recount();
  }, [proposal, applySeatState, recount, pushHistory, showToast]);

  // --------------------------------------------------------------------------
  // UI
  // --------------------------------------------------------------------------
  const libres = counts.total - counts.blocked - counts.sold;
  const zoneRevenue = (zc) =>
    (counts.soldZ[zc] || 0) * (zc === 'regular' ? 0 : prices[zc] || 0);
  const revenue = ['one', 'plus', 'space', 'front'].reduce(
    (a, zc) => a + zoneRevenue(zc), 0
  );
  const potential = useMemo(
    () =>
      ['one', 'plus', 'space', 'front'].reduce(
        (a, zc) => a + (counts.totZ[zc] || 0) * (prices[zc] || 0), 0
      ),
    [counts, prices]
  );

  const model = AIRCRAFT[params.aircraft] || AIRCRAFT.a320;

  return (
    <div style={{ position: 'fixed', inset: 0, userSelect: 'none' }}>
      <div ref={mountRef} style={{ position: 'absolute', inset: 0 }} />

      <div ref={tipRef} style={ui.tip} />
      <div ref={markerLabelRef} style={ui.markerLabel} />

      {povUI && (
        <div style={ui.povHintWrap(miniBox())}>
          <div style={ui.povHint}>
            Vista desde el asiento — arrastra para mirar (¡busca el ala!) · toca
            otro asiento para saltar
          </div>
        </div>
      )}

      {povUI && (
        <button style={ui.backBtn} onClick={() => T.current && T.current.goHome()}>
          <Ic style={{ marginRight: 7 }}>{icons.back}</Ic>
          Volver al plano de cabina
        </button>
      )}

      {!povUI && onExit && (
        <button
          className="t3d-fab"
          style={{ top: 14, left: 14 }}
          title="Menú principal"
          aria-label="Volver al menú principal"
          onClick={onExit}
        >
          <Ic size={18}>{icons.back}</Ic>
        </button>
      )}

      {!povUI && (
        <button
          className="t3d-fab"
          style={{ bottom: 16, left: 16 }}
          title="Vista de cabina (top)"
          aria-label="Volver a la vista cenital"
          onClick={() => T.current && T.current.goHome()}
        >
          <Ic size={18}>{icons.home}</Ic>
        </button>
      )}

      {/* minimapa 2D: en móvil se pliega en un botón para no tapar la escena */}
      {isNarrow && !panelOpen && (
        <button
          ref={miniBtnRef}
          className="t3d-fab"
          style={{ bottom: 16, left: povUI ? 16 : 68 }}
          title={miniOpen ? 'Ocultar plano' : 'Plano de asientos'}
          aria-label={miniOpen ? 'Ocultar plano de asientos' : 'Mostrar plano de asientos'}
          aria-expanded={miniOpen}
          onClick={() => setMiniOpen((o) => !o)}
        >
          <Ic size={18}>{miniOpen ? icons.x : icons.map}</Ic>
        </button>
      )}
      <canvas
        ref={minimapRef}
        onClick={onMinimapClick}
        role="img"
        aria-label="Plano de asientos: toca un asiento para marcarlo"
        style={{
          ...ui.minimap,
          ...(isNarrow ? { left: 16, bottom: 68 } : null),
          display: isNarrow && (panelOpen || !miniOpen) ? 'none' : 'block',
        }}
      />

      {!povUI && (
        <button
          className={`t3d-fab${panelOpen ? ' is-hidden' : ''}`}
          style={{ top: 14, right: 14 }}
          aria-label="Abrir panel de configuración"
          aria-hidden={panelOpen}
          tabIndex={panelOpen ? -1 : 0}
          onClick={() => setPanelOpen(true)}
        >
          <Ic size={18}>{icons.menu}</Ic>
        </button>
      )}

      {/* barra de modos: la acción principal sobre la escena, siempre a mano */}
      <ToolBar
        label="Acción al tocar un asiento"
        hidden={povUI || (isNarrow && panelOpen)}
        offsetX={panelOpen && !isNarrow ? PANEL_OFFSET : 0}
        items={[
          { key: 'sel', label: 'Seleccionar', icon: icons.check, active: mode === 'sel', shortcut: '1', onClick: () => setMode('sel') },
          { key: 'block', label: 'Bloquear', icon: icons.ban, active: mode === 'block', shortcut: '2', onClick: () => setMode('block') },
          { key: 'clear', label: 'Normal', icon: icons.eraser, active: mode === 'clear', shortcut: '3', onClick: () => setMode('clear') },
          { sep: true },
          { key: 'pov', label: 'Ver desde el asiento', icon: icons.eye, active: mode === 'pov', shortcut: 'V', onClick: () => setMode(mode === 'pov' ? 'sel' : 'pov') },
        ]}
      />

      {toast}

      {/* panel lateral estilo Apple, organizado por tareas */}
      <Panel
        open={panelOpen}
        sheet={isNarrow}
        accent="#409cff"
        label="Configuración de la cabina"
        onClose={() => setPanelOpen(false)}
        top={
          <>
            <PanelHeader
              title={`Cabina ${model.label}`}
              subtitle="Flota low-cost · zonas Space"
              onClose={() => setPanelOpen(false)}
              actions={[
                { label: 'Deshacer', icon: icons.undo, onClick: undo, disabled: !hist.u, shortcut: '⌘Z' },
                { label: 'Rehacer', icon: icons.redo, onClick: redo, disabled: !hist.r, shortcut: '⇧⌘Z' },
              ]}
            />
            <div className="t3d-summary">
              <Stats
                items={[
                  { label: 'Libres', value: libres, color: STATE_COLORS.free },
                  { label: 'Selecc.', value: counts.sel, color: STATE_COLORS.sel },
                  { label: 'Bloq.', value: counts.blocked, color: STATE_COLORS.blocked },
                  { label: 'Vendidos', value: counts.sold, color: STATE_COLORS.sold },
                ]}
              />
            </div>
            <Tabs
              value={uiPref.tab}
              onChange={setTab}
              tabs={[
                { value: 'venta', label: 'Venta' },
                { value: 'cabina', label: 'Cabina' },
                { value: 'mas', label: 'Más' },
              ]}
            />
          </>
        }
      >
        {uiPref.tab === 'venta' && (
          <div className="t3d-tabpanel" key="venta">
            <Section
              label="Viajamos juntos"
              footnote={
                proposal && !proposal.keys.length
                  ? proposal.label
                  : 'Asientos contiguos en la misma fila, sin cruzar el pasillo.'
              }
            >
              <Row label="Pasajeros">
                <Stepper value={buyN} min={1} max={3} onChange={setBuyN} label="Número de pasajeros" />
              </Row>
              <div className="t3d-row">
                <div style={{ flex: 1 }}>
                  <Segmented
                    label="Criterio"
                    value={buyPref}
                    onChange={setBuyPref}
                    options={[
                      { value: 'best', label: 'Mejores asientos' },
                      { value: 'cheap', label: 'Sin coste' },
                    ]}
                  />
                </div>
              </div>
              <RowButton onClick={proposeSeats}>
                <Ic>{icons.ticket}</Ic>
                Sugerir asientos
              </RowButton>
            </Section>
            {proposal && proposal.keys.length > 0 && (
              <ProposalCard
                title={proposal.label}
                detail={`${proposal.keys.length} ${proposal.keys.length === 1 ? 'pasajero' : 'pasajeros'}`}
                total={proposal.total}
                onConfirm={confirmProposal}
                onCancel={clearProposal}
              />
            )}

            <Section label="Ingresos">
              <Row label="Selección de asiento" detail={fmtEUR(revenue)} strong />
              <Row label="Avión lleno" detail={fmtEUR(potential)} />
            </Section>

            <Section
              label="Precios por zona"
              footnote="Regular va incluido en la tarifa. Sin fila 13, como en los aviones reales."
            >
              {[
                ['one', 'Space One'],
                ['plus', 'Space Plus'],
                ['space', 'Space · salida'],
                ['front', 'Delanteros y traseros'],
              ].map(([zc, label]) => (
                <NumberRow
                  key={zc}
                  label={label}
                  dot={ZONE_COLORS[zc]}
                  value={prices[zc]}
                  onChange={(v) => setPrices((p) => ({ ...p, [zc]: v }))}
                />
              ))}
            </Section>
          </div>
        )}

        {uiPref.tab === 'cabina' && (
          <div className="t3d-tabpanel" key="cabina">
            <Section label="Avión" plain footnote="Cada modelo guarda sus propias selecciones y ventas.">
              <Segmented
                label="Modelo de avión"
                value={params.aircraft}
                onChange={(id2) => setParams((p) => ({ ...p, aircraft: id2 }))}
                options={Object.entries(AIRCRAFT).map(([id2, m2]) => ({ value: id2, label: m2.label }))}
              />
            </Section>
            <Section label="Distribución">
              <SliderRow
                label="Pitch base"
                value={params.pitch}
                unit=" m"
                min={0.71}
                max={0.92}
                step={0.01}
                onChange={(v) => setParams((p) => ({ ...p, pitch: v }))}
              />
            </Section>
            <Section label="Simulación" footnote="Marca asientos como vendidos al azar para ver el avión con pasaje.">
              <SliderRow
                label="Ocupación"
                value={params.occupancy}
                unit="%"
                min={0}
                max={100}
                step={1}
                onChange={(v) => setParams((p) => ({ ...p, occupancy: v }))}
              />
            </Section>
          </div>
        )}

        {uiPref.tab === 'mas' && (
          <div className="t3d-tabpanel" key="mas">
            <Section label="Visualización" plain>
              <div className="t3d-tiles">
                <Tile icon={icons.wing} label="¿Me toca ala?" active={wingView} onClick={() => setWingView((v) => !v)} />
                <Tile icon={icons.trash} label="Restablecer" onClick={resetAll} />
              </div>
            </Section>
            <Section
              label="Atajos de teclado"
              footnote="Arrastra para orbitar, rueda o pellizco para el zoom. La vista superior es tu plano de asientos; arrastra sobre ellos para marcar varios."
            >
              <Row label="Seleccionar · Bloquear · Normal"><span className="t3d-kbd">1</span><span className="t3d-kbd">2</span><span className="t3d-kbd">3</span></Row>
              <Row label="Ver desde el asiento"><span className="t3d-kbd">V</span></Row>
              <Row label="Vista de cabina"><span className="t3d-kbd">H</span></Row>
              <Row label="Mostrar u ocultar el panel"><span className="t3d-kbd">M</span></Row>
              <Row label="Deshacer · Rehacer"><span className="t3d-kbd">⌘Z</span><span className="t3d-kbd">⇧⌘Z</span></Row>
              <Row label="Cerrar · salir de la vista"><span className="t3d-kbd">Esc</span></Row>
            </Section>
          </div>
        )}
      </Panel>
    </div>
  );
}

// ----------------------------------------------------------------------------
// estilos (drawer glassmorphism, acento azul #3b82f6)
// ----------------------------------------------------------------------------
const ui = {
  minimap: {
    position: 'absolute',
    bottom: 16,
    left: 72,
    borderRadius: 14,
    border: '0.5px solid rgba(255,255,255,.16)',
    background: 'rgba(30,30,32,.5)',
    backdropFilter: 'blur(30px) saturate(180%)',
    WebkitBackdropFilter: 'blur(30px) saturate(180%)',
    cursor: 'pointer',
    boxShadow: '0 10px 40px rgba(0,0,0,.35)',
  },
  // franja inferior para el aviso: centrada, pero sin pisar el minimapa
  povHintWrap: ({ right, above }) => {
    // si a la derecha del minimapa no caben ~240px, el aviso sube por encima
    const stack = right && typeof window !== 'undefined' && window.innerWidth - right < 240;
    return {
      position: 'absolute',
      bottom: stack ? above + 10 : 22,
      left: stack ? 16 : `max(${right + 14}px, calc(50% - 280px))`,
      right: stack ? 16 : 'max(16px, calc(50% - 280px))',
      display: 'flex',
      justifyContent: 'center',
      pointerEvents: 'none',
    };
  },
  povHint: {
    WebkitBackdropFilter: 'blur(30px) saturate(180%)',
    background: 'rgba(30,30,32,.62)',
    backdropFilter: 'blur(30px) saturate(180%)',
    border: '1px solid rgba(255,255,255,.2)',
    borderRadius: 18,
    padding: '8px 18px',
    color: '#fff',
    fontSize: 12.5,
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif",
    textAlign: 'center',
    lineHeight: 1.4,
  },
  backBtn: {
    position: 'absolute',
    top: 14,
    left: '50%',
    transform: 'translateX(-50%)',
    padding: '11px 22px',
    borderRadius: 999,
    border: '1px solid rgba(59,130,246,.7)',
    background: 'rgba(37,99,235,.92)',
    color: '#fff',
    fontSize: 14,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif",
    boxShadow: '0 8px 30px rgba(0,0,0,.35)',
    display: 'flex',
    whiteSpace: 'nowrap',
    alignItems: 'center',
  },
  tip: {
    position: 'absolute',
    display: 'none',
    pointerEvents: 'none',
    background: 'rgba(30,30,32,.62)',
    border: '1px solid rgba(59,130,246,.5)',
    borderRadius: 8,
    padding: '5px 10px',
    color: '#e8e6ec',
    fontSize: 12,
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif",
    whiteSpace: 'nowrap',
    zIndex: 10,
  },
  markerLabel: {
    position: 'absolute',
    display: 'none',
    transform: 'translate(-50%, -115%)',
    pointerEvents: 'none',
    background: 'rgba(6,26,18,.92)',
    border: '1px solid rgba(52,211,153,.6)',
    borderRadius: 999,
    padding: '6px 14px',
    color: '#a7f3d0',
    fontSize: 12.5,
    fontWeight: 600,
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif",
    whiteSpace: 'nowrap',
    zIndex: 9,
  },
};
