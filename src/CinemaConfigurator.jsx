import React, { useEffect, useRef, useState, useCallback } from 'react';
import * as THREE from 'three';
import { ColladaLoader } from 'three/examples/jsm/loaders/ColladaLoader.js';

// ============================================================================
// Configurador 3D de sala de cine — Cinemes Full HD (Centre Splau)
// Three.js r128 puro (sin OrbitControls, sin React Three Fiber).
// Usa los assets originales del proyecto:
//   /Cine/butacavip/butacavip.dae  (+ difuse/normal)  → butaca VIP
//   /images/texturagris.jpg, escaleras.jpg, lucesazules3(.alfa).jpg,
//   /images/pantalla2.jpg (logo)                       → sala
// En la pantalla se proyecta un trailer (VideoTexture).
// ============================================================================

// Trailer de "Sintel" (Blender Foundation, CC-BY) descargado en public/video/
const TRAILER_URL = '/video/sintel_trailer-720p.mp4';

// El trailer trae letterbox incrustado: imagen real 1280×544 (2,35:1) con
// 88 px de barra negra arriba y abajo — se recorta vía UV y la pantalla se
// dimensiona al aspecto real para que el vídeo la ocupe entera.
const VIDEO_CROP = { y: 88 / 720, h: 544 / 720 };
const SCREEN = {
  R: 16, // radio del cilindro de pantalla
  cz: 7, // centro del cilindro (la superficie queda en z ≈ -9)
  cy: 3.95,
  halfTheta: 0.3646, // cuerda de ~11,4 m
  height: 4.85, // 11,4 / 2,35
  thick: 0.3, // grosor del panel de pantalla
};
const SCREEN_CENTER = new THREE.Vector3(0, SCREEN.cy, SCREEN.cz - SCREEN.R);
const Z_START = 2.6; // z de la primera fila
const ROW_DEPTH_STD = 1.05;
const ROW_DEPTH_VIP = 1.55;
const AISLE_W = 1.1;
const FLY_MS = 1100;

const easeInOutCubic = (t) =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

export default function CinemaConfigurator() {
  const mountRef = useRef(null);
  const T = useRef(null); // todo el estado three.js
  const seatStates = useRef(new Map()); // "fila-asiento" -> 'vip' | 'blocked'
  const modeRef = useRef('vip');

  const [params, setParams] = useState({
    rows: 12,
    cols: 16,
    vipRows: 2,
    curvature: 35, // 0-100 %
    slope: 0.25, // m / fila
    spacing: 0.78, // m
    aisle: true,
  });
  const [mode, setMode] = useState('vip'); // 'vip' | 'block' | 'clear' | 'pov'
  const [panelOpen, setPanelOpen] = useState(true);
  const [povUI, setPovUI] = useState(false);
  const [counts, setCounts] = useState({ total: 0, vip: 0, blocked: 0 });
  const [vipDaeReady, setVipDaeReady] = useState(false);

  modeRef.current = mode;

  // --------------------------------------------------------------------------
  // Montaje: escena, cámara, luces, pantalla + vídeo, input, bucle de render
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
    scene.fog = new THREE.Fog(0x0b0a0e, 18, 78);

    const camera = new THREE.PerspectiveCamera(
      55,
      mount.clientWidth / mount.clientHeight,
      0.1,
      200
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

    // luz de "proyección" azulada que parpadea delante de la pantalla
    const projLight = new THREE.PointLight(0x7aa7ff, 1.3, 34, 2);
    projLight.position.set(0, 4.4, -5.5);
    scene.add(projLight);

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
    // aplique triangular original (luces.JPG): el atlas tiene las dos caras
    // del prisma lado a lado → una textura recortada por cara
    const texSconceL = loadTex('/images/luces.JPG');
    texSconceL.repeat.set(0.5, 1);
    const texSconceR = loadTex('/images/luces.JPG');
    texSconceR.repeat.set(0.5, 1);
    texSconceR.offset.x = 0.5;
    // altavoz K.C.S.: solo la región frontal del atlas (rejilla + tweeter)
    const texSpeaker = loadTex('/images/speaker_diff.JPG');
    texSpeaker.repeat.set(0.829, 0.568);
    texSpeaker.offset.set(0.021, 0.001);

    // ---- materiales compartidos ---------------------------------------------
    const mats = {
      std: new THREE.MeshStandardMaterial({ color: 0x4a4744, roughness: 0.92 }),
      vipMark: new THREE.MeshStandardMaterial({ color: 0xd8232a, roughness: 0.75 }),
      blocked: new THREE.MeshStandardMaterial({ color: 0x35323a, roughness: 0.95 }),
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
      sconceL: new THREE.MeshStandardMaterial({
        map: texSconceL,
        emissive: 0xbfe4ff,
        emissiveMap: texSconceL,
        emissiveIntensity: 1.5,
        roughness: 0.85,
      }),
      sconceR: new THREE.MeshStandardMaterial({
        map: texSconceR,
        emissive: 0xbfe4ff,
        emissiveMap: texSconceR,
        emissiveIntensity: 1.5,
        roughness: 0.85,
      }),
      speakerFront: new THREE.MeshStandardMaterial({ map: texSpeaker, roughness: 0.85 }),
      speakerBox: new THREE.MeshStandardMaterial({ color: 0x0e0d10, roughness: 0.7 }),
      logo: new THREE.MeshBasicMaterial({ map: texLogo, toneMapped: false }),
    };

    // geometrías unitarias compartidas (se escalan por mesh, nunca se disponen
    // por regeneración)
    const unitBox = new THREE.BoxGeometry(1, 1, 1);
    const unitPlane = new THREE.PlaneGeometry(1, 1);

    // ---- pantalla curva + vídeo ----------------------------------------------
    const screenGeo = new THREE.CylinderGeometry(
      SCREEN.R, SCREEN.R, SCREEN.height, 64, 1, true,
      Math.PI - SCREEN.halfTheta, SCREEN.halfTheta * 2
    );
    const screenGroup = new THREE.Group();
    screenGroup.position.set(0, SCREEN.cy, SCREEN.cz);
    scene.add(screenGroup);
    const video = document.createElement('video');
    video.src = TRAILER_URL;
    video.crossOrigin = 'anonymous';
    video.loop = true;
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    const videoTex = new THREE.VideoTexture(video);
    videoTex.encoding = THREE.sRGBEncoding;
    // el interior del cilindro invierte la U: des-espejar solo lo que va en la
    // pantalla (el rótulo de la pared trasera usa texLogo sin voltear).
    // En V se recorta el letterbox incrustado para que la imagen llene todo.
    videoTex.wrapS = THREE.RepeatWrapping;
    videoTex.repeat.set(-1, VIDEO_CROP.h);
    videoTex.offset.set(1, VIDEO_CROP.y);
    const texLogoScreen = loadTex('/images/pantalla2.jpg');
    // el logo es cuadrado: en la pantalla 2,35:1 se muestra su banda central
    texLogoScreen.repeat.set(-1, 1 / 2.35);
    texLogoScreen.offset.set(1, (1 - 1 / 2.35) / 2);

    const screenMat = new THREE.MeshBasicMaterial({
      map: texLogoScreen, // logo del cine hasta que arranca el trailer
      side: THREE.BackSide,
      toneMapped: false,
    });
    const screenMesh = new THREE.Mesh(screenGeo, screenMat);
    screenGroup.add(screenMesh);

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

    // panel con grosor: carcasa trasera + tapas superior/inferior + cantos
    const slabMat = new THREE.MeshStandardMaterial({ color: 0x141218, roughness: 0.8 });
    const h = SCREEN.halfTheta;
    const TH = SCREEN.thick;
    const backShell = new THREE.Mesh(
      new THREE.CylinderGeometry(
        SCREEN.R + TH, SCREEN.R + TH, SCREEN.height, 64, 1, true,
        Math.PI - h, h * 2
      ),
      slabMat
    );
    screenGroup.add(backShell);
    const lidGeo = new THREE.RingGeometry(SCREEN.R, SCREEN.R + TH, 48, 1, Math.PI / 2 - h, h * 2);
    const lidTop = new THREE.Mesh(lidGeo, slabMat);
    lidTop.rotation.x = -Math.PI / 2;
    lidTop.position.y = SCREEN.height / 2;
    const lidBotGeo = new THREE.RingGeometry(SCREEN.R, SCREEN.R + TH, 48, 1, -Math.PI / 2 - h, h * 2);
    const lidBot = new THREE.Mesh(lidBotGeo, slabMat);
    lidBot.rotation.x = Math.PI / 2;
    lidBot.position.y = -SCREEN.height / 2;
    screenGroup.add(lidTop, lidBot);
    const capGeo = new THREE.BoxGeometry(TH, SCREEN.height, 0.06);
    for (const s of [-1, 1]) {
      const cap = new THREE.Mesh(capGeo, slabMat);
      const rMid = SCREEN.R + TH / 2;
      cap.position.set(s * rMid * Math.sin(h), 0, -rMid * Math.cos(h));
      cap.rotation.y = Math.PI / 2 - s * h;
      screenGroup.add(cap);
    }

    // ---- plantilla butaca estándar (procedural, estilo Kinepolis) ------------
    function buildStandardTemplate() {
      const g = new THREE.Group();
      const add = (geo, mat, x, y, z, sx = 1, sy = 1, sz = 1, swap = false) => {
        const m = new THREE.Mesh(geo, mat);
        m.position.set(x, y, z);
        m.scale.set(sx, sy, sz);
        if (swap) m.name = 'swap';
        m.castShadow = true;
        g.add(m);
        return m;
      };
      const cyl = new THREE.CylinderGeometry(1, 1, 1, 12);
      // placa cuadrada + pie central metálico (sin patas)
      add(unitBox, mats.metal, 0, 0.012, 0.04, 0.42, 0.024, 0.42);
      add(cyl, mats.metal, 0, 0.19, 0.04, 0.045, 0.34, 0.045);
      // cojín grueso con frontal redondeado
      add(unitBox, mats.std, 0, 0.43, 0.02, 0.5, 0.15, 0.46, true);
      const front = add(cyl, mats.std, 0, 0.43, -0.215, 0.075, 0.5, 0.075, true);
      front.rotation.z = Math.PI / 2;
      // respaldo inclinado ~8° (grupo pivotado)
      const tilt = new THREE.Group();
      tilt.position.set(0, 0.36, 0.17);
      tilt.rotation.x = (8 * Math.PI) / 180;
      g.add(tilt);
      const addT = (geo, mat, x, y, z, sx, sy, sz, swap = false) => {
        const m = new THREE.Mesh(geo, mat);
        m.position.set(x, y, z);
        m.scale.set(sx, sy, sz);
        if (swap) m.name = 'swap';
        m.castShadow = true;
        tilt.add(m);
        return m;
      };
      addT(unitBox, mats.std, 0, 0.3, 0.02, 0.5, 0.58, 0.11, true); // respaldo
      const top = addT(cyl, mats.std, 0, 0.59, 0.02, 0.055, 0.5, 0.055, true);
      top.rotation.z = Math.PI / 2; // remate superior redondeado
      addT(unitBox, mats.std, 0, 0.09, -0.05, 0.44, 0.22, 0.06, true); // lumbar
      addT(unitBox, mats.shell, 0, 0.31, 0.09, 0.53, 0.66, 0.035); // carcasa
      // reposabrazos flotantes sobre soporte fino
      for (const s of [-1, 1]) {
        add(cyl, mats.metal, s * 0.31, 0.4, 0.06, 0.018, 0.32, 0.018);
        add(unitBox, mats.std, s * 0.31, 0.585, 0.02, 0.11, 0.055, 0.42, true);
      }
      return g;
    }

    // ---- plantilla VIP procedural (fallback hasta que carga el .dae) ---------
    function buildVipFallbackTemplate() {
      const g = new THREE.Group();
      const cyl = new THREE.CylinderGeometry(1, 1, 1, 12);
      const add = (parent, geo, mat, x, y, z, sx, sy, sz, swap = false) => {
        const m = new THREE.Mesh(geo, mat);
        m.position.set(x, y, z);
        m.scale.set(sx, sy, sz);
        if (swap) m.name = 'swap';
        m.castShadow = true;
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
      const cup = add(g, cyl, mats.tray, 0.49, 0.55, -0.14, 0.05, 0.05, 0.05);
      cup.rotation.x = 0;
      return g;
    }

    // ---- estado three --------------------------------------------------------
    T.current = {
      renderer, scene, camera, mats, unitBox, unitPlane, video, videoTex,
      projLight, spot,
      stdTemplate: buildStandardTemplate(),
      vipTemplate: buildVipFallbackTemplate(),
      vipModel: 'proc', // 'proc' | 'dae'
      vipBaseMats: {}, // nombre de mesh -> material original del dae
      seatsGroup: null, standGroup: null, roomGroup: null,
      seatList: [], // [{key, autoVip, group}]
      orbit: { theta: 0, phi: 0.16, radius: 30, target: new THREE.Vector3(0, 0, 3) },
      homeView: { theta: 0, phi: 0.16, radius: 30, target: new THREE.Vector3(0, 0, 3) },
      pov: { active: false, eye: new THREE.Vector3(), yaw: 0, pitch: 0, prevOrbit: null },
      flight: null,
      lastLookTarget: new THREE.Vector3(0, 0, 3),
      raycaster: new THREE.Raycaster(),
      pointers: new Map(),
      downInfo: null,
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

    const enterPovAt = (seatGroup) => {
      const t = T.current;
      const p = seatGroup.getWorldPosition(new THREE.Vector3());
      const eye = new THREE.Vector3(p.x, p.y + 1.15, p.z);
      setPanelOpen(false);
      flyTo(eye, SCREEN_CENTER, () => {
        t.pov.active = true;
        t.pov.eye.copy(eye);
        const d = SCREEN_CENTER.clone().sub(eye).normalize();
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

    // ---- interacción: puntero / táctil / rueda --------------------------------
    const el = renderer.domElement;

    const onPointerDown = (e) => {
      const t = T.current;
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
    };

    const onPointerMove = (e) => {
      const t = T.current;
      if (!t.pointers.has(e.pointerId)) return;
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
      t.downInfo = null;
      if (!info || info.dragged || t.flight || t.pointers.size > 0) return;

      // click limpio → raycast a butacas
      const rect = el.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1
      );
      t.raycaster.setFromCamera(ndc, camera);
      if (!t.seatsGroup) return;
      const hits = t.raycaster.intersectObjects(t.seatsGroup.children, true);
      let seat = null;
      for (const h of hits) {
        let o = h.object;
        while (o && !o.userData.isSeat) o = o.parent;
        if (o) { seat = o; break; }
      }
      if (!seat) return;

      const m = modeRef.current;
      if (m === 'pov' || t.pov.active) {
        enterPovAt(seat);
        return;
      }
      const key = seat.userData.key;
      if (m === 'vip') seatStates.current.set(key, 'vip');
      else if (m === 'block') seatStates.current.set(key, 'blocked');
      else if (m === 'clear') seatStates.current.delete(key);
      applySeatState(seat);
      recount();
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

      // parpadeo sutil de la "proyección"
      const s = now * 0.001;
      projLight.intensity =
        1.15 + 0.28 * Math.sin(s * 13.7) * Math.sin(s * 7.3) + 0.1 * Math.sin(s * 2.1);

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
        camera.position.copy(t.pov.eye);
        const d = dirFromYawPitch(t.pov.yaw, t.pov.pitch);
        t.lastLookTarget.copy(t.pov.eye).add(d);
        camera.lookAt(t.lastLookTarget);
      } else {
        camera.position.copy(orbitPos(t.orbit));
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
      renderer.dispose();
      mount.removeChild(renderer.domElement);
      T.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --------------------------------------------------------------------------
  // Estado visual de una butaca (solo material, nunca la geometría)
  // --------------------------------------------------------------------------
  const applySeatState = useCallback((seatGroup) => {
    const t = T.current;
    if (!t) return;
    const state = seatStates.current.get(seatGroup.userData.key) || null;
    const isDae = seatGroup.userData.model === 'dae';
    const isVipProc = seatGroup.userData.model === 'vipproc';
    seatGroup.traverse((m) => {
      if (!m.isMesh || !m.name.startsWith('swap')) return;
      if (state === 'blocked') m.material = t.mats.blocked;
      else if (state === 'vip')
        m.material = isDae ? t.vipBaseMats[m.name] : t.mats.vipMark;
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
    let vip = 0, blocked = 0;
    for (const s of t.seatList) {
      const st = seatStates.current.get(s.key);
      if (st === 'blocked') blocked++;
      else if (s.autoVip || st === 'vip') vip++;
    }
    setCounts({ total: t.seatList.length, vip, blocked });
  }, []);

  // --------------------------------------------------------------------------
  // Regeneración procedural de la sala (butacas + graderío + sala)
  // --------------------------------------------------------------------------
  useEffect(() => {
    const t = T.current;
    if (!t) return;
    const { scene, mats, unitBox, unitPlane } = t;
    const { rows, cols, vipRows, curvature, slope, spacing, aisle } = params;

    for (const k of ['seatsGroup', 'standGroup', 'roomGroup']) {
      if (t[k]) {
        scene.remove(t[k]);
        t[k] = null;
      }
    }

    const seatsGroup = new THREE.Group();
    const standGroup = new THREE.Group();
    const roomGroup = new THREE.Group();
    t.seatsGroup = seatsGroup;
    t.standGroup = standGroup;
    t.roomGroup = roomGroup;
    scene.add(seatsGroup, standGroup, roomGroup);
    t.seatList = [];

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

      // escaleras laterales + tira LED azul
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
        seat.userData = {
          isSeat: true,
          key,
          model: isVipRow ? (t.vipModel === 'dae' ? 'dae' : 'vipproc') : 'std',
        };
        seatsGroup.add(seat);
        t.seatList.push({ key, autoVip: isVipRow });
        applySeatState(seat);
      }
    }

    seatsGroup.updateMatrixWorld(true);
    seatsGroup.traverse((o) => (o.matrixAutoUpdate = false));

    // ---- sala (suelo, paredes, techo, paneles LED, logo) ---------------------
    const hallW = Math.max(maxRowWidth + 5.5, 2 * (SCREEN.R * Math.sin(SCREEN.halfTheta)) + 4);
    const zFront = -10.6;
    const zBack = lastZBack + 2.6;
    const hallD = zBack - zFront;
    const hallH = 9.6;
    const zMid = (zFront + zBack) / 2;

    mats.floor.map.repeat.set(hallW / 3.2, hallD / 3.2);
    mats.wall.map.repeat.set(hallD / 4.5, hallH / 4.5);

    const floor = new THREE.Mesh(unitPlane, mats.floor);
    floor.scale.set(hallW, hallD, 1);
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(0, -0.005, zMid);
    floor.receiveShadow = true;
    roomGroup.add(floor);

    const ceiling = new THREE.Mesh(unitPlane, mats.ceiling);
    ceiling.scale.set(hallW, hallD, 1);
    ceiling.rotation.x = Math.PI / 2;
    ceiling.position.set(0, hallH, zMid);
    roomGroup.add(ceiling);

    const mkWall = (w, h) => {
      const m = new THREE.Mesh(unitPlane, mats.wall);
      m.scale.set(w, h, 1);
      m.receiveShadow = true;
      roomGroup.add(m);
      return m;
    };
    const wallL = mkWall(hallD, hallH);
    wallL.rotation.y = Math.PI / 2;
    wallL.position.set(-hallW / 2, hallH / 2, zMid);
    const wallR = mkWall(hallD, hallH);
    wallR.rotation.y = -Math.PI / 2;
    wallR.position.set(hallW / 2, hallH / 2, zMid);
    const wallBack = mkWall(hallW, hallH);
    wallBack.rotation.y = Math.PI;
    wallBack.position.set(0, hallH / 2, zBack);
    const wallFront = mkWall(hallW, hallH);
    wallFront.position.set(0, hallH / 2, zFront);

    // decoración de paredes con los assets originales del cine: apliques
    // triangulares de LEDs azules (luces.JPG) alternados con altavoces K.C.S.
    const mkSconce = () => {
      const g = new THREE.Group();
      const faceL = new THREE.Mesh(unitPlane, mats.sconceL);
      faceL.scale.set(0.56, 1.15, 1);
      faceL.position.x = -0.27;
      faceL.rotation.y = 0.5;
      const faceR = new THREE.Mesh(unitPlane, mats.sconceR);
      faceR.scale.set(0.56, 1.15, 1);
      faceR.position.x = 0.27;
      faceR.rotation.y = -0.5;
      g.add(faceL, faceR);
      return g;
    };
    const mkSpeaker = () => {
      const box = new THREE.Mesh(unitBox, [
        mats.speakerBox, mats.speakerBox, mats.speakerBox,
        mats.speakerBox, mats.speakerFront, mats.speakerBox,
      ]);
      box.scale.set(1.1, 0.75, 0.42);
      return box;
    };
    const nSlots = Math.max(3, Math.floor(hallD / 5.5));
    for (let i = 0; i < nSlots; i++) {
      const pz = zFront + 3.5 + (i + 0.5) * ((hallD - 5) / nSlots);
      for (const sx of [-1, 1]) {
        const isSpeaker = i % 2 === 1;
        const item = isSpeaker ? mkSpeaker() : mkSconce();
        item.position.set(
          sx * (hallW / 2 - (isSpeaker ? 0.24 : 0.13)),
          isSpeaker ? 5.4 : 4.1,
          pz
        );
        item.rotation.y = (sx * -Math.PI) / 2;
        roomGroup.add(item);
      }
    }
    // pareja de altavoces de pantalla flanqueándola en la pared frontal
    for (const sx of [-1, 1]) {
      const sp = mkSpeaker();
      sp.scale.multiplyScalar(1.35);
      sp.position.set(sx * (hallW / 2 - 1.3), 3.3, zFront + 0.35);
      roomGroup.add(sp);
    }

    // rótulo retroiluminado con el logo del cine en la pared trasera
    const logo = new THREE.Mesh(unitPlane, mats.logo);
    logo.scale.set(3.4, 3.4, 1);
    logo.rotation.y = Math.PI;
    logo.position.set(0, 5.6, zBack - 0.04);
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
  }, [params, vipDaeReady, applySeatState, recount]);

  // --------------------------------------------------------------------------
  // UI
  // --------------------------------------------------------------------------
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

  return (
    <div style={{ position: 'fixed', inset: 0 }}>
      <div ref={mountRef} style={{ position: 'absolute', inset: 0 }} />

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
              <div style={ui.counterNum}>{counts.total - counts.blocked}</div>
              <div style={ui.counterLbl}>Aforo</div>
            </div>
            <div style={{ ...ui.counter, borderColor: 'rgba(216,35,42,.5)' }}>
              <div style={{ ...ui.counterNum, color: '#ff5a60' }}>{counts.vip}</div>
              <div style={ui.counterLbl}>VIP</div>
            </div>
            <div style={ui.counter}>
              <div style={{ ...ui.counterNum, color: '#9a95a3' }}>
                {counts.blocked}
              </div>
              <div style={ui.counterLbl}>Bloqueadas</div>
            </div>
          </div>

          {slider('Filas', 'rows', 3, 24, 1)}
          {slider('Butacas por fila', 'cols', 6, 32, 1)}
          {slider('Filas VIP traseras', 'vipRows', 0, 6, 1)}
          {slider('Curvatura', 'curvature', 0, 100, 1, '%')}
          {slider('Pendiente', 'slope', 0, 0.6, 0.01, ' m/fila')}
          {slider('Separación', 'spacing', 0.68, 1.0, 0.01, ' m')}

          <label style={ui.checkRow}>
            <input
              type="checkbox"
              checked={params.aisle}
              onChange={setP('aisle')}
              style={{ accentColor: '#d8232a' }}
            />
            Pasillo central
          </label>

          <div style={ui.modesLbl}>Al tocar una butaca:</div>
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
    gridTemplateColumns: '1fr 1fr 1fr',
    gap: 8,
    marginBottom: 12,
  },
  counter: {
    border: '1px solid rgba(255,255,255,.14)',
    borderRadius: 10,
    padding: '7px 4px',
    textAlign: 'center',
    background: 'rgba(255,255,255,.04)',
  },
  counterNum: { fontSize: 19, fontWeight: 700, lineHeight: 1.1 },
  counterLbl: { fontSize: 10.5, opacity: 0.65, marginTop: 2 },
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
  modesLbl: { fontSize: 11.5, opacity: 0.65, marginBottom: 6 },
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
    marginBottom: 10,
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
};
