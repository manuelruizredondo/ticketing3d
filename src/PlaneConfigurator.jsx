import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import * as THREE from 'three';
import { BufferGeometryUtils } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

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

const R_FUS = 2.4;
const YC = 1.35;
const WIN_Y = 1.55;
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

const easeInOutCubic = (t) =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

const hash01 = (str) => {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return (h >>> 8) / 16777216;
};

const DEFAULT_PARAMS = { aircraft: 'a320', pitch: 0.78, occupancy: 0 };
const DEFAULT_PRICES = { one: 30, plus: 20, space: 15, front: 8 };

// iconos outline
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
  wing: (
    <path d="M17.8 19.2L16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z" />
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
  ticket: (
    <>
      <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.83z" />
      <line x1="7" y1="7" x2="7.01" y2="7" />
    </>
  ),
};

export default function PlaneConfigurator({ onExit }) {
  const mountRef = useRef(null);
  const tipRef = useRef(null);
  const markerLabelRef = useRef(null);
  const minimapRef = useRef(null);
  const T = useRef(null);
  const seatStates = useRef(new Map());
  const modeRef = useRef('sel');
  const wingViewRef = useRef(false);

  const [params, setParams] = useState(DEFAULT_PARAMS);
  const [prices, setPrices] = useState(DEFAULT_PRICES);
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
  const [isNarrow, setIsNarrow] = useState(false);

  modeRef.current = mode;

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
    renderer.toneMappingExposure = 1.05;
    mount.appendChild(renderer.domElement);
    renderer.domElement.style.touchAction = 'none';

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x9ec7ea);
    scene.fog = new THREE.Fog(0xbcd9f0, 60, 220);

    const camera = new THREE.PerspectiveCamera(
      55, mount.clientWidth / mount.clientHeight, 0.1, 400
    );

    scene.add(new THREE.HemisphereLight(0xcfe4ff, 0x9a917f, 0.95));
    const sun = new THREE.DirectionalLight(0xfff2dd, 0.75);
    sun.position.set(30, 40, 10);
    scene.add(sun);
    scene.add(new THREE.AmbientLight(0xffffff, 0.25));

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
    for (const cx of [270, 754]) {
      wctx.beginPath();
      wctx.ellipse(cx, 256, 12, 100, 0, 0, Math.PI * 2);
      wctx.fill();
      wctx.fill();
    }
    const winAlpha = new THREE.CanvasTexture(winCv);
    winAlpha.wrapS = winAlpha.wrapT = THREE.RepeatWrapping;

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

    // ---- materiales -----------------------------------------------------------
    const mkStd = (opts) => new THREE.MeshStandardMaterial(opts);
    const mats = {
      liner: mkStd({
        color: 0xe4e8ee, roughness: 0.92, side: THREE.BackSide,
        alphaMap: winAlpha, alphaTest: 0.5,
      }),
      glass: new THREE.MeshBasicMaterial({
        color: 0xcfe6fa, transparent: true, opacity: 0.16, depthWrite: false,
      }),
      floor: mkStd({ color: 0x9aa0ab, roughness: 0.95 }), // moqueta clara
      aisle: mkStd({ color: 0x4a5160, roughness: 0.95 }),
      bin: mkStd({ color: 0xdadfe6, roughness: 0.85 }),
      bulkhead: mkStd({ color: 0xd6dbe2, roughness: 0.9 }),
      lightStrip: mkStd({ color: 0xf5f2ea, emissive: 0xfff3df, emissiveIntensity: 0.9 }),
      seat: mkStd({ color: 0x3a4356, roughness: 0.9 }), // tapizado gris oscuro
      metal: mkStd({ color: 0x9aa0a8, metalness: 0.8, roughness: 0.4 }),
      selMark: mkStd({ color: 0x1f9d55, emissive: 0x2f9e44, emissiveIntensity: 0.25, roughness: 0.85 }),
      blocked: mkStd({ color: 0x8b919c, roughness: 0.95 }),
      sold: mkStd({ color: 0x23262e, roughness: 0.95 }),
      proposal: mkStd({ color: 0x1f9d55, emissive: 0x34d399, emissiveIntensity: 0.5, roughness: 0.8 }),
      wing: mkStd({ color: 0xc9ced6, metalness: 0.55, roughness: 0.35, side: THREE.DoubleSide }),
      engine: mkStd({ color: 0xb8bec7, metalness: 0.6, roughness: 0.35 }),
      intake: mkStd({ color: 0x1c1f26, roughness: 0.6 }),
      exit: new THREE.MeshBasicMaterial({ map: exitTex, toneMapped: false }),
      heat: [
        mkStd({ color: 0x2f9e44, emissive: 0x2f9e44, emissiveIntensity: 0.3, roughness: 0.85 }),
        mkStd({ color: 0xe8a013, emissive: 0xe8a013, emissiveIntensity: 0.3, roughness: 0.85 }),
        mkStd({ color: 0xd9480f, emissive: 0xd9480f, emissiveIntensity: 0.3, roughness: 0.85 }),
      ],
      cloud: new THREE.SpriteMaterial({ map: cloudTex, opacity: 0.9, depthWrite: false }),
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
      for (const s of [-1, 1]) {
        add(unitBox, mats.seat, s * (w / 2 + 0.03), 0.44, 0.06, 0.06, 0.05, 0.4, 'swap');
      }
      return bakeTemplate(g);
    };

    T.current = {
      renderer, scene, camera, mats, unitBox, unitPlane, sun, clouds, winAlpha,
      seatTemplate: buildSeat(),
      seatsGroup: null, cabinGroup: null,
      seatList: [],
      seatByKey: new Map(),
      rowMeta: new Map(),
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
          ? new THREE.Vector3(Math.sign(p.x) * 9, WIN_Y - 0.9, p.z - 0.6)
          : new THREE.Vector3(p.x * 0.3, 1.3, p.z - 8);
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

    const onResize = () => {
      camera.aspect = mount.clientWidth / mount.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(mount.clientWidth, mount.clientHeight);
    };
    window.addEventListener('resize', onResize);

    // ---- bucle ----------------------------------------------------------------
    const animate = () => {
      const t = T.current;
      const now = performance.now();

      for (const c of clouds) {
        c.position.z += 0.028;
        if (c.position.z > t.cabin.zEnd + 60) c.position.z -= 150;
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
      renderer.dispose();
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
    const cssW = 230;
    const pad = 12;
    const len = t.cabin.zEnd - Z_FRONT;
    const scale = (cssW - pad * 2) / len;
    const cssH = 3.96 * scale + pad * 2 + 8;
    const dpr = 2;
    cv.width = cssW * dpr;
    cv.height = cssH * dpr;
    cv.style.width = `${cssW}px`;
    cv.style.height = `${cssH}px`;
    const ctx = cv.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, cssW, cssH);
    const zx = (z) => pad + (z - Z_FRONT) * scale;
    const xy = (x) => cssH / 2 + x * scale;
    ctx.strokeStyle = 'rgba(255,255,255,.4)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(zx(Z_FRONT), cssH / 2 - 1.98 * scale);
    ctx.lineTo(zx(t.cabin.zEnd), cssH / 2 - 1.98 * scale);
    ctx.moveTo(zx(Z_FRONT), cssH / 2 + 1.98 * scale);
    ctx.lineTo(zx(t.cabin.zEnd), cssH / 2 + 1.98 * scale);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(zx(Z_FRONT), cssH / 2 - 1.98 * scale);
    ctx.quadraticCurveTo(zx(Z_FRONT) - 14, cssH / 2, zx(Z_FRONT), cssH / 2 + 1.98 * scale);
    ctx.stroke();
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
      } else if (st === 'blocked') c = '#565b66';
      else if (t.proposal.has(s.key)) c = '#34d399';
      else if (t.soldSet.has(s.key) || t.occupiedSet.has(s.key)) c = '#454a54';
      else if (st === 'sel') c = '#4ade80';
      ctx.fillStyle = c;
      ctx.fillRect(zx(s.pz) - dot / 2, xy(s.px) - dot / 2, dot, dot);
    }
    t.miniMap = { scale, pad, cssH };
  }, []);

  const onMinimapClick = useCallback((e) => {
    const t = T.current;
    const cv = minimapRef.current;
    if (!t || !cv || !t.miniMap) return;
    const rect = cv.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const { scale, pad, cssH } = t.miniMap;
    let best = null;
    let bestD = 9e9;
    for (const s of t.seatList) {
      const x = pad + (s.pz - Z_FRONT) * scale;
      const y = cssH / 2 + s.px * scale;
      const d = Math.hypot(x - cx, y - cy);
      if (d < bestD) { bestD = d; best = s; }
    }
    if (!best || bestD > 9) return;
    const seat = t.seatByKey.get(best.key);
    if (!seat) return;
    if (modeRef.current === 'pov' || t.pov.active) t.enterPovAt(seat);
    else t.applyModeTo(seat);
  }, []);

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

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 640px)');
    const on = () => setIsNarrow(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);

  // --------------------------------------------------------------------------
  // Regeneración de la cabina
  // --------------------------------------------------------------------------
  useEffect(() => {
    const t = T.current;
    if (!t) return;
    const { scene, mats, unitBox, unitPlane } = t;
    const { aircraft, pitch, occupancy } = params;
    const model = AIRCRAFT[aircraft] || AIRCRAFT.a320;

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

    // ---- filas ----------------------------------------------------------------
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
    seatsGroup.traverse((o) => (o.matrixAutoUpdate = false));

    // ---- cabina ---------------------------------------------------------------
    const mkGeo = (g) => { t.disposables.push(g); return g; };

    const fusGeo = mkGeo(new THREE.CylinderGeometry(R_FUS, R_FUS, len, 48, 1, true));
    fusGeo.rotateX(Math.PI / 2);
    t.winAlpha.repeat.set(1, len / WIN_EVERY);
    const fus = new THREE.Mesh(fusGeo, mats.liner);
    fus.position.set(0, YC, Z_FRONT + len / 2);
    cabinGroup.add(fus);

    for (const sx of [-1, 1]) {
      const strip = new THREE.Mesh(unitPlane, mats.glass);
      strip.scale.set(len, 0.55, 1);
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

    const bhGeoF = mkGeo(new THREE.CircleGeometry(R_FUS, 40));
    const bhF = new THREE.Mesh(bhGeoF, mats.bulkhead);
    bhF.position.set(0, YC, Z_FRONT);
    cabinGroup.add(bhF);
    const bhGeoB = mkGeo(new THREE.CircleGeometry(R_FUS, 40));
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

    // ala trapezoidal en flecha que nace del fuselaje (la raíz queda dentro
    // del tubo, así el encuentro ala-fuselaje se ve continuo)
    const wingShape = new THREE.Shape();
    wingShape.moveTo(0, -1.8); // raíz, borde de ataque
    wingShape.lineTo(10.5, 1.4); // punta, borde de ataque (flecha ~31°)
    wingShape.lineTo(10.5, 2.5); // punta, borde de fuga
    wingShape.lineTo(0, 2.0); // raíz, borde de fuga
    wingShape.closePath();
    const wingGeo = mkGeo(
      new THREE.ExtrudeGeometry(wingShape, { depth: 0.14, bevelEnabled: false })
    );
    wingGeo.rotateX(Math.PI / 2);
    for (const sx of [-1, 1]) {
      const wing = new THREE.Mesh(wingGeo, mats.wing);
      wing.scale.x = sx;
      // la raíz arranca justo en la pared del fuselaje: nada asoma dentro
      wing.position.set(sx * 2.35, 0.75, wingC);
      wing.rotation.z = sx * 0.05; // diedro sutil hacia arriba
      cabinGroup.add(wing);
      // motor colgado bajo el ala, con pilón y entrada oscura
      const engGeo = mkGeo(new THREE.CylinderGeometry(0.7, 0.62, 2.3, 20));
      engGeo.rotateX(Math.PI / 2);
      const eng = new THREE.Mesh(engGeo, mats.engine);
      eng.position.set(sx * 4.6, 0.38, wingC - 1.1);
      cabinGroup.add(eng);
      const intGeo = mkGeo(new THREE.CircleGeometry(0.62, 24));
      const intake = new THREE.Mesh(intGeo, mats.intake);
      intake.rotation.y = Math.PI;
      intake.position.set(sx * 4.6, 0.38, wingC - 2.26);
      cabinGroup.add(intake);
      const pylon = new THREE.Mesh(unitBox, mats.engine);
      pylon.scale.set(0.16, 0.5, 1.3);
      pylon.position.set(sx * 4.6, 0.85, wingC - 0.5);
      cabinGroup.add(pylon);
    }

    t.homeView.theta = 0;
    t.homeView.phi = 0.14;
    t.homeView.radius = Math.min(60, Math.max(14, len * 1.02));
    t.homeView.target.set(0, 0.6, Z_FRONT + len / 2);

    recount();
  }, [params, applySeatState, recount]);

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
    for (const k of proposal.keys) t.soldSet.add(k);
    t.proposal = new Set();
    t.markerKeys = [];
    for (const k of proposal.keys) {
      const seat = t.seatByKey.get(k);
      if (seat) applySeatState(seat);
    }
    setProposal(null);
    recount();
  }, [proposal, applySeatState, recount]);

  // --------------------------------------------------------------------------
  // UI
  // --------------------------------------------------------------------------
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

  const priceInput = (zc, label) => (
    <label style={ui.priceLbl} key={zc}>
      <span>
        <span style={{ ...ui.zoneDot, background: ZONE_COLORS[zc] }} />
        {label}
      </span>
      <input
        type="number" min="0" step="1" value={prices[zc]}
        onChange={(e) =>
          setPrices((p) => ({ ...p, [zc]: Number(e.target.value) || 0 }))
        }
        style={ui.priceInput}
      />
    </label>
  );

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

  const model = AIRCRAFT[params.aircraft] || AIRCRAFT.a320;

  return (
    <div style={{ position: 'fixed', inset: 0, userSelect: 'none' }}>
      <div ref={mountRef} style={{ position: 'absolute', inset: 0 }} />

      <div ref={tipRef} style={ui.tip} />
      <div ref={markerLabelRef} style={ui.markerLabel} />

      {povUI && (
        <div style={ui.povHint}>
          Vista desde el asiento — arrastra para mirar (¡busca el ala!) · toca
          otro asiento para saltar
        </div>
      )}

      {povUI && (
        <button style={ui.backBtn} onClick={() => T.current && T.current.goHome()}>
          <Ic style={{ marginRight: 7 }}>{icons.back}</Ic>
          Volver al plano de cabina
        </button>
      )}

      {!povUI && onExit && (
        <button style={ui.exitBtn} title="Menú principal" onClick={onExit}>
          <Ic size={18}>{icons.back}</Ic>
        </button>
      )}

      {!povUI && (
        <button
          style={ui.homeBtn}
          title="Vista de cabina (top)"
          onClick={() => T.current && T.current.goHome()}
        >
          <Ic size={19}>{icons.home}</Ic>
        </button>
      )}

      <canvas
        ref={minimapRef}
        onClick={onMinimapClick}
        style={{
          ...ui.minimap,
          display: isNarrow && panelOpen ? 'none' : 'block',
        }}
      />

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

      <div style={panelStyle}>
        <div>
          <div style={ui.panelHead}>
            <strong style={{ letterSpacing: '.5px' }}>
              TICKETING<span style={{ color: '#3b82f6' }}>3D</span> · Cabina{' '}
              {model.label}
            </strong>
            <button style={ui.closeBtn} onClick={() => setPanelOpen(false)}>
              <Ic size={17}>{icons.x}</Ic>
            </button>
          </div>

          {/* selector de avión de la flota */}
          <div style={ui.fleetRow}>
            {Object.entries(AIRCRAFT).map(([id2, m2]) => (
              <button
                key={id2}
                onClick={() => setParams((p) => ({ ...p, aircraft: id2 }))}
                style={{
                  ...ui.fleetBtn,
                  background:
                    params.aircraft === id2 ? '#1d4ed8' : 'rgba(255,255,255,.06)',
                  borderColor:
                    params.aircraft === id2 ? '#1d4ed8' : 'rgba(255,255,255,.15)',
                  color: params.aircraft === id2 ? '#fff' : '#c9c6cf',
                }}
              >
                {m2.label}
              </button>
            ))}
          </div>

          <div style={ui.counters}>
            <div style={ui.counter}>
              <div style={{ ...ui.counterNum, color: '#7ce38b' }}>{libres}</div>
              <div style={ui.counterLbl}>Libres</div>
            </div>
            <div style={ui.counter}>
              <div style={{ ...ui.counterNum, color: '#4ade80' }}>{counts.sel}</div>
              <div style={ui.counterLbl}>Selecc.</div>
            </div>
            <div style={ui.counter}>
              <div style={{ ...ui.counterNum, color: '#9a95a3' }}>{counts.blocked}</div>
              <div style={ui.counterLbl}>Bloq.</div>
            </div>
            <div style={ui.counter}>
              <div style={{ ...ui.counterNum, color: '#c9a145' }}>{counts.sold}</div>
              <div style={ui.counterLbl}>Vendidos</div>
            </div>
          </div>

          <div style={ui.revenue}>
            <span>
              Ingresos asientos:{' '}
              <b style={{ color: '#7ce38b' }}>{revenue.toFixed(2)} €</b>
            </span>
            <span style={{ opacity: 0.6 }}>
              potencial {potential.toFixed(0)} €
            </span>
          </div>

          {/* precios por zona tarifaria */}
          <div style={ui.priceGrid}>
            {priceInput('one', 'Space One')}
            {priceInput('plus', 'Space Plus')}
            {priceInput('space', 'Space (salida)')}
            {priceInput('front', 'Delant./tras.')}
          </div>
          <div style={ui.zoneNote}>
            <span style={{ ...ui.zoneDot, background: ZONE_COLORS.regular }} />
            Regular: incluido en la tarifa · sin fila 13, como en los aviones
            reales
          </div>

          <div style={ui.buyBox}>
            <div style={ui.buyHead}>
              <Ic style={{ marginRight: 6 }}>{icons.ticket}</Ic>
              Viajamos juntos
            </div>
            <div style={ui.buyRow}>
              <input
                type="number" min="1" max="3" value={buyN}
                onChange={(e) =>
                  setBuyN(Math.max(1, Math.min(3, Number(e.target.value) || 1)))
                }
                style={ui.buyInput}
              />
              <select
                value={buyPref}
                onChange={(e) => setBuyPref(e.target.value)}
                style={ui.buySelect}
              >
                <option value="best">Mejores asientos</option>
                <option value="cheap">Sin coste (Regular)</option>
              </select>
              <button onClick={proposeSeats} style={ui.buyBtn}>
                Sugerir
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

          <div style={ui.row}>
            <div style={ui.rowTop}>
              <span>Pitch base</span>
              <span style={ui.value}>{params.pitch} m</span>
            </div>
            <input
              type="range" min="0.71" max="0.92" step="0.01"
              value={params.pitch}
              onChange={(e) =>
                setParams((p) => ({ ...p, pitch: Number(e.target.value) }))
              }
              style={ui.range}
            />
          </div>
          <div style={ui.row}>
            <div style={ui.rowTop}>
              <span>Ocupación simulada</span>
              <span style={ui.value}>{params.occupancy}%</span>
            </div>
            <input
              type="range" min="0" max="100" step="1"
              value={params.occupancy}
              onChange={(e) =>
                setParams((p) => ({ ...p, occupancy: Number(e.target.value) }))
              }
              style={ui.range}
            />
          </div>

          <div style={ui.modesLbl}>
            Al tocar un asiento (arrastra para pintar varios):
          </div>
          <div style={ui.modes}>
            {modeBtn('sel', 'Seleccionar', '#1f9d55')}
            {modeBtn('block', 'Bloquear', '#4d4956')}
            {modeBtn('clear', 'Normal', '#4a5568')}
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
            Ver desde el asiento
          </button>
          <button
            onClick={() => setWingView((v) => !v)}
            style={{
              ...ui.povBtn,
              background: wingView ? '#7048e8' : 'rgba(255,255,255,.06)',
              borderColor: wingView ? '#7048e8' : 'rgba(255,255,255,.15)',
            }}
          >
            <Ic style={{ marginRight: 7 }}>{icons.wing}</Ic>
            ¿Me toca ala? — calidad de ventanilla
          </button>

          <div style={ui.help}>
            Arrastra para orbitar · rueda/pellizco para zoom · el fuselaje se ve
            por dentro: la vista superior es tu plano de asientos
          </div>
        </div>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------
// estilos (drawer glassmorphism, acento azul #3b82f6)
// ----------------------------------------------------------------------------
const ui = {
  panel: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    width: 'min(340px, calc(100vw - 20px))',
    overflowY: 'auto',
    background: 'rgba(13,17,28,.82)',
    backdropFilter: 'blur(16px)',
    WebkitBackdropFilter: 'blur(16px)',
    borderLeft: '1px solid rgba(255,255,255,.12)',
    padding: '16px 16px 14px',
    color: '#e8e6ec',
    fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif",
    fontSize: 13,
    boxShadow: '-12px 0 44px rgba(0,0,0,.4)',
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
    borderTop: '1px solid rgba(255,255,255,.12)',
    borderRadius: '16px 16px 0 0',
    boxShadow: '0 -12px 44px rgba(0,0,0,.4)',
  },
  panelHead: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
    fontSize: 13.5,
  },
  closeBtn: { background: 'none', border: 'none', color: '#9a95a3', cursor: 'pointer', padding: 4 },
  fleetRow: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 7, marginBottom: 10 },
  fleetBtn: {
    padding: '9px 4px',
    borderRadius: 9,
    border: '1px solid',
    cursor: 'pointer',
    fontSize: 12.5,
    fontWeight: 700,
  },
  counters: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 6, marginBottom: 10 },
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
  priceGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 7, marginBottom: 6 },
  priceLbl: { fontSize: 11, opacity: 0.9, display: 'flex', flexDirection: 'column', gap: 4 },
  priceInput: {
    width: '100%',
    padding: '6px 8px',
    borderRadius: 8,
    border: '1px solid rgba(255,255,255,.15)',
    background: 'rgba(255,255,255,.06)',
    color: '#e8e6ec',
    fontSize: 13,
  },
  zoneDot: {
    display: 'inline-block',
    width: 9,
    height: 9,
    borderRadius: '50%',
    marginRight: 6,
    verticalAlign: '-1px',
  },
  zoneNote: { fontSize: 10.5, opacity: 0.6, marginBottom: 10, lineHeight: 1.5 },
  buyBox: {
    border: '1px solid rgba(59,130,246,.4)',
    borderRadius: 10,
    padding: '10px 10px 9px',
    marginBottom: 12,
    background: 'rgba(59,130,246,.07)',
  },
  buyHead: { fontSize: 12.5, fontWeight: 600, marginBottom: 8 },
  buyRow: { display: 'flex', gap: 7 },
  buyInput: {
    width: 46,
    padding: '7px 6px',
    borderRadius: 8,
    border: '1px solid rgba(255,255,255,.15)',
    background: 'rgba(255,255,255,.06)',
    color: '#e8e6ec',
    fontSize: 13,
    textAlign: 'center',
  },
  buySelect: {
    flex: 1,
    padding: '7px 6px',
    borderRadius: 8,
    border: '1px solid rgba(255,255,255,.15)',
    background: 'rgba(20,26,40,.9)',
    color: '#e8e6ec',
    fontSize: 12.5,
  },
  buyBtn: {
    padding: '8px 12px',
    borderRadius: 8,
    border: '1px solid rgba(59,130,246,.55)',
    background: 'rgba(59,130,246,.18)',
    color: '#bfdbfe',
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
  rowTop: { display: 'flex', justifyContent: 'space-between', marginBottom: 3, opacity: 0.9 },
  value: { color: '#93c5fd', fontVariantNumeric: 'tabular-nums' },
  range: { width: '100%', accentColor: '#3b82f6', margin: 0 },
  modesLbl: { fontSize: 11, opacity: 0.65, marginBottom: 6, lineHeight: 1.45 },
  modes: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 7, marginBottom: 8 },
  modeBtn: {
    padding: '10px 4px',
    borderRadius: 9,
    border: '1px solid',
    cursor: 'pointer',
    fontSize: 12,
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
    border: '1px solid rgba(255,255,255,.25)',
    background: 'rgba(13,17,28,.6)',
    backdropFilter: 'blur(14px)',
    WebkitBackdropFilter: 'blur(14px)',
    color: '#fff',
    cursor: 'pointer',
    boxShadow: '0 10px 40px rgba(0,0,0,.35)',
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
    border: '1px solid rgba(255,255,255,.25)',
    background: 'rgba(13,17,28,.6)',
    backdropFilter: 'blur(14px)',
    WebkitBackdropFilter: 'blur(14px)',
    color: '#fff',
    cursor: 'pointer',
    boxShadow: '0 10px 40px rgba(0,0,0,.35)',
  },
  exitBtn: {
    position: 'absolute',
    top: 14,
    left: 14,
    width: 44,
    height: 44,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    border: '1px solid rgba(255,255,255,.25)',
    background: 'rgba(13,17,28,.6)',
    backdropFilter: 'blur(14px)',
    WebkitBackdropFilter: 'blur(14px)',
    color: '#fff',
    cursor: 'pointer',
    boxShadow: '0 10px 40px rgba(0,0,0,.35)',
  },
  minimap: {
    position: 'absolute',
    bottom: 16,
    left: 72,
    borderRadius: 10,
    border: '1px solid rgba(255,255,255,.2)',
    background: 'rgba(13,17,28,.68)',
    backdropFilter: 'blur(10px)',
    WebkitBackdropFilter: 'blur(10px)',
    cursor: 'pointer',
    boxShadow: '0 10px 40px rgba(0,0,0,.35)',
  },
  povHint: {
    position: 'absolute',
    top: 12,
    left: '50%',
    transform: 'translateX(-50%)',
    background: 'rgba(13,17,28,.8)',
    backdropFilter: 'blur(10px)',
    border: '1px solid rgba(255,255,255,.2)',
    borderRadius: 999,
    padding: '8px 18px',
    color: '#fff',
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
    border: '1px solid rgba(59,130,246,.7)',
    background: 'rgba(37,99,235,.92)',
    color: '#fff',
    fontSize: 14,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'system-ui, sans-serif',
    boxShadow: '0 8px 30px rgba(0,0,0,.35)',
    display: 'flex',
    alignItems: 'center',
  },
  tip: {
    position: 'absolute',
    display: 'none',
    pointerEvents: 'none',
    background: 'rgba(13,17,28,.92)',
    border: '1px solid rgba(59,130,246,.5)',
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
    background: 'rgba(6,26,18,.92)',
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
