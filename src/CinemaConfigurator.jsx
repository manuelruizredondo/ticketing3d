import React, { useEffect, useRef, useState, useCallback } from 'react';
import * as THREE from 'three';
import { ColladaLoader } from 'three/examples/jsm/loaders/ColladaLoader.js';
import { BufferGeometryUtils } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// ============================================================================
// Configurador 3D de sala de cine — Cinemes Full HD (Centre Splau)
// Three.js r128 puro (sin OrbitControls, sin React Three Fiber).
// Assets originales del proyecto (en /public):
//   /Cine/butacavip/butacavip.dae (+ difuse/normal)  → butaca VIP
//   /images/texturagris.jpg, escaleras.jpg           → sala y graderío
//   /images/speaker_diff.JPG                          → altavoces K.C.S.
//   /images/maxima.JPG, minima.jpg                    → discos "IMMERSIÓ"
//   /images/pantalla2.jpg                             → logo del cine
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

export default function CinemaConfigurator() {
  const mountRef = useRef(null);
  const tipRef = useRef(null);
  const fileRef = useRef(null);
  const T = useRef(null); // todo el estado three.js
  const seatStates = useRef(new Map()); // "fila-asiento" -> 'vip' | 'blocked'
  const modeRef = useRef('vip');
  const heatRef = useRef(false);

  const [params, setParams] = useState(DEFAULT_PARAMS);
  const [mode, setMode] = useState('vip'); // 'vip' | 'block' | 'clear' | 'pov'
  const [panelOpen, setPanelOpen] = useState(true);
  const [povUI, setPovUI] = useState(false);
  const [heatOn, setHeatOn] = useState(false);
  const [muted, setMuted] = useState(true);
  const [counts, setCounts] = useState({ total: 0, vip: 0, blocked: 0, sold: 0 });
  const [vipDaeReady, setVipDaeReady] = useState(false);
  const [regenTick, setRegenTick] = useState(0);

  modeRef.current = mode;

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
    const texStairs = loadTex('/images/escaleras.jpg');
    const texLogo = loadTex('/images/pantalla2.jpg');
    const texLogoScreen = loadTex('/images/pantalla2.jpg');
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

    // ---- materiales compartidos ---------------------------------------------
    const mats = {
      std: new THREE.MeshStandardMaterial({ color: 0x4a4744, roughness: 0.92 }),
      vipMark: new THREE.MeshStandardMaterial({ color: 0xd8232a, roughness: 0.75 }),
      blocked: new THREE.MeshStandardMaterial({ color: 0x35323a, roughness: 0.95 }),
      sold: new THREE.MeshStandardMaterial({ color: 0x221d26, roughness: 0.95 }),
      metal: new THREE.MeshStandardMaterial({ color: 0x8a8d94, metalness: 0.85, roughness: 0.35 }),
      shell: new THREE.MeshStandardMaterial({ color: 0x17161a, roughness: 0.6 }),
      tray: new THREE.MeshStandardMaterial({ color: 0x111013, roughness: 0.5 }),
      floor: new THREE.MeshStandardMaterial({ map: texGrisFloor, color: 0x8f8f96, roughness: 0.98 }),
      wall: new THREE.MeshStandardMaterial({ map: texGrisWall, color: 0x77747e, roughness: 0.95 }),
      ceiling: new THREE.MeshStandardMaterial({ color: 0x0d0c10, roughness: 1 }),
      platform: new THREE.MeshStandardMaterial({ color: 0x232028, roughness: 0.9 }),
      stair: new THREE.MeshStandardMaterial({ map: texStairs, color: 0xbbbbbb, roughness: 0.9 }),
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
        color: 0x0a1a3a,
        emissive: 0x3b82f6,
        emissiveIntensity: 2.4,
      }),
      logo: new THREE.MeshBasicMaterial({ map: texLogo, toneMapped: false }),
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

    // ---- audio posicional del trailer (arranca al pulsar 🔊) ------------------
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
      seatList: [], // [{key, autoVip}]
      occupiedSet: new Set(),
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

    const flyTo = (toPos, toTgt, onDone) => {
      const t = T.current;
      t.flight = {
        t0: performance.now(),
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

    T.current.exitPov = () => {
      const t = T.current;
      if (t.flight || !t.pov.active) return;
      // volver siempre a la vista cenital que encuadra toda la sala
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
      else if (m === 'clear') seatStates.current.delete(key);
      applySeatState(seat);
      recount();
    };

    const applyModeToRow = (row) => {
      const t = T.current;
      const m = modeRef.current;
      for (const seat of t.seatsGroup.children) {
        if (seat.userData.row !== row) continue;
        const key = seat.userData.key;
        if (m === 'vip') seatStates.current.set(key, 'vip');
        else if (m === 'block') seatStates.current.set(key, 'blocked');
        else if (m === 'clear') seatStates.current.delete(key);
        applySeatState(seat);
      }
      recount();
    };

    // ---- interacción: puntero / táctil / rueda --------------------------------
    const el = renderer.domElement;
    const MARK_MODES = ['vip', 'block', 'clear'];

    const onPointerDown = (e) => {
      const t = T.current;
      hideTip();
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
          else if (t.occupiedSet.has(u.key)) extra = ' · Vendida';
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
        if (MARK_MODES.includes(modeRef.current)) applyModeToRow(res.sign);
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
        const k = Math.min(1, (now - t.flight.t0) / FLY_MS);
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

      renderer.render(scene, camera);
      t.raf = requestAnimationFrame(animate);
    };
    T.current.raf = requestAnimationFrame(animate);

    // ---- limpieza ---------------------------------------------------------------
    return () => {
      const t = T.current;
      cancelAnimationFrame(t.raf);
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
  // Prioridad: mapa de visión > bloqueada > vendida > VIP marcada > base
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
    else if (t.occupiedSet.has(key)) override = t.mats.sold;
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

  const recount = useCallback(() => {
    const t = T.current;
    if (!t) return;
    let vip = 0, blocked = 0, sold = 0;
    for (const s of t.seatList) {
      const st = seatStates.current.get(s.key);
      if (st === 'blocked') { blocked++; continue; }
      if (t.occupiedSet.has(s.key)) sold++;
      if (s.autoVip || st === 'vip') vip++;
    }
    setCounts({ total: t.seatList.length, vip, blocked, sold });
  }, []);

  // toggle del mapa de calidad de visión: solo cambia materiales
  useEffect(() => {
    heatRef.current = heatOn;
    const t = T.current;
    if (!t || !t.seatsGroup) return;
    for (const seat of t.seatsGroup.children) applySeatState(seat);
  }, [heatOn, applySeatState]);

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
          model: isVipRow ? (t.vipModel === 'dae' ? 'dae' : 'vipproc') : 'std',
        };
        seatsGroup.add(seat);
        t.seatList.push({ key, autoVip: isVipRow });
        if (hash01(key) < occupancy / 100) t.occupiedSet.add(key);
        applySeatState(seat);
      }
    }

    seatsGroup.updateMatrixWorld(true);
    seatsGroup.traverse((o) => (o.matrixAutoUpdate = false));

    // ---- sala (suelo, paredes, techo, discos, altavoces, logo) ----------------
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

    // discos "IMMERSIÓ" (asset original): disco negro + aro LED azul emisivo,
    // tamaños y alturas variadas como en la sala real
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

    // rótulo retroiluminado del cine en la pared trasera, con marco
    const logoFrame = new THREE.Mesh(unitBox, mats.speakerBox);
    logoFrame.scale.set(3.7, 3.7, 0.12);
    logoFrame.position.set(0, 5.6, zBack - 0.06);
    roomGroup.add(logoFrame);
    const logo = new THREE.Mesh(unitPlane, mats.logo);
    logo.scale.set(3.4, 3.4, 1);
    logo.rotation.y = Math.PI;
    logo.position.set(0, 5.6, zBack - 0.14);
    roomGroup.add(logo);

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
    const data = {
      app: 'ticketing3d',
      v: 2,
      params,
      states: [...seatStates.current.entries()],
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], {
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
        seatStates.current = new Map(data.states || []);
        setParams({ ...DEFAULT_PARAMS, ...data.params });
        setRegenTick((k) => k + 1);
      })
      .catch(() => {
        window.alert('El archivo no es una configuración de sala válida.');
      });
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

  return (
    <div style={{ position: 'fixed', inset: 0 }}>
      <div ref={mountRef} style={{ position: 'absolute', inset: 0 }} />

      {/* tooltip de butaca */}
      <div ref={tipRef} style={ui.tip} />

      {/* aviso superior en modo POV */}
      {povUI && (
        <div style={ui.povHint}>
          👁 Vista desde la butaca — arrastra para mirar · toca otra butaca para
          saltar a ella
        </div>
      )}

      {/* volver de POV */}
      {povUI && (
        <button style={ui.backBtn} onClick={() => T.current && T.current.exitPov()}>
          ← Volver a la vista general
        </button>
      )}

      {/* panel de configuración */}
      {panelOpen ? (
        <div style={ui.panel}>
          <div style={ui.panelHead}>
            <strong style={{ letterSpacing: '.5px' }}>
              CINEMES <span style={{ color: '#d8232a' }}>FULL HD</span> · Sala 3D
            </strong>
            <button style={ui.closeBtn} onClick={() => setPanelOpen(false)}>
              ✕
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
            👁 Ver desde la butaca
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
              🎯 Mapa de visión
            </button>
            <button onClick={toggleSound} style={ui.toolBtn}>
              {muted ? '🔇 Sonido' : '🔊 Silenciar'}
            </button>
          </div>
          <div style={ui.toolRow}>
            <button onClick={exportConfig} style={ui.toolBtn}>
              ⬇ Exportar
            </button>
            <button
              onClick={() => fileRef.current && fileRef.current.click()}
              style={ui.toolBtn}
            >
              ⬆ Importar
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              onChange={importConfig}
              style={{ display: 'none' }}
            />
          </div>

          <div style={ui.help}>
            Arrastra para orbitar · rueda/pellizco para zoom · toca una butaca
            para marcarla
          </div>
        </div>
      ) : (
        !povUI && (
          <button style={ui.openBtn} onClick={() => setPanelOpen(true)}>
            ⚙ Configurar sala
          </button>
        )
      )}
    </div>
  );
}

// ----------------------------------------------------------------------------
// estilos (panel flotante glassmorphism, acento rojo #d8232a)
// ----------------------------------------------------------------------------
const ui = {
  panel: {
    position: 'absolute',
    top: 12,
    right: 12,
    width: 'min(330px, calc(100vw - 24px))',
    maxHeight: 'calc(100vh - 24px)',
    overflowY: 'auto',
    background: 'rgba(16,14,20,.74)',
    backdropFilter: 'blur(14px)',
    WebkitBackdropFilter: 'blur(14px)',
    border: '1px solid rgba(216,35,42,.35)',
    borderRadius: 14,
    padding: '14px 16px 12px',
    color: '#e8e6ec',
    fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif",
    fontSize: 13,
    boxShadow: '0 10px 40px rgba(0,0,0,.55)',
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
    fontSize: 15,
    cursor: 'pointer',
    padding: 4,
  },
  counters: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr 1fr 1fr',
    gap: 6,
    marginBottom: 12,
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
    padding: '8px 4px',
    borderRadius: 9,
    border: '1px solid',
    cursor: 'pointer',
    fontSize: 12.5,
    fontWeight: 600,
    transition: 'all .15s',
  },
  povBtn: {
    width: '100%',
    padding: '9px 4px',
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
    padding: '8px 4px',
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
  openBtn: {
    position: 'absolute',
    top: 12,
    right: 12,
    padding: '10px 16px',
    borderRadius: 12,
    border: '1px solid rgba(216,35,42,.5)',
    background: 'rgba(16,14,20,.74)',
    backdropFilter: 'blur(14px)',
    color: '#e8e6ec',
    fontSize: 13.5,
    fontWeight: 600,
    cursor: 'pointer',
    boxShadow: '0 10px 40px rgba(0,0,0,.55)',
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
};
