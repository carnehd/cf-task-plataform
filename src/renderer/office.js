// O escritório dos agentes: uma cena 3D (three.js) onde os agentes de um passo andam conforme os eventos da consola.
// Lê na estante, escreve e corre comandos na secretária, pensa à janela, vem à frente quando está à tua espera e descansa
// no sofá quando termina; o anel no chão tem a cor do estado. A página (app.js) só carrega este módulo quando abres o
// escritório (um painel por cima da bola, só com a sala), e dá-lhe os eventos tal como chegam à consola:
// createOffice(...).feed(i, entrada).
import * as THREE from './vendor/three/three.module.js';
import { OrbitControls } from './vendor/three/OrbitControls.js';

const MAX = 4; // secretárias na sala
const THINK_AFTER = 20000; // tanto tempo sem eventos (e sem um comando a correr) e o agente vai pensar para a janela
const READS = new Set(['Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch', 'NotebookRead']);
const PALETTE = [
  { shirt: 0x3b6fb6, hair: 0x3a2416, long: false },
  { shirt: 0x4f8a5b, hair: 0x9a5530, long: true },
  { shirt: 0x8a5fb0, hair: 0x241c18, long: false },
  { shirt: 0xc0703a, hair: 0x5a3a22, long: true },
];
const RING = { working: 0x3b82f6, waiting: 0xf59e0b, done: 0x22c55e, failed: 0xef4444, stopped: 0x9ca3af };
const short = (s, n) => { const t = String(s || '').split('\n')[0].trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const base = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || '';

export function createOffice({ stage, names }) {
  const list = names.slice(0, MAX);
  const N = Math.max(1, list.length);
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------- cena ----------
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true }); // sem WebGL lança, e a página diz porquê
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.08;
  stage.prepend(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 200);
  camera.position.set(23, 16.5, 23);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(5, 2.1, 5); // o meio da sala, do canto da frente ao topo das paredes
  controls.enableDamping = true;
  controls.enablePan = false;
  controls.minPolarAngle = 0.75;
  controls.maxPolarAngle = 1.25;
  controls.minAzimuthAngle = Math.PI / 4 - 0.55;
  controls.maxAzimuthAngle = Math.PI / 4 + 0.55;
  controls.minZoom = 0.75;
  controls.maxZoom = 2.4;
  controls.update();

  function resize() {
    const w = stage.clientWidth;
    const h = stage.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    const aspect = w / h;
    // a sala vista assim mede uns 14 de largura e 11,5 de altura: cabe toda, com pouca margem
    const halfH = Math.max(6.1, 7.6 / aspect);
    const halfW = halfH * aspect;
    Object.assign(camera, { left: -halfW, right: halfW, top: halfH, bottom: -halfH });
    camera.updateProjectionMatrix();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(stage);
  resize();

  // luz: o céu, o sol da tarde pela janela (com sombras) e um enchimento suave
  scene.add(new THREE.HemisphereLight(0xfff3dc, 0x7d6e5c, 1.0));
  const sun = new THREE.DirectionalLight(0xffdca4, 2.6);
  sun.position.set(-9, 11, 4.4);
  sun.target.position.set(4, 0, 4.8);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -13, right: 13, top: 13, bottom: -13, near: 1, far: 45 });
  sun.shadow.camera.updateProjectionMatrix();
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.02;
  scene.add(sun, sun.target);
  const fill = new THREE.DirectionalLight(0xe6edff, 0.55);
  fill.position.set(16, 14, 18);
  scene.add(fill);

  // ---------- ajudas ----------
  const mat = (color, o = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0, flatShading: true, ...o });
  function mesh(geo, material, x, y, z, parent = scene) {
    const m = new THREE.Mesh(geo, typeof material === 'number' ? mat(material) : material);
    m.position.set(x, y, z);
    m.castShadow = true;
    m.receiveShadow = true;
    parent.add(m);
    return m;
  }
  const box = (w, h, d, c, x, y, z, parent) => mesh(new THREE.BoxGeometry(w, h, d), c, x, y, z, parent);
  function canvasTex(w, h, draw) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    draw(c.getContext('2d'), w, h);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    return t;
  }
  const rnd = (a, b) => a + Math.random() * (b - a);
  const WOOD = 0x7a4f2e;
  const WOOD_DARK = 0x5b3a22;
  const sway = []; // o que se mexe devagar: { obj, axis, amp, speed, phase }

  // ---------- chão e paredes ----------
  const floorTex = canvasTex(512, 512, (g, w, h) => {
    const rows = 8;
    const rh = h / rows;
    for (let r = 0; r < rows; r++) {
      let x = -(r % 3) * 70;
      while (x < w) {
        const pw = rnd(130, 240);
        const tone = [rnd(178, 206), rnd(122, 146), rnd(72, 92)].map(Math.round);
        g.fillStyle = `rgb(${tone.join(',')})`;
        g.fillRect(x, r * rh, pw, rh);
        for (let k = 0; k < 4; k++) {
          g.fillStyle = `rgba(110,62,28,${rnd(0.06, 0.14)})`;
          g.fillRect(x + 4, r * rh + rnd(6, rh - 8), pw - 8, 1.5);
        }
        g.fillStyle = 'rgba(70,40,18,.4)';
        g.fillRect(x, r * rh, 2, rh);
        x += pw;
      }
      g.fillStyle = 'rgba(70,40,18,.45)';
      g.fillRect(0, r * rh, w, 2);
    }
  });
  floorTex.wrapS = floorTex.wrapT = THREE.RepeatWrapping;
  floorTex.repeat.set(1.7, 1.7);
  const floorSide = mat(0x8a5a33);
  mesh(new THREE.BoxGeometry(10, 0.35, 10), [floorSide, floorSide, new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.8 }), floorSide, floorSide, floorSide], 5, -0.175, 5);

  const WALL_H = 4.6;
  // parede esquerda (x = 0), com a janela em arco recortada
  const arched = () => {
    const p = new THREE.Shape();
    p.moveTo(3.3, 1.0); p.lineTo(5.7, 1.0); p.lineTo(5.7, 3.0); p.absarc(4.5, 3.0, 1.2, 0, Math.PI, false); p.lineTo(3.3, 1.0);
    return p;
  };
  const wallShape = new THREE.Shape();
  wallShape.moveTo(0, 0); wallShape.lineTo(10, 0); wallShape.lineTo(10, WALL_H); wallShape.lineTo(0, WALL_H); wallShape.lineTo(0, 0);
  wallShape.holes.push(arched());
  const leftWall = mesh(new THREE.ExtrudeGeometry(wallShape, { depth: 0.25, bevelEnabled: false }), mat(0x9db492), 0, 0, 0);
  leftWall.rotation.y = -Math.PI / 2;
  box(10.25, WALL_H, 0.25, 0x8ba783, 4.875, WALL_H / 2, -0.125); // parede do fundo (z = 0)
  box(0.27, 0.06, 10.25, 0xd6dccb, -0.125, WALL_H + 0.03, 4.875);
  box(10.25, 0.06, 0.27, 0xd6dccb, 4.875, WALL_H + 0.03, -0.125);
  box(0.06, 0.2, 10, WOOD_DARK, 0.03, 0.1, 5);
  box(10, 0.2, 0.06, WOOD_DARK, 5, 0.1, 0.03);

  // janela: caixilho, vidro, e lá fora uma vila ao sol
  const frameM = mat(0xf2ead8);
  box(0.12, 3.2, 0.08, frameM, -0.12, 2.6, 4.5);
  box(0.12, 0.07, 2.4, frameM, -0.12, 1.85, 4.5);
  box(0.12, 0.07, 2.4, frameM, -0.12, 2.7, 4.5);
  box(0.3, 0.08, 2.6, frameM, 0.0, 1.0, 4.5);
  const arch = mesh(new THREE.TorusGeometry(1.2, 0.05, 6, 28, Math.PI), frameM, -0.12, 3.0, 4.5);
  arch.rotation.y = -Math.PI / 2;
  const glass = new THREE.Mesh(new THREE.ShapeGeometry(arched()), new THREE.MeshBasicMaterial({ color: 0xd8ecff, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false }));
  glass.rotation.y = -Math.PI / 2;
  glass.position.set(-0.12, 0, 0);
  scene.add(glass);
  const viewTex = canvasTex(512, 400, (g, w, h) => {
    const sky = g.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, '#9fcbe8'); sky.addColorStop(0.6, '#e7f1ea'); sky.addColorStop(1, '#f5e7c4');
    g.fillStyle = sky; g.fillRect(0, 0, w, h);
    g.fillStyle = '#b9cdb0';
    g.beginPath(); g.moveTo(0, 250); for (let x = 0; x <= w; x += 32) g.lineTo(x, 230 - Math.sin(x / 70) * 22); g.lineTo(w, h); g.lineTo(0, h); g.fill();
    for (const [x, y] of [[60, 230], [130, 215], [210, 240], [300, 220], [380, 235], [450, 225]]) {
      g.fillStyle = '#efe3cd'; g.fillRect(x, y, 46, 52);
      g.fillStyle = '#b5583b'; g.beginPath(); g.moveTo(x - 6, y); g.lineTo(x + 23, y - 28); g.lineTo(x + 52, y); g.fill();
      g.fillStyle = '#6f8fa6'; g.fillRect(x + 10, y + 14, 9, 11); g.fillRect(x + 27, y + 14, 9, 11);
    }
    g.fillStyle = '#a65a3a'; g.fillRect(250, 120, 22, 120); g.beginPath(); g.moveTo(244, 120); g.lineTo(261, 78); g.lineTo(278, 120); g.fill();
    for (let i = 0; i < 14; i++) {
      g.fillStyle = ['#5f8f4e', '#6e9d55', '#4f7d43'][i % 3];
      g.beginPath(); g.arc(rnd(0, w), rnd(270, 330), rnd(26, 44), 0, Math.PI * 2); g.fill();
    }
  });
  const view = new THREE.Mesh(new THREE.PlaneGeometry(3.1, 3.4), new THREE.MeshBasicMaterial({ map: viewTex, toneMapped: false }));
  view.position.set(-0.45, 2.5, 4.5);
  view.rotation.y = Math.PI / 2;
  scene.add(view);

  // o raio de sol e o pó a flutuar dentro dele
  const beamMat = new THREE.MeshBasicMaterial({ color: 0xffe9b8, transparent: true, opacity: 0.07, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending });
  for (const y of [3.9, 1.6]) {
    const reach = (13 / 11) * y;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, y, 3.3, 0, y, 5.7, reach, 0, 5.7, 0, y, 3.3, reach, 0, 5.7, reach, 0, 3.3]), 3));
    scene.add(new THREE.Mesh(g, beamMat));
  }
  const dustN = 140;
  const dustPos = new Float32Array(dustN * 3);
  for (let i = 0; i < dustN; i++) { dustPos[i * 3] = rnd(0.2, 4.2); dustPos[i * 3 + 1] = rnd(0.2, 3.8); dustPos[i * 3 + 2] = rnd(3.4, 5.6); }
  const dustGeo = new THREE.BufferGeometry();
  dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPos, 3));
  const dust = new THREE.Points(dustGeo, new THREE.PointsMaterial({ color: 0xfff1cf, size: 2.6, sizeAttenuation: false, transparent: true, opacity: 0.75, depthWrite: false }));
  scene.add(dust);

  // ---------- mobília ----------
  function plant(x, z, s = 1, tall = false) {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    scene.add(g);
    mesh(new THREE.CylinderGeometry(0.28 * s, 0.21 * s, 0.46 * s, 10), 0xb8613a, 0, 0.23 * s, 0, g);
    mesh(new THREE.CylinderGeometry(0.26 * s, 0.26 * s, 0.03, 10), 0x4a3524, 0, 0.45 * s, 0, g);
    const leaves = new THREE.Group();
    leaves.position.y = 0.45 * s;
    g.add(leaves);
    const greens = [0x4f7d3a, 0x5f8f45, 0x3f6d32, 0x6a9a4c];
    if (tall) mesh(new THREE.CylinderGeometry(0.03, 0.04, 1.4 * s, 5), WOOD, 0, 0.7 * s, 0, leaves);
    for (let i = 0; i < (tall ? 12 : 9); i++) {
      const leaf = mesh(new THREE.IcosahedronGeometry(rnd(0.16, 0.3) * s, 0), greens[i % 4], rnd(-0.28, 0.28) * s, (tall ? rnd(0.6, 1.6) : rnd(0.12, 0.62)) * s, rnd(-0.28, 0.28) * s, leaves);
      leaf.scale.set(1, tall ? 0.6 : 0.8, 1);
    }
    sway.push({ obj: leaves, axis: 'z', amp: 0.03, speed: rnd(0.6, 1.1), phase: rnd(0, 6) });
    return g;
  }
  function hanging(x, y, z) {
    const g = new THREE.Group();
    g.position.set(x, y, z);
    scene.add(g);
    mesh(new THREE.CylinderGeometry(0.22, 0.16, 0.3, 8), 0xe8dfcc, 0, 0, 0, g);
    for (let v = 0; v < 6; v++) {
      const vine = new THREE.Group();
      vine.position.set(rnd(-0.15, 0.15), 0.05, rnd(-0.15, 0.15));
      g.add(vine);
      const len = Math.floor(rnd(4, 8));
      for (let k = 0; k < len; k++) mesh(new THREE.IcosahedronGeometry(rnd(0.07, 0.11), 0), [0x4f7d3a, 0x5f8f45][k % 2], rnd(-0.05, 0.05), -k * 0.16, rnd(-0.05, 0.05), vine);
      sway.push({ obj: vine, axis: 'x', amp: 0.06, speed: rnd(0.5, 0.9), phase: rnd(0, 6) });
    }
  }
  function painting(onLeftWall, a, y, w, h, draw) {
    const tex = canvasTex(256, Math.round(256 * h / w), draw);
    const g = new THREE.Group();
    scene.add(g);
    box(w + 0.12, h + 0.12, 0.06, WOOD, 0, 0, 0, g);
    const canvasMesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9 }));
    canvasMesh.position.z = 0.035;
    g.add(canvasMesh);
    if (onLeftWall) { g.position.set(0.04, y, a); g.rotation.y = Math.PI / 2; } else g.position.set(a, y, 0.04);
  }
  const landscape = (g, w, h) => {
    const sky = g.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, '#f2d8a6'); sky.addColorStop(1, '#bcd3c2');
    g.fillStyle = sky; g.fillRect(0, 0, w, h);
    g.fillStyle = '#8aa38e'; g.beginPath(); g.moveTo(0, h * 0.6); g.lineTo(w * 0.3, h * 0.25); g.lineTo(w * 0.55, h * 0.55); g.lineTo(w * 0.8, h * 0.3); g.lineTo(w, h * 0.5); g.lineTo(w, h); g.lineTo(0, h); g.fill();
    g.fillStyle = '#5f7f55'; g.fillRect(0, h * 0.72, w, h * 0.28);
    g.fillStyle = '#7fa6b8'; g.fillRect(w * 0.1, h * 0.8, w * 0.6, h * 0.06);
  };

  // estante com livros, um vaso e trepadeiras
  (function shelf() {
    const x0 = 4.2; const w = 2.0; const d = 0.55; const h = 3.5;
    box(0.08, h, d, WOOD, x0, h / 2, d / 2);
    box(0.08, h, d, WOOD, x0 + w, h / 2, d / 2);
    box(w, h, 0.05, WOOD_DARK, x0 + w / 2, h / 2, 0.03);
    const colors = [0x8c3b2e, 0x2f5d73, 0x3d6b45, 0xc49a3a, 0x6b4a7a, 0x9a5b3c, 0x2d4a5e, 0xb5583b, 0xd8c7a1];
    for (let s = 0; s < 5; s++) {
      const y = 0.08 + s * 0.78;
      box(w, 0.06, d, WOOD, x0 + w / 2, y, d / 2);
      if (s === 4) continue;
      let x = x0 + 0.1;
      while (x < x0 + w - 0.2) {
        const bw = rnd(0.07, 0.13);
        const bh = rnd(0.42, 0.62);
        if (Math.random() < 0.12) { box(0.36, 0.26, 0.3, 0xc8a37a, x + 0.18, y + 0.16, 0.3); x += 0.42; continue; }
        const b = box(bw, bh, rnd(0.3, 0.4), colors[Math.floor(rnd(0, colors.length))], x + bw / 2, y + 0.03 + bh / 2, 0.27);
        if (Math.random() < 0.08) b.rotation.z = 0.25;
        x += bw + 0.01;
      }
    }
    plant(x0 + 1.5, 0.28, 0.75).position.y = h;
    const vines = new THREE.Group();
    vines.position.set(x0 + 1.6, h, 0.45);
    scene.add(vines);
    for (let k = 0; k < 9; k++) mesh(new THREE.IcosahedronGeometry(0.09, 0), 0x4f7d3a, rnd(-0.05, 0.05), -k * 0.17, 0, vines);
    sway.push({ obj: vines, axis: 'x', amp: 0.05, speed: 0.7, phase: 1 });
    box(0.5, 0.32, 0.4, 0xc49a6c, x0 + 0.45, h + 0.16, 0.25);
  })();

  // sofá, mesa de apoio e candeeiro
  (function sofa() {
    const z0 = 7.2; const len = 2.2;
    box(0.9, 0.42, len, 0xe8dcc4, 0.55, 0.32, z0 + len / 2);
    box(0.25, 0.8, len, 0xe2d4b8, 0.18, 0.62, z0 + len / 2);
    box(0.9, 0.62, 0.2, 0xd9c9a8, 0.55, 0.42, z0);
    box(0.9, 0.62, 0.2, 0xd9c9a8, 0.55, 0.42, z0 + len);
    box(0.16, 0.42, 0.5, 0x5f8a5a, 0.42, 0.72, z0 + 0.55).rotation.x = 0.15;
    box(0.16, 0.42, 0.5, 0xc77a45, 0.42, 0.72, z0 + 1.15).rotation.x = -0.1;
    box(0.5, 0.06, 0.5, WOOD, 0.45, 0.6, z0 - 0.55);
    box(0.06, 0.6, 0.06, WOOD, 0.45, 0.3, z0 - 0.55);
    mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.5, 8), 0x3b3b3b, 0.45, 0.88, z0 - 0.55);
    mesh(new THREE.ConeGeometry(0.2, 0.22, 10, 1, true), 0xf3e2b8, 0.45, 1.15, z0 - 0.55);
  })();

  function rug(x, z, w, d, colors) {
    const [bg, border, accent] = colors;
    const tex = canvasTex(256, Math.round(256 * d / w), (g, cw, ch) => {
      g.fillStyle = bg; g.fillRect(0, 0, cw, ch);
      g.strokeStyle = border; g.lineWidth = 12; g.strokeRect(10, 10, cw - 20, ch - 20);
      g.lineWidth = 3; g.strokeRect(24, 24, cw - 48, ch - 48);
      g.fillStyle = accent;
      g.beginPath(); g.moveTo(cw / 2, ch * 0.25); g.lineTo(cw * 0.72, ch / 2); g.lineTo(cw / 2, ch * 0.75); g.lineTo(cw * 0.28, ch / 2); g.fill();
      g.fillStyle = border;
      g.beginPath(); g.moveTo(cw / 2, ch * 0.36); g.lineTo(cw * 0.6, ch / 2); g.lineTo(cw / 2, ch * 0.64); g.lineTo(cw * 0.4, ch / 2); g.fill();
      for (let i = 0; i < 10; i++) { g.fillRect(36 + i * (cw - 72) / 9, 32, 4, 4); g.fillRect(36 + i * (cw - 72) / 9, ch - 36, 4, 4); }
    });
    mesh(new THREE.BoxGeometry(w, 0.02, d), new THREE.MeshStandardMaterial({ map: tex, roughness: 1 }), x, 0.01, z).castShadow = false;
  }
  rug(2.6, 8.3, 2.6, 2.0, ['#efe2c8', '#b5583b', '#7f9a6a']);

  // cantinho do café, quadros, relógio
  box(1.6, 0.95, 0.6, WOOD, 8.9, 0.475, 0.32);
  box(1.66, 0.05, 0.64, WOOD_DARK, 8.9, 0.97, 0.32);
  box(0.32, 0.42, 0.3, 0x3a3f44, 8.5, 1.2, 0.3);
  mesh(new THREE.CylinderGeometry(0.06, 0.05, 0.12, 8), 0xf3efe6, 8.85, 1.06, 0.4);
  mesh(new THREE.CylinderGeometry(0.06, 0.05, 0.12, 8), 0x5f8a5a, 9.05, 1.06, 0.45);
  box(1.4, 0.05, 0.25, WOOD, 9.0, 2.15, 0.14);
  plant(9.3, 0.18, 0.35).position.y = 2.18;
  plant(8.7, 0.18, 0.3).position.y = 2.18;
  painting(false, 7.2, 2.8, 1.5, 1.0, landscape);
  painting(true, 1.5, 2.7, 0.8, 1.0, landscape);
  const clock = new THREE.Group();
  clock.position.set(9.0, 3.45, 0.06);
  scene.add(clock);
  mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.06, 24), 0xfaf6ec, 0, 0, 0, clock).rotation.x = Math.PI / 2;
  mesh(new THREE.TorusGeometry(0.34, 0.035, 6, 24), WOOD_DARK, 0, 0, 0.02, clock).castShadow = false;
  const hand = (len, w) => { const p = new THREE.Group(); p.position.z = 0.05; clock.add(p); box(w, len, 0.01, 0x222222, 0, len / 2, 0, p); return p; };
  const hourHand = hand(0.18, 0.035);
  const minHand = hand(0.27, 0.025);
  const secHand = hand(0.29, 0.01);

  plant(0.55, 0.55, 1.15, true);
  plant(0.6, 6.6, 0.95);
  plant(9.5, 9.4, 1.0, true);
  plant(3.6, 0.7, 0.7);
  plant(9.6, 1.2, 0.8);
  hanging(0.35, 3.9, 2.4);

  // ---------- secretárias: uma por agente, repartidas pela sala ----------
  const DESK_Z = 4.1;
  const CHAIR_Z = 5.05;
  const XS = { 1: [5.2], 2: [3.8, 6.6], 3: [2.4, 5.2, 8.0] }[N] || Array.from({ length: N }, (_, i) => 2.2 + (6.1 * i) / (N - 1));
  const DESK_W = N > 1 ? Math.min(2.0, XS[1] - XS[0] - 0.6) : 2.0;
  function screenCanvas() {
    const c = document.createElement('canvas');
    c.width = 256; c.height = 160;
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return { g: c.getContext('2d'), t, lines: Array.from({ length: 14 }, () => ({ w: rnd(30, 170), ind: Math.floor(rnd(0, 4)), col: ['#82aaff', '#c3e88d', '#f78c6c', '#c792ea', '#89ddff', '#d6deeb'][Math.floor(rnd(0, 6))] })) };
  }
  // o ecrã de cada secretária mostra o que o agente faz: o ficheiro que edita, o comando que corre, o documento que lê
  function drawScreen(s, ag, t) {
    const { g } = s;
    const W = 256; const H = 160;
    const mode = ag.status === 'pending' ? 'idle' : ag.screen;
    g.textAlign = 'center';
    if (mode === 'editor' || mode === 'chat') {
      g.fillStyle = '#1d2433'; g.fillRect(0, 0, W, H);
      g.fillStyle = '#2a3346'; g.fillRect(0, 0, W, 14);
      ['#f87171', '#fbbf24', '#4ade80'].forEach((c, i) => { g.fillStyle = c; g.beginPath(); g.arc(9 + i * 10, 7, 3, 0, 7); g.fill(); });
      g.fillStyle = '#9aa4b2'; g.font = '10px sans-serif'; g.fillText(mode === 'chat' ? 'conversa' : short(ag.file, 30), W / 2 + 10, 11);
      if (mode === 'chat') {
        for (let i = 0; i < 4; i++) {
          const right = i % 2 === 1;
          g.fillStyle = right ? '#3b5bdb' : '#2f6f4f';
          const w = 110 + (i * 37) % 60;
          g.fillRect(right ? W - w - 12 : 12, 24 + i * 32, w, 22);
        }
      } else {
        const off = (t * 26) % 11;
        s.lines.forEach((l, i) => {
          const y = 22 + i * 11 - off;
          if (y < 16 || y > H - 6) return;
          g.fillStyle = '#4b5563'; g.fillRect(6, y, 8, 4);
          g.fillStyle = l.col; g.fillRect(20 + l.ind * 10, y, l.w, 4);
        });
        if (Math.floor(t * 2) % 2) { g.fillStyle = '#e5e7eb'; g.fillRect(24, H - 14, 6, 8); }
      }
    } else if (mode === 'terminal') {
      g.fillStyle = '#0b0f0c'; g.fillRect(0, 0, W, H);
      g.fillStyle = '#4ade80'; g.font = '12px monospace'; g.textAlign = 'left';
      const rows = [`$ ${short(ag.cmd, 32)}`, ...ag.out.slice(0, 6).map((r) => short(r, 34))];
      rows.forEach((r, i) => g.fillText(r, 8, 20 + i * 18));
      if (!ag.out.length && Math.floor(t * 3) % 2) g.fillRect(8, 30, 7, 12);
    } else if (mode === 'reading') {
      g.fillStyle = '#1b1f27'; g.fillRect(0, 0, W, H);
      g.fillStyle = '#e8e2d2'; g.fillRect(88, 22, 80, 100);
      g.fillStyle = '#9aa4b2'; for (let i = 0; i < 7; i++) g.fillRect(98, 36 + i * 11, 60 - (i % 3) * 12, 3);
      g.font = '11px sans-serif'; g.fillStyle = '#cbd5e1'; g.fillText(short(ag.file, 34), W / 2, 144);
    } else if (mode === 'thinking') {
      g.fillStyle = '#1b1f27'; g.fillRect(0, 0, W, H);
      for (let i = 0; i < 3; i++) { g.fillStyle = `rgba(165,180,252,${0.3 + 0.7 * ((Math.floor(t * 3) % 3) === i)})`; g.beginPath(); g.arc(W / 2 - 30 + i * 30, 80, 9, 0, 7); g.fill(); }
    } else if (mode === 'waiting') {
      g.fillStyle = '#2b2414'; g.fillRect(0, 0, W, H);
      g.fillStyle = '#fbbf24'; g.font = 'bold 80px sans-serif'; g.fillText('?', W / 2, 100 + Math.sin(t * 4) * 4);
    } else if (mode === 'done') {
      g.fillStyle = '#12261a'; g.fillRect(0, 0, W, H);
      g.strokeStyle = '#4ade80'; g.lineWidth = 9; g.beginPath(); g.arc(W / 2, 72, 38, 0, 7); g.stroke();
      g.beginPath(); g.moveTo(W / 2 - 18, 72); g.lineTo(W / 2 - 4, 87); g.lineTo(W / 2 + 20, 58); g.stroke();
      g.font = '15px sans-serif'; g.fillStyle = '#bbf7d0'; g.fillText('FEITO.md', W / 2, 140);
    } else if (mode === 'failed') {
      g.fillStyle = '#2a1313'; g.fillRect(0, 0, W, H);
      g.fillStyle = '#f87171'; g.font = 'bold 76px sans-serif'; g.fillText('!', W / 2, 105);
    } else {
      g.fillStyle = '#121418'; g.fillRect(0, 0, W, H);
      g.fillStyle = '#2f3540'; g.font = '14px sans-serif'; g.fillText('z z', W / 2 + Math.sin(t) * 3, 84);
    }
    s.t.needsUpdate = true;
  }
  function makeDesk(x, i) {
    const w = DESK_W;
    const mw = Math.min(1.0, w - 0.75);
    box(w, 0.08, 1.0, WOOD, x, 1.05, DESK_Z);
    box(Math.min(0.55, w * 0.27), 1.0, 0.9, i % 2 ? 0x4b5563 : WOOD_DARK, x - w / 2 + 0.32, 0.5, DESK_Z);
    for (const dy of [0.25, 0.55, 0.85]) box(Math.min(0.4, w * 0.2), 0.02, 0.02, 0xd1c7b4, x - w / 2 + 0.32, dy, DESK_Z + 0.46);
    box(0.06, 1.0, 0.06, WOOD_DARK, x + w / 2 - 0.06, 0.5, DESK_Z - 0.44);
    box(0.06, 1.0, 0.06, WOOD_DARK, x + w / 2 - 0.06, 0.5, DESK_Z + 0.44);
    box(0.08, 0.32, 0.08, 0x2f3540, x + 0.1, 1.25, DESK_Z - 0.28);
    box(0.36, 0.03, 0.22, 0x2f3540, x + 0.1, 1.105, DESK_Z - 0.28);
    box(mw, mw * 0.64, 0.05, 0x23272f, x + 0.1, 1.42 + mw * 0.26, DESK_Z - 0.3);
    const scr = screenCanvas();
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(mw * 0.92, mw * 0.56), new THREE.MeshBasicMaterial({ map: scr.t, toneMapped: false }));
    screen.position.set(x + 0.1, 1.42 + mw * 0.26, DESK_Z - 0.27);
    scene.add(screen);
    box(Math.min(0.62, mw * 0.7), 0.025, 0.2, 0xe5e1d8, x + 0.1, 1.105, DESK_Z + 0.32);
    if (w > 1.6) box(0.1, 0.02, 0.15, 0xe5e1d8, x + 0.55, 1.105, DESK_Z + 0.34);
    mesh(new THREE.CylinderGeometry(0.06, 0.05, 0.13, 8), [0xf3efe6, 0x5f8a5a, 0xc77a45, 0x2f5d73][i % 4], x - w / 4, 1.15, DESK_Z - 0.1);
    if (w > 1.6) {
      if (i % 2 === 0) { const p = box(0.32, 0.01, 0.42, 0xfaf7f0, x + 0.68, 1.095, DESK_Z + 0.05); p.rotation.y = 0.2; } else plant(x + 0.78, DESK_Z - 0.2, 0.35).position.y = 1.09;
    }
    const glow = new THREE.PointLight(0x9ec5ff, 0, 2.4, 2);
    glow.position.set(x + 0.1, 1.6, DESK_Z + 0.15);
    scene.add(glow);
    const chair = new THREE.Group();
    chair.position.set(x + 0.1, 0, CHAIR_Z);
    scene.add(chair);
    for (let k = 0; k < 5; k++) { const ang = (k / 5) * Math.PI * 2; box(0.42, 0.04, 0.06, 0x2b2f36, Math.cos(-ang) * 0.2, 0.08, Math.sin(-ang) * 0.2, chair).rotation.y = ang; }
    mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.55, 8), 0x3a3f47, 0, 0.38, 0, chair);
    const chairCol = [0x2b2f36, 0x3a3631, 0x30343c, 0x36302c][i % 4]; // escuras, para o agente sentado se ver bem
    box(0.6, 0.1, 0.56, chairCol, 0, 0.68, 0, chair);
    box(0.56, 0.62, 0.08, chairCol, 0, 1.05, 0.3, chair);
    rug(x, 5.25, Math.min(1.7, w - 0.2), 1.3, i % 2 ? ['#c9d6c0', '#5f7f55', '#efe2c8'] : ['#c46a4f', '#7a2f22', '#efe2c8']);
    return { screen: scr, glow };
  }
  const desks = XS.map(makeDesk);

  // ---------- por onde se anda: corredores à frente e atrás das secretárias, e entre elas ----------
  // os corredores de cima a baixo: junto à janela, à direita, e no meio de cada espaço livre entre secretárias
  const lanes = [1.0];
  const edgesX = [1.0, ...XS.flatMap((x) => [x - DESK_W / 2, x + DESK_W / 2]), 9.3];
  for (let k = 0; k < edgesX.length; k += 2) {
    const [a, b] = [edgesX[k], edgesX[k + 1]];
    const mid = (a + b) / 2;
    if (b - a > 0.55 && mid - 1.0 > 0.45 && 9.3 - mid > 0.45) lanes.push(mid);
  }
  lanes.push(9.3);
  const NODES = { C2: [1.0, 4.5], FS: [1.6, 6.3] };
  lanes.forEach((x, k) => { NODES[`F${k}`] = [x, 6.3]; NODES[`B${k}`] = [x, 2.3]; });
  const front = Object.keys(NODES).filter((k) => k[0] === 'F').sort((a, b) => NODES[a][0] - NODES[b][0]);
  const EDGES = [['F0', 'C2'], ['C2', 'B0']];
  for (let k = 1; k < front.length; k++) EDGES.push([front[k - 1], front[k]]);
  for (let k = 1; k < lanes.length; k++) EDGES.push([`B${k - 1}`, `B${k}`], ...(k > 0 ? [[`F${k}`, `B${k}`]] : []));
  const NEXT = {};
  for (const [a, b] of EDGES) { (NEXT[a] = NEXT[a] || []).push(b); (NEXT[b] = NEXT[b] || []).push(a); }
  const dist2 = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
  const nearestNode = (p) => Object.keys(NODES).reduce((best, k) => (dist2(NODES[k], p) < dist2(NODES[best], p) ? k : best), 'F0');
  // anda-se a direito ao longo de uma fila (à frente ou atrás das secretárias), de um corredor entre as filas,
  // ou à frente do sofá
  const near = (a, b) => Math.abs(a - b) < 0.06;
  function straight(p, q) {
    if (near(p[1], q[1]) && (near(p[1], 6.3) || near(p[1], 2.3))) return true;
    if (!near(p[0], q[0])) return false;
    const lo = Math.min(p[1], q[1]); const hi = Math.max(p[1], q[1]);
    if (lanes.some((x) => near(x, p[0])) && lo > 2.24 && hi < 6.36) return true;
    return near(p[0], 1.6) && lo > 6.24;
  }
  function dijkstra(pts, next, from, to) {
    const d = { [from]: 0 }; const prev = {}; const open = new Set(Object.keys(pts));
    while (open.size) {
      let u = null;
      for (const k of open) if (d[k] !== undefined && (u === null || d[k] < d[u])) u = k;
      if (u === null || u === to) break;
      open.delete(u);
      for (const v of next(u)) { const alt = d[u] + dist2(pts[u], pts[v]); if (d[v] === undefined || alt < d[v]) { d[v] = alt; prev[v] = u; } }
    }
    if (d[to] === undefined) return null;
    const path = [to];
    while (path[0] !== from) path.unshift(prev[path[0]]);
    return path;
  }
  // o caminho mais curto de um ponto a outro, pelos corredores; devolve os pontos do meio
  function route(a, b) {
    const pts = { ...NODES, S: a, G: b };
    const ends = ['S', 'G'];
    const next = (k) => (ends.includes(k)
      ? Object.keys(pts).filter((j) => j !== k && straight(pts[k], pts[j]))
      : [...(NEXT[k] || []), ...ends.filter((j) => straight(pts[j], pts[k]))]);
    const path = dijkstra(pts, next, 'S', 'G');
    if (path) return path.slice(1, -1).map((k) => pts[k]);
    // a meio de um passo fora dos corredores: vai ao nó mais perto e segue daí
    const from = nearestNode(a);
    const to = nearestNode(b);
    return (dijkstra(NODES, (k) => NEXT[k] || [], from, to) || [from, to]).map((k) => NODES[k]);
  }

  // os sítios do escritório: onde o agente fica, para onde olha, a pose e a "porta" por onde se chega
  const sofaSeats = [null, null];
  function spotFor(ag, kind) {
    const i = ag.i;
    const ax = XS[i] + 0.1;
    switch (kind) {
      case 'desk': return { kind, x: ax, z: CHAIR_Z, face: 0, pose: ag.status === 'failed' ? 'slump' : ag.status === 'stopped' ? 'sit' : 'type', door: [ax, 6.3] };
      case 'shelf': return { kind, x: 4.55 + (i % 4) * 0.45, z: 1.25, face: 0, pose: 'read', door: [4.55 + (i % 4) * 0.45, 2.3] };
      case 'window': return { kind, x: 1.0, z: 3.6 + (i % 4) * 0.45, face: Math.PI / 2, pose: 'think', door: [1.0, 3.6 + (i % 4) * 0.45] };
      case 'front': return { kind, x: 5.0 + (i % 4) * 0.85, z: 8.3, face: -3 * Math.PI / 4, pose: 'wave', door: [5.0 + (i % 4) * 0.85, 6.3] };
      case 'rest': {
        let seat = sofaSeats.indexOf(i);
        if (seat < 0) seat = sofaSeats.indexOf(null);
        if (seat >= 0) { sofaSeats[seat] = i; return { kind, seat, x: 0.78, z: 7.75 + seat * 0.95, face: -Math.PI / 2, pose: 'sofa', door: [1.6, 7.75 + seat * 0.95] }; }
        return { kind, x: 8.3 + (i % 3) * 0.5, z: 1.3, face: 0, pose: 'drink', door: [8.3 + (i % 3) * 0.5, 2.3] };
      }
      default: return { kind: 'away', x: 8.8, z: 10.8, face: Math.PI, pose: 'stand', door: [9.3, 6.3] };
    }
  }
  const POSE = { type: { sit: 1, type: 1 }, sit: { sit: 1 }, slump: { sit: 1, slump: 1 }, read: { read: 1 }, think: { think: 1 }, wave: { wave: 1 }, sofa: { sofa: 1 }, drink: { drink: 1 }, stand: {} };

  // ---------- os agentes ----------
  function makeAgent(name, i) {
    const look = PALETTE[i % PALETTE.length];
    const body = new THREE.Group();
    scene.add(body);
    const pelvis = new THREE.Group();
    body.add(pelvis);
    const skin = mat(0xe9b995); const shirt = mat(look.shirt); const pants = mat(0x2f3540); const shoe = mat(0x1f1f1f);
    const leg = (side) => {
      const hip = new THREE.Group(); hip.position.set(side * 0.12, 0, 0); pelvis.add(hip);
      box(0.15, 0.44, 0.16, pants, 0, -0.22, 0, hip);
      const knee = new THREE.Group(); knee.position.set(0, -0.44, 0); hip.add(knee);
      box(0.13, 0.44, 0.14, pants, 0, -0.22, 0, knee);
      box(0.15, 0.08, 0.26, shoe, 0, -0.46, -0.06, knee);
      return { hip, knee };
    };
    const L = leg(-1); const R = leg(1);
    const upper = new THREE.Group(); upper.position.set(0, 0.02, 0); pelvis.add(upper);
    mesh(new THREE.CapsuleGeometry(0.21, 0.32, 4, 10), shirt, 0, 0.34, 0, upper);
    const head = new THREE.Group(); head.position.set(0, 0.86, 0); upper.add(head);
    mesh(new THREE.SphereGeometry(0.19, 14, 12), skin, 0, 0, 0, head);
    const hairM = mat(look.hair);
    mesh(new THREE.SphereGeometry(0.205, 14, 12, 0, Math.PI * 2, 0, Math.PI * 0.55), hairM, 0, 0.02, 0.01, head);
    if (look.long) box(0.32, 0.36, 0.1, hairM, 0, -0.12, 0.13, head);
    const arm = (side) => {
      const p = new THREE.Group(); p.position.set(side * 0.27, 0.6, 0); upper.add(p);
      mesh(new THREE.CapsuleGeometry(0.065, 0.36, 3, 8), shirt, 0, -0.22, 0, p);
      mesh(new THREE.SphereGeometry(0.07, 8, 6), skin, 0, -0.47, 0, p);
      return p;
    };
    const armL = arm(-1); const armR = arm(1);
    const book = new THREE.Group(); book.position.set(0, 0.5, -0.36); book.rotation.x = -0.55; upper.add(book);
    box(0.36, 0.26, 0.04, [0x8c3b2e, 0x2f5d73, 0x3d6b45, 0xc49a3a][i % 4], 0, 0, 0, book);
    box(0.33, 0.23, 0.045, 0xf5efe0, 0, 0, -0.005, book);
    const cup = mesh(new THREE.CylinderGeometry(0.055, 0.045, 0.12, 8), 0xf3efe6, 0, -0.53, -0.05, armR);
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.3, 0.38, 36), new THREE.MeshBasicMaterial({ color: 0x3b82f6, transparent: true, opacity: 0.7, depthWrite: false }));
    ring.rotation.x = -Math.PI / 2;
    scene.add(ring);
    return { name, look, i, body, pelvis, upper, head, armL, armR, L, R, book, cup, ring, x: 0, z: 0, face: 0, path: [], spot: null, goal: null, phase: 0,
      status: 'pending', screen: 'idle', file: '', cmd: '', out: [], busy: null, since: Date.now(),
      pose: { sit: 0, sofa: 0, walk: 0, type: 0, read: 0, think: 0, wave: 0, drink: 0, slump: 0, present: 0 } };
  }
  const agents = list.map(makeAgent);

  // manda o agente para um sítio: sai do sítio onde está, segue os corredores, entra no novo
  function goTo(ag, kind) {
    if (ag.spot && ag.spot.kind === kind && !ag.path.length) { ag.spot = spotFor(ag, kind); return; }
    if (ag.goal && ag.goal.kind === kind && ag.path.length) return;
    if (ag.spot && ag.spot.kind === 'rest' && ag.spot.seat !== undefined) sofaSeats[ag.spot.seat] = null;
    const s = spotFor(ag, kind);
    const start = ag.spot ? ag.spot.door : [ag.x, ag.z];
    const pts = [];
    if (ag.spot) pts.push(ag.spot.door);
    for (const p of route(start, s.door)) pts.push(p);
    pts.push(s.door, [s.x, s.z]);
    ag.path = pts.filter((p, k) => k === 0 || dist2(p, pts[k - 1]) > 0.05);
    ag.goal = s;
    ag.spot = null;
  }
  function place(ag, kind) {
    if (ag.spot && ag.spot.kind === 'rest' && ag.spot.seat !== undefined) sofaSeats[ag.spot.seat] = null;
    const s = spotFor(ag, kind);
    ag.x = s.x; ag.z = s.z; ag.face = s.face; ag.spot = s; ag.goal = null; ag.path = [];
    const P = POSE[s.pose];
    for (const k of Object.keys(ag.pose)) ag.pose[k] = P[k] ?? 0;
    ag.pose.present = kind === 'away' ? 0 : 1;
  }

  // ---------- os eventos: as entradas da consola, tal como a plataforma as regista ----------
  // move = para onde vai e o que mostra o ecrã; quiet = ao abrir o escritório, põe-no logo no sítio, sem andar
  function act(ag, move, quiet) {
    const go = quiet ? place : goTo;
    if (move === 'start') {
      if (!ag.spot || ag.spot.kind === 'away') { place(ag, 'away'); ag.pose.present = 1; }
      ag.status = 'working'; ag.screen = 'editor'; go(ag, 'desk');
    } else if (move === 'read') { ag.status = 'working'; ag.screen = 'reading'; go(ag, 'shelf'); }
    else if (move === 'edit' || move === 'bash') { ag.status = 'working'; ag.screen = move === 'bash' ? 'terminal' : 'editor'; go(ag, 'desk'); }
    else if (move === 'think') { ag.screen = 'thinking'; go(ag, 'window'); }
    else if (move === 'say') { ag.screen = 'chat'; go(ag, 'desk'); }
    else if (move === 'wait') { ag.status = 'waiting'; ag.screen = 'waiting'; go(ag, 'front'); }
    else if (move === 'back') { ag.status = 'working'; ag.screen = 'editor'; go(ag, 'desk'); }
    else if (move === 'done') { ag.status = 'done'; ag.screen = 'done'; go(ag, 'rest'); }
    else if (move === 'fail') { ag.status = 'failed'; ag.screen = 'failed'; go(ag, 'desk'); }
    else if (move === 'stop') { ag.status = 'stopped'; ag.screen = 'idle'; go(ag, 'desk'); }
    else if (move === 'leave') { ag.status = 'pending'; ag.screen = 'idle'; if (quiet) place(ag, 'away'); else goTo(ag, 'away'); }
  }
  // uma entrada da consola: para onde vai o agente (null: fica onde está; undefined: não conta como sinal de vida)
  function read(ag, e) {
    const a = String(e.a || '');
    switch (e.k) {
      case 'start': return 'start';
      case 'tool':
        if (a === 'Bash') { ag.cmd = String(e.b || ''); ag.out = []; ag.busy = e.id || 'bash'; return 'bash'; }
        ag.busy = null;
        ag.file = base(e.b) || short(e.b, 40);
        return READS.has(a) ? 'read' : 'edit';
      case 'result':
        if (e.id && ag.busy === e.id) ag.busy = null;
        ag.out = String(e.b || '').split('\n').filter((l) => l.trim()).slice(0, 6);
        return null;
      case 'say': ag.busy = null; return 'say';
      case 'ask': return 'wait';
      case 'wait': ag.busy = null; return 'wait';
      case 'user': return 'back';
      case 'ok':
        if (a === 'Terminou') { ag.busy = null; return 'done'; }
        return ag.status === 'waiting' ? 'back' : undefined;
      case 'deny':
        ag.busy = null;
        if (a === 'Parou') return 'fail';
        if (a === 'Parado') return 'stop';
        return ag.status === 'waiting' ? 'back' : null;
      default: return undefined;
    }
  }
  function feed(i, e, quiet) {
    const ag = agents[i];
    if (!ag || !e) return;
    const move = read(ag, e);
    if (move === undefined) return;
    ag.since = quiet ? Date.parse(e.at) || Date.now() : Date.now();
    if (move) act(ag, move, quiet);
  }
  // o estado que a plataforma tem para o agente manda: acerta-se o boneco se os eventos não chegaram a dizer
  const WANT = { running: 'working', waiting: 'waiting', done: 'done', failed: 'failed', stopped: 'stopped', interrupted: 'stopped', pending: 'pending' };
  function setStatus(i, status, quiet) {
    const ag = agents[i];
    if (!ag) return;
    const want = WANT[status] || 'pending';
    if (want === ag.status) return;
    const move = { working: ag.status === 'waiting' ? 'back' : 'start', waiting: 'wait', done: 'done', failed: 'fail', stopped: 'stop', pending: 'leave' }[want];
    act(ag, move, quiet);
  }
  function seed(i, entries, status) {
    const ag = agents[i];
    if (!ag) return;
    Object.assign(ag, { status: 'pending', screen: 'idle', busy: null, file: '', cmd: '', out: [] });
    place(ag, 'away');
    for (const e of entries || []) feed(i, e, true);
    setStatus(i, status, true);
    if (ag.status === 'working' && Date.now() - ag.since > THINK_AFTER && !ag.busy) act(ag, 'think', true);
  }
  // sem eventos há algum tempo, e sem um comando a correr: está a pensar, à janela
  const thinker = setInterval(() => {
    for (const ag of agents) {
      if (ag.status !== 'working' || ag.busy || ag.path.length || !ag.spot || ag.spot.kind === 'window') continue;
      if (Date.now() - ag.since < THINK_AFTER) continue;
      ag.since = Date.now();
      act(ag, 'think');
    }
  }, 1000);

  // ---------- animação ----------
  const clockT = new THREE.Clock();
  let screenTick = 0;
  let running = false;
  let raf = 0;
  const SPEED = 2.1;
  const angleTo = (from, to) => { let d = (to - from) % (Math.PI * 2); if (d > Math.PI) d -= Math.PI * 2; if (d < -Math.PI) d += Math.PI * 2; return d; };
  function frame() {
    if (!running) return;
    raf = requestAnimationFrame(frame);
    const dt = Math.min(clockT.getDelta(), 0.05);
    const t = clockT.elapsedTime;
    const k = 1 - Math.exp(-dt * (reduce ? 3 : 6));
    for (const ag of agents) {
      // andar: primeiro levanta-se, depois segue o caminho
      let target = ag.goal && !ag.path.length ? POSE[ag.goal.pose] : ag.spot ? POSE[ag.spot.pose] : {};
      let walking = false;
      if (ag.path.length) {
        target = {};
        if (ag.pose.sit + ag.pose.sofa < 0.15) {
          const [px, pz] = ag.path[0];
          const dx = px - ag.x; const dz = pz - ag.z; const d = Math.hypot(dx, dz);
          const step = SPEED * dt;
          if (d <= step) { ag.x = px; ag.z = pz; ag.path.shift(); } else { ag.x += (dx / d) * step; ag.z += (dz / d) * step; }
          if (d > 0.02) ag.face += angleTo(ag.face, Math.atan2(-dx, -dz)) * Math.min(1, dt * 10);
          walking = true;
          if (!ag.path.length) { ag.spot = ag.goal; ag.goal = null; }
        }
      } else if (ag.spot) ag.face += angleTo(ag.face, ag.spot.face) * Math.min(1, dt * 6);
      const p = ag.pose;
      for (const key of ['sit', 'sofa', 'type', 'read', 'think', 'wave', 'drink', 'slump']) p[key] += ((target[key] || 0) - p[key]) * k;
      p.walk += ((walking ? 1 : 0) - p.walk) * Math.min(1, dt * 8);
      const away = ag.spot && ag.spot.kind === 'away' && !ag.path.length;
      p.present += ((away ? 0 : 1) - p.present) * k;
      ag.body.visible = p.present > 0.03;
      ag.body.scale.setScalar(0.5 + 0.5 * p.present);
      ag.body.position.set(ag.x, 0, ag.z);
      ag.body.rotation.y = ag.face;
      // o corpo
      ag.phase += dt * 9 * p.walk;
      const swing = Math.sin(ag.phase) * p.walk;
      const seated = Math.min(1, p.sit + p.sofa);
      ag.pelvis.position.y = 0.94 - 0.14 * p.sit - 0.32 * p.sofa + Math.abs(Math.sin(ag.phase)) * 0.04 * p.walk;
      ag.L.hip.rotation.x = seated * Math.PI / 2 + swing * 0.55;
      ag.R.hip.rotation.x = seated * Math.PI / 2 - swing * 0.55;
      ag.L.knee.rotation.x = -seated * Math.PI / 2 - Math.max(0, -swing) * 0.7;
      ag.R.knee.rotation.x = -seated * Math.PI / 2 - Math.max(0, swing) * 0.7;
      const tap = (o) => Math.sin(t * 13 + o) * 0.07 * p.type * (reduce ? 0.3 : 1);
      ag.upper.rotation.x = 0.3 * p.sofa - 0.32 * p.slump + 0.04 * p.read;
      ag.head.rotation.x = -0.15 * p.sofa + 0.55 * p.slump + 0.3 * p.read + 0.12 * p.think + Math.sin(t * 3.1) * 0.03 * p.type;
      ag.head.rotation.y = Math.sin(t * 0.6) * 0.15 * p.type + 0.25 * p.think;
      ag.armL.rotation.x = 0.1 + 0.86 * p.type + 1.0 * p.read + 2.7 * p.sofa + 0.7 * p.think + 0.4 * p.slump - swing * 0.5 + tap(0);
      ag.armR.rotation.x = 0.1 + 0.86 * p.type + 1.0 * p.read + 2.7 * p.sofa + 2.1 * p.think + 2.7 * p.wave + (1.75 + Math.sin(t * 0.9) * 0.3) * p.drink + 0.4 * p.slump + swing * 0.5 + tap(1.7);
      ag.armL.rotation.z = -0.35 * p.read - 0.55 * p.sofa - 0.4 * p.think;
      ag.armR.rotation.z = 0.35 * p.read + 0.55 * p.sofa + 0.4 * p.think - p.wave * (0.25 + Math.sin(t * 7) * 0.28);
      ag.book.visible = p.read > 0.4;
      ag.cup.visible = p.drink > 0.4;
      // o anel no chão, com a cor do estado
      ag.ring.visible = ag.body.visible && ag.status !== 'pending';
      ag.ring.position.set(ag.x, 0.015, ag.z);
      ag.ring.material.color.setHex(RING[ag.status] || 0x9ca3af);
      ag.ring.material.opacity = ag.status === 'waiting' ? 0.45 + Math.sin(t * 6) * 0.3 : 0.65;
      const d = desks[ag.i];
      d.glow.intensity = ag.status === 'working' && ag.spot && ag.spot.kind === 'desk' ? 0.9 + Math.sin(t * 9) * 0.1 : ag.status === 'waiting' ? 0.45 : 0;
      d.glow.color.setHex(ag.status === 'waiting' ? 0xffc46b : ag.screen === 'terminal' ? 0x86efac : 0x9ec5ff);
    }
    screenTick += dt;
    if (screenTick > 1 / 12) { screenTick = 0; agents.forEach((ag) => drawScreen(desks[ag.i].screen, ag, t)); }
    for (const s of sway) s.obj.rotation[s.axis] = Math.sin(t * s.speed + s.phase) * s.amp * (reduce ? 0.3 : 1);
    if (!reduce) {
      const pos = dust.geometry.attributes.position;
      for (let i = 0; i < dustN; i++) {
        let y = pos.getY(i) + dt * 0.06;
        if (y > 3.9) y = 0.2;
        pos.setY(i, y);
        pos.setX(i, pos.getX(i) + Math.sin(t * 0.5 + i) * dt * 0.02);
      }
      pos.needsUpdate = true;
    }
    const now = new Date();
    const sec = now.getSeconds() + now.getMilliseconds() / 1000;
    secHand.rotation.z = -(sec / 60) * Math.PI * 2;
    minHand.rotation.z = -((now.getMinutes() + sec / 60) / 60) * Math.PI * 2;
    hourHand.rotation.z = -(((now.getHours() % 12) + now.getMinutes() / 60) / 12) * Math.PI * 2;
    controls.update();
    renderer.render(scene, camera);
  }

  agents.forEach((ag) => place(ag, 'away'));

  return {
    feed: (i, e) => feed(i, e, false),
    seed,
    setStatus: (i, s) => setStatus(i, s, false),
    // onde está cada agente e o que faz (para testes)
    snapshot: () => agents.map((ag) => ({ name: ag.name, status: ag.status, x: +ag.x.toFixed(2), z: +ag.z.toFixed(2), spot: ag.spot ? ag.spot.kind : null, goal: ag.goal ? ag.goal.kind : null, walking: ag.path.length > 0, visible: ag.body.visible, screen: ag.screen })),
    // a janela fechada não gasta: a animação pára e retoma onde estava
    resume() { if (running) return; running = true; clockT.getDelta(); resize(); frame(); },
    pause() { running = false; cancelAnimationFrame(raf); },
    destroy() {
      running = false;
      cancelAnimationFrame(raf);
      clearInterval(thinker);
      ro.disconnect();
      controls.dispose();
      scene.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        for (const m of [].concat(o.material || [])) { if (m.map) m.map.dispose(); m.dispose(); }
      });
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    },
  };
}
