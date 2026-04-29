'use strict';

// Palette PICO-8 étendue (16 + 16 « secret ») = 32 couleurs rétro
const PALETTE = [
  '#000000', '#1D2B53', '#7E2553', '#008751',
  '#AB5236', '#5F574F', '#C2C3C7', '#FFF1E8',
  '#FF004D', '#FFA300', '#FFEC27', '#00E436',
  '#29ADFF', '#83769C', '#FF77A8', '#FFCCAA',
  '#291814', '#111D35', '#422136', '#125359',
  '#742F29', '#49333B', '#A28879', '#F3EF7D',
  '#BE1250', '#FF6C24', '#A8E72E', '#00B543',
  '#065AB5', '#754665', '#FF6E59', '#FF9D81',
];

// Dimensions reçues du serveur via l'événement `init` (CANVAS_WIDTH/HEIGHT côté env)
let CANVAS_W = 128;
let CANVAS_H = 128;
const DEFAULT_COLOR = 7;

// ----- Conversion palette en RGBA pour ImageData -----------------------------
const paletteRGBA = PALETTE.map(hex => {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return [r, g, b, 255];
});

// ----- DOM -------------------------------------------------------------------
const canvasEl   = document.getElementById('canvas');
const wrapEl     = document.getElementById('canvas-wrap');
const paletteEl  = document.getElementById('palette');
const userCountEl   = document.getElementById('user-count');
const hoverCoordsEl = document.getElementById('hover-coords');
const statusDot     = document.getElementById('status-dot');
const statusText    = document.getElementById('status-text');
const selectedSwatch = document.getElementById('selected-swatch');
const selectedIndex  = document.getElementById('selected-index');
const zoomBtns = document.querySelectorAll('.zoom-btn');
const resetBtn  = document.getElementById('reset-btn');
const canvasSizeEl = document.getElementById('canvas-size');

const ctx = canvasEl.getContext('2d');
let imageData  = ctx.createImageData(CANVAS_W, CANVAS_H);
let pixelBuffer = new Uint8Array(CANVAS_W * CANVAS_H);

let selectedColor = 8; // rouge PICO-8 par défaut
let zoom = 8;

// (Re)dimensionne tous les buffers + le DOM en fonction des dimensions serveur
function configureCanvas(w, h) {
  if (canvasSizeEl) canvasSizeEl.textContent = `${w}×${h}`;
  if (w === CANVAS_W && h === CANVAS_H && pixelBuffer.length === w * h) return;
  CANVAS_W = w;
  CANVAS_H = h;
  canvasEl.width  = w;
  canvasEl.height = h;
  pixelBuffer = new Uint8Array(w * h);
  imageData   = ctx.createImageData(w, h);
  document.documentElement.style.setProperty('--w', String(w));
  document.documentElement.style.setProperty('--h', String(h));
}

// ----- Palette UI ------------------------------------------------------------
function buildPalette() {
  paletteEl.innerHTML = '';
  PALETTE.forEach((hex, i) => {
    const btn = document.createElement('button');
    btn.className = 'swatch';
    btn.style.setProperty('--c', hex);
    btn.title = `#${i.toString().padStart(2, '0')}  ${hex}`;
    btn.dataset.idx = String(i);
    btn.setAttribute('role', 'option');
    btn.addEventListener('click', () => selectColor(i));
    paletteEl.appendChild(btn);
  });
}

function selectColor(i) {
  selectedColor = i;
  paletteEl.querySelectorAll('.swatch').forEach((el, idx) => {
    el.classList.toggle('is-active', idx === i);
  });
  selectedSwatch.style.background = PALETTE[i];
  selectedIndex.textContent = `#${String(i).padStart(2, '0')}`;
}

// ----- Rendu canvas ----------------------------------------------------------
function setPixel(x, y, c) {
  const i = y * CANVAS_W + x;
  pixelBuffer[i] = c;
  const off = i * 4;
  const rgba = paletteRGBA[c];
  imageData.data[off]     = rgba[0];
  imageData.data[off + 1] = rgba[1];
  imageData.data[off + 2] = rgba[2];
  imageData.data[off + 3] = rgba[3];
  // micro-update : on ne redessine que le pixel changé
  ctx.putImageData(imageData, 0, 0, x, y, 1, 1);
}

function repaintAll() {
  for (let i = 0; i < pixelBuffer.length; i++) {
    const off = i * 4;
    const rgba = paletteRGBA[pixelBuffer[i]];
    imageData.data[off]     = rgba[0];
    imageData.data[off + 1] = rgba[1];
    imageData.data[off + 2] = rgba[2];
    imageData.data[off + 3] = rgba[3];
  }
  ctx.putImageData(imageData, 0, 0);
}

// ----- Zoom ------------------------------------------------------------------
function setZoom(z) {
  zoom = z;
  document.documentElement.style.setProperty('--zoom', String(z));
  zoomBtns.forEach(b => b.classList.toggle('is-active', Number(b.dataset.zoom) === z));
}

zoomBtns.forEach(btn => {
  btn.addEventListener('click', () => setZoom(Number(btn.dataset.zoom)));
});

// ----- Coordonnées sous la souris -------------------------------------------
function eventToPixel(ev) {
  const rect = canvasEl.getBoundingClientRect();
  const x = Math.floor((ev.clientX - rect.left) / rect.width * CANVAS_W);
  const y = Math.floor((ev.clientY - rect.top)  / rect.height * CANVAS_H);
  if (x < 0 || x >= CANVAS_W || y < 0 || y >= CANVAS_H) return null;
  return { x, y };
}

canvasEl.addEventListener('mousemove', (ev) => {
  const p = eventToPixel(ev);
  hoverCoordsEl.textContent = p ? `${p.x},${p.y}` : '—';
});
canvasEl.addEventListener('mouseleave', () => {
  hoverCoordsEl.textContent = '—';
});

// ----- Pose de pixel ---------------------------------------------------------
let isDragging = false;

function place(ev) {
  const p = eventToPixel(ev);
  if (!p) return;
  // Optimistic update local + envoi serveur
  setPixel(p.x, p.y, selectedColor);
  sendPixel(p.x, p.y, selectedColor);
}

canvasEl.addEventListener('mousedown', (ev) => {
  if (ev.button !== 0) return;
  isDragging = true;
  place(ev);
});
canvasEl.addEventListener('mousemove', (ev) => {
  if (isDragging) place(ev);
});
window.addEventListener('mouseup', () => { isDragging = false; });

// Pipette : clic droit ou Alt+clic = prendre la couleur du pixel
canvasEl.addEventListener('contextmenu', (ev) => {
  ev.preventDefault();
  const p = eventToPixel(ev);
  if (!p) return;
  selectColor(pixelBuffer[p.y * CANVAS_W + p.x]);
});

// Touch basique
canvasEl.addEventListener('touchstart', (ev) => {
  if (!ev.touches[0]) return;
  ev.preventDefault();
  place(ev.touches[0]);
}, { passive: false });
canvasEl.addEventListener('touchmove', (ev) => {
  if (!ev.touches[0]) return;
  ev.preventDefault();
  place(ev.touches[0]);
}, { passive: false });

// ----- Transport : Server-Sent Events + POST --------------------------------
// On n'utilise pas WebSocket : sur l'hébergement mutualisé o2switch, le proxy
// Apache/Passenger casse les frames WS. SSE = simple flux HTTP, ça marche.
let eventSource = null;

function setStatus(connected, label) {
  statusDot.classList.toggle('is-connected', connected);
  statusText.textContent = label;
}

function sendPixel(x, y, c) {
  fetch('/pixel', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ x, y, c }),
    keepalive: true,
  }).catch(() => { /* le serveur rebroadcast en cas de succès */ });
}

function connect() {
  setStatus(false, 'connexion…');
  if (eventSource) { try { eventSource.close(); } catch (_) {} }
  eventSource = new EventSource('/events');

  eventSource.addEventListener('open', () => setStatus(true, 'connecté'));

  eventSource.addEventListener('init', (ev) => {
    let data; try { data = JSON.parse(ev.data); } catch (_) { return; }
    if (data.width && data.height) configureCanvas(data.width, data.height);
    const bin = atob(data.canvas);
    const len = Math.min(bin.length, pixelBuffer.length);
    for (let i = 0; i < len; i++) pixelBuffer[i] = bin.charCodeAt(i);
    repaintAll();
  });

  eventSource.addEventListener('reset', (ev) => {
    let data; try { data = JSON.parse(ev.data); } catch (_) { data = {}; }
    const fill = (data.color | 0) || DEFAULT_COLOR;
    if (data.width && data.height) configureCanvas(data.width, data.height);
    pixelBuffer.fill(fill);
    repaintAll();
  });

  eventSource.addEventListener('pixel', (ev) => {
    let data; try { data = JSON.parse(ev.data); } catch (_) { return; }
    setPixel(data.x | 0, data.y | 0, data.c | 0);
  });

  eventSource.addEventListener('users', (ev) => {
    let data; try { data = JSON.parse(ev.data); } catch (_) { return; }
    userCountEl.textContent = data.count;
  });

  eventSource.addEventListener('error', () => {
    setStatus(false, 'déconnecté — reconnexion');
    // EventSource gère la reconnexion automatiquement après ~3 s
  });
}

// ----- Bouton reset (admin) --------------------------------------------------
const TOKEN_KEY = 'pixelart.adminToken';

async function doReset() {
  let token = localStorage.getItem(TOKEN_KEY) || '';
  if (!token) {
    token = (window.prompt('Token admin pour reset ?') || '').trim();
    if (!token) return;
  }

  try {
    const res = await fetch('/admin/reset', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });

    if (res.status === 403) {
      localStorage.removeItem(TOKEN_KEY);
      alert('Token invalide.');
      return;
    }
    if (res.status === 503) {
      alert('Reset désactivé côté serveur (ADMIN_TOKEN non configuré).');
      return;
    }
    if (!res.ok) {
      alert(`Erreur ${res.status}`);
      return;
    }

    // OK : on retient le token pour les prochains resets
    localStorage.setItem(TOKEN_KEY, token);
  } catch (err) {
    alert('Erreur réseau : ' + err.message);
  }
}

if (resetBtn) {
  resetBtn.addEventListener('click', () => {
    if (!confirm('Tout effacer ? (action irréversible)')) return;
    doReset();
  });
}

// ----- Boot ------------------------------------------------------------------
buildPalette();
selectColor(selectedColor);
setZoom(zoom);
configureCanvas(CANVAS_W, CANVAS_H);
repaintAll();
connect();
