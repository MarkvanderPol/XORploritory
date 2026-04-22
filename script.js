// =============================================================
// SECTION 1 — STATE
// =============================================================

const state = {
  // All loaded images: { id, name, imageData: ImageData, removed: boolean }
  images: [],
  nextId: 0,

  // Canvas dimensions set by the first image loaded
  canvasW: 0,
  canvasH: 0,

  // XOR parity over ALL data images (including those marked removed).
  // "Removal" simulates data loss; the parity was pre-computed and stays intact.
  parityData: null,   // Uint8ClampedArray

  // Cumulative XOR strips built from ALL images (for wipe decomposition).
  // leftCum[k]  = XOR of images[0..k]
  // rightCum[k] = XOR of images[N-1..N-1-k]
  leftCum: [],
  rightCum: [],

  // Whether the parity panel itself has been "removed" (simulating parity drive loss)
  parityRemoved: false,

  // Drag / wipe state on the parity panel
  drag: {
    active: false,
    startX: 0,
    initialLeftPx: 0,
    initialRightPx: 0,
    leftPx: 0,
    rightPx: 0,
    rafPending: false,
  },
};

// =============================================================
// SECTION 2 — PIXEL UTILITIES
// =============================================================

/**
 * XOR two same-length Uint8ClampedArrays; alpha always 255.
 */
function xorBuffers(a, b) {
  const out = new Uint8ClampedArray(a.length);
  for (let i = 0; i < a.length; i += 4) {
    out[i]     = a[i]     ^ b[i];
    out[i + 1] = a[i + 1] ^ b[i + 1];
    out[i + 2] = a[i + 2] ^ b[i + 2];
    out[i + 3] = 255;
  }
  return out;
}

/**
 * XOR all ImageData objects together (RGB only, alpha forced to 255).
 * Returns a Uint8ClampedArray.
 */
function computeXOR(imageDataArray) {
  if (imageDataArray.length === 0) return null;
  let acc = new Uint8ClampedArray(imageDataArray[0].data);
  for (let i = 3; i < acc.length; i += 4) acc[i] = 255;
  for (let k = 1; k < imageDataArray.length; k++) {
    acc = xorBuffers(acc, imageDataArray[k].data);
  }
  return acc;
}

/**
 * Resize an image (given as a data URL) to (targetW × targetH).
 * Forces alpha=255 on every pixel to avoid premultiplication artefacts.
 * Returns Promise<ImageData>.
 */
function resizeImageData(dataURL, targetW, targetH) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const oc = new OffscreenCanvas(targetW, targetH);
      const ctx = oc.getContext('2d');
      ctx.drawImage(img, 0, 0, targetW, targetH);
      const id = ctx.getImageData(0, 0, targetW, targetH);
      for (let i = 3; i < id.data.length; i += 4) id.data[i] = 255;
      resolve(id);
    };
    img.onerror = reject;
    img.src = dataURL;
  });
}

/**
 * Build left and right cumulative XOR arrays from an array of ImageData.
 *
 * leftCum[k]  = images[0] XOR images[1] XOR … XOR images[k]
 * rightCum[k] = images[N-1] XOR images[N-2] XOR … XOR images[N-1-k]
 *
 * During the wipe, peeling the leftmost k+1 images from parityData gives:
 *   parityData XOR leftCum[k]  =  images[k+1] XOR … XOR images[N-1]
 * (i.e. the parity of just the remaining images).
 */
function buildCumulativeXOR(imageDataArray) {
  const N = imageDataArray.length;
  if (N === 0) return { leftCum: [], rightCum: [] };

  const leftCum  = [];
  const rightCum = [];

  leftCum[0] = new Uint8ClampedArray(imageDataArray[0].data);
  for (let i = 3; i < leftCum[0].length; i += 4) leftCum[0][i] = 255;
  for (let k = 1; k < N; k++) leftCum[k] = xorBuffers(leftCum[k - 1], imageDataArray[k].data);

  rightCum[0] = new Uint8ClampedArray(imageDataArray[N - 1].data);
  for (let i = 3; i < rightCum[0].length; i += 4) rightCum[0][i] = 255;
  for (let k = 1; k < N; k++) rightCum[k] = xorBuffers(rightCum[k - 1], imageDataArray[N - 1 - k].data);

  return { leftCum, rightCum };
}

// =============================================================
// SECTION 3 — IMAGE LOADING & PARITY MANAGEMENT
// =============================================================

async function handleAddImage(file) {
  const dataURL = await readFileAsDataURL(file);

  // First image sets the canvas dimensions
  if (state.images.length === 0) {
    const size = await getImageNaturalSize(dataURL);
    const maxDim = 480;
    const scale = Math.min(1, maxDim / Math.max(size.w, size.h));
    state.canvasW = Math.round(size.w * scale);
    state.canvasH = Math.round(size.h * scale);
  }

  const imageData = await resizeImageData(dataURL, state.canvasW, state.canvasH);
  const entry = { id: state.nextId++, name: file.name, imageData, removed: false };
  state.images.push(entry);

  recomputeAll();
  syncPanels();
  renderImageCanvas(entry.id);
  renderParityCanvas();
}

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = reject;
    fr.readAsDataURL(file);
  });
}

function getImageNaturalSize(dataURL) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = reject;
    img.src = dataURL;
  });
}

/**
 * Recompute parityData and cumulative XOR strips.
 *
 * IMPORTANT: parityData is always computed from ALL data images, including
 * those marked as "removed". Removal simulates a drive failure — the parity
 * disk was written before the failure and remains unchanged. This is why XOR
 * parity provides resilience: the parity survives even when a data image is lost.
 */
function recomputeAll() {
  if (state.images.length === 0) {
    state.parityData = null;
    state.leftCum    = [];
    state.rightCum   = [];
    return;
  }

  const all = state.images.map(e => e.imageData);
  state.parityData = computeXOR(all);
  const { leftCum, rightCum } = buildCumulativeXOR(all);
  state.leftCum  = leftCum;
  state.rightCum = rightCum;

  // Reset wipe whenever the image set changes (band widths change)
  resetWipe();
}

/** Number of items currently in the "removed" state (images + parity). */
function removedCount() {
  return state.images.filter(e => e.removed).length + (state.parityRemoved ? 1 : 0);
}

/**
 * Mark a data image as removed (simulates drive failure).
 * parityData is intentionally NOT recomputed — it stays intact as pre-computed parity.
 */
function removeImage(id) {
  if (removedCount() >= 1) {
    alert('Only one item can be removed at a time (XOR parity recovers from a single loss).');
    return;
  }
  const entry = state.images.find(e => e.id === id);
  if (!entry) return;
  entry.removed = true;
  resetWipe();
  updatePanelUI(id);
  renderParityCanvas();   // parity is unchanged; re-render to update UI state
}

/** Mark parity as removed (simulates parity drive failure). */
function removeParity() {
  if (removedCount() >= 1) {
    alert('Only one item can be removed at a time (XOR parity recovers from a single loss).');
    return;
  }
  state.parityRemoved = true;
  resetWipe();
  updateParityPanelUI();
}

/**
 * Reconstruct the removed item.
 *
 * For a removed data image C (with A, B remaining):
 *   C = parityData XOR A XOR B  =  (A XOR B XOR C) XOR A XOR B  =  C  ✓
 *
 * For a removed parity: just un-hide it (parityData was never changed).
 */
function reconstructImage(id) {
  if (id === 'parity') {
    state.parityRemoved = false;
    updateParityPanelUI();
    renderParityCanvas();
    return;
  }

  const entry = state.images.find(e => e.id === id);
  if (!entry || !state.parityData) return;

  // XOR the parity with all OTHER images to recover the missing one
  const otherImages = state.images.filter(e => e.id !== id).map(e => e.imageData);
  const reconstructed = otherImages.length > 0
    ? xorBuffers(state.parityData, computeXOR(otherImages))
    : new Uint8ClampedArray(state.parityData);   // only 1 image: parity IS that image

  entry.imageData = new ImageData(reconstructed, state.canvasW, state.canvasH);
  entry.removed = false;

  // Recompute (parityData should equal its pre-failure value since reconstruction is exact)
  recomputeAll();
  updatePanelUI(id);
  renderImageCanvas(id);
  renderParityCanvas();
}

// =============================================================
// SECTION 4 — DOM / PANEL MANAGEMENT
// =============================================================

function createImagePanel(entry) {
  const panel = document.createElement('div');
  panel.className = 'panel';
  panel.dataset.id = entry.id;

  const canvas = document.createElement('canvas');
  canvas.width  = state.canvasW;
  canvas.height = state.canvasH;

  const footer = document.createElement('div');
  footer.className = 'panel-footer';

  const name = document.createElement('span');
  name.className = 'panel-name';
  name.textContent = entry.name;
  name.title = entry.name;

  const btnRemove = document.createElement('button');
  btnRemove.className = 'btn btn-small btn-remove';
  btnRemove.textContent = 'Remove';
  btnRemove.addEventListener('click', () => removeImage(entry.id));

  const btnRecon = document.createElement('button');
  btnRecon.className = 'btn btn-small btn-reconstruct';
  btnRecon.textContent = 'Reconstruct';
  btnRecon.hidden = true;
  btnRecon.addEventListener('click', () => reconstructImage(entry.id));

  footer.append(name, btnRemove, btnRecon);

  const overlay = document.createElement('div');
  overlay.className = 'removed-overlay';
  overlay.hidden = true;
  const overlayLabel = document.createElement('p');
  overlayLabel.textContent = 'Removed';
  const overlayBtn = document.createElement('button');
  overlayBtn.className = 'btn btn-reconstruct';
  overlayBtn.textContent = 'Reconstruct';
  overlayBtn.addEventListener('click', () => reconstructImage(entry.id));
  overlay.append(overlayLabel, overlayBtn);

  panel.append(canvas, footer, overlay);
  return panel;
}

function createParityPanel() {
  document.getElementById('btn-parity-remove').addEventListener('click', removeParity);

  document.getElementById('btn-parity-reset').addEventListener('click', () => {
    resetWipe();
    renderParityCanvas();
  });

  document.getElementById('btn-parity-reconstruct').addEventListener('click', () => {
    reconstructImage('parity');
  });
  document.getElementById('btn-parity-reconstruct-overlay').addEventListener('click', () => {
    reconstructImage('parity');
  });

  const canvas = document.getElementById('parity-canvas');
  canvas.addEventListener('pointerdown',  onParityPointerDown);
  canvas.addEventListener('pointermove',  onParityPointerMove);
  canvas.addEventListener('pointerup',    onParityPointerUp);
  canvas.addEventListener('pointercancel', onParityPointerUp);
  canvas.addEventListener('dblclick', () => { resetWipe(); renderParityCanvas(); });
}

function syncPanels() {
  const container   = document.getElementById('image-panels');
  const emptyHint   = document.getElementById('empty-hint');
  const paritySection = document.getElementById('parity-section');

  if (state.images.length > 0 && emptyHint) emptyHint.remove();
  if (state.images.length >= 1) paritySection.hidden = false;

  // Add a panel for each new image
  for (const entry of state.images) {
    if (!document.querySelector(`.panel[data-id="${entry.id}"]`)) {
      container.appendChild(createImagePanel(entry));
    }
  }

  // Show Remove Parity button only when ≥2 images and parity isn't already removed
  const btnParityRemove = document.getElementById('btn-parity-remove');
  btnParityRemove.hidden = state.images.length < 2 || state.parityRemoved;

  // Single-image hint
  document.getElementById('single-image-hint').hidden = state.images.length !== 1;
}

function updatePanelUI(id) {
  const panel = document.querySelector(`.panel[data-id="${id}"]`);
  if (!panel) return;
  const entry = state.images.find(e => e.id === id);
  if (!entry) return;

  const btnRemove = panel.querySelector('.btn-remove');
  const btnRecon  = panel.querySelector('.btn-reconstruct');
  const overlay   = panel.querySelector('.removed-overlay');

  if (entry.removed) {
    panel.classList.add('is-removed');
    btnRemove.hidden = true;
    btnRecon.hidden  = false;
    overlay.hidden   = false;
  } else {
    panel.classList.remove('is-removed');
    btnRemove.hidden = false;
    btnRecon.hidden  = true;
    overlay.hidden   = true;
  }

  // Sync parity-remove button visibility
  const btnParityRemove = document.getElementById('btn-parity-remove');
  if (btnParityRemove) {
    btnParityRemove.hidden = state.images.length < 2 || state.parityRemoved || removedCount() > 0;
  }
}

function updateParityPanelUI() {
  const overlay      = document.getElementById('parity-removed-overlay');
  const btnReset     = document.getElementById('btn-parity-reset');
  const btnRemove    = document.getElementById('btn-parity-remove');
  const btnRecon     = document.getElementById('btn-parity-reconstruct');
  const parityCanvas = document.getElementById('parity-canvas');
  const parityPanel  = document.getElementById('parity-panel');

  if (state.parityRemoved) {
    overlay.hidden            = false;
    parityCanvas.style.opacity = '0.15';
    parityPanel.style.cursor  = 'default';
    btnReset.hidden  = true;
    btnRemove.hidden = true;
    btnRecon.hidden  = false;
  } else {
    overlay.hidden            = true;
    parityCanvas.style.opacity = '1';
    parityPanel.style.cursor  = 'ew-resize';
    btnRecon.hidden  = true;
    btnReset.hidden  = (state.drag.leftPx === 0 && state.drag.rightPx === 0);
    btnRemove.hidden = state.images.length < 2 || removedCount() > 0;
  }

  // Disable wipe if any data image is removed
  const wipeDisabled = state.parityRemoved || state.images.some(e => e.removed);
  parityPanel.dataset.wipeDisabled = wipeDisabled ? '1' : '';
  parityPanel.style.cursor = (state.parityRemoved || wipeDisabled) ? 'default' : 'ew-resize';

  // Drag hint visibility
  const hint = document.getElementById('parity-hint');
  if (hint) hint.style.display = wipeDisabled ? 'none' : '';
}

// =============================================================
// SECTION 5 — CANVAS RENDERING
// =============================================================

function renderImageCanvas(id) {
  const panel = document.querySelector(`.panel[data-id="${id}"]`);
  if (!panel) return;
  const canvas = panel.querySelector('canvas');
  const entry  = state.images.find(e => e.id === id);
  if (!entry || !canvas) return;

  canvas.width  = state.canvasW;
  canvas.height = state.canvasH;
  canvas.style.aspectRatio = `${state.canvasW} / ${state.canvasH}`;
  canvas.getContext('2d').putImageData(entry.imageData, 0, 0);
}

function renderParityCanvas() {
  const canvas = document.getElementById('parity-canvas');
  if (!canvas || !state.parityData) return;

  canvas.width  = state.canvasW;
  canvas.height = state.canvasH;
  canvas.style.aspectRatio = `${state.canvasW} / ${state.canvasH}`;
  const id = new ImageData(new Uint8ClampedArray(state.parityData), state.canvasW, state.canvasH);
  canvas.getContext('2d').putImageData(id, 0, 0);

  updateParityPanelUI();
}

/**
 * Per-frame wipe renderer (called via requestAnimationFrame during drag).
 *
 * The parity canvas is divided into three horizontal zones:
 *
 *   Left zone  [0 .. leftPx):       parityData XOR leftCum[k]
 *                                   = XOR of images[k+1..N-1]  (left images peeled off)
 *
 *   Right zone [W-rightPx .. W):    parityData XOR rightCum[k]
 *                                   = XOR of images[0..N-2-k]  (right images peeled off)
 *
 *   Middle     [leftPx .. W-rightPx): parityData  (raw chaos)
 *
 * As the user drags, the chaos resolves into real images — the visual "wow".
 */
function renderWipeFrame() {
  state.drag.rafPending = false;

  const canvas = document.getElementById('parity-canvas');
  if (!canvas || !state.parityData) return;

  const W = state.canvasW;
  const H = state.canvasH;
  const N = state.images.length;
  if (N === 0) return;

  const leftPx  = Math.round(Math.max(0, state.drag.leftPx));
  const rightPx = Math.round(Math.max(0, state.drag.rightPx));
  const bw      = W / N;   // band width per image (floating-point)
  const parity  = state.parityData;

  const output = new Uint8ClampedArray(W * H * 4);

  for (let y = 0; y < H; y++) {
    const rowOff = y * W * 4;
    for (let x = 0; x < W; x++) {
      const idx = rowOff + x * 4;

      if (x < leftPx) {
        // Left-peeled zone: XOR away the leftmost k+1 images
        const k     = Math.min(Math.floor(x / bw), N - 1);
        const strip = state.leftCum[k];
        output[idx]     = parity[idx]     ^ strip[idx];
        output[idx + 1] = parity[idx + 1] ^ strip[idx + 1];
        output[idx + 2] = parity[idx + 2] ^ strip[idx + 2];
        output[idx + 3] = 255;
      } else if (x >= W - rightPx) {
        // Right-peeled zone: XOR away the rightmost k+1 images
        const k     = Math.min(Math.floor((W - 1 - x) / bw), N - 1);
        const strip = state.rightCum[k];
        output[idx]     = parity[idx]     ^ strip[idx];
        output[idx + 1] = parity[idx + 1] ^ strip[idx + 1];
        output[idx + 2] = parity[idx + 2] ^ strip[idx + 2];
        output[idx + 3] = 255;
      } else {
        // Middle: raw parity chaos
        output[idx]     = parity[idx];
        output[idx + 1] = parity[idx + 1];
        output[idx + 2] = parity[idx + 2];
        output[idx + 3] = 255;
      }
    }
  }

  const ctx = canvas.getContext('2d');
  ctx.putImageData(new ImageData(output, W, H), 0, 0);

  // Wipe cursor lines (drawn on top via 2D API after putImageData)
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
  ctx.lineWidth   = 1.5;

  if (leftPx > 0 && leftPx < W) {
    ctx.beginPath(); ctx.moveTo(leftPx, 0); ctx.lineTo(leftPx, H); ctx.stroke();
  }
  if (rightPx > 0 && rightPx < W) {
    ctx.beginPath(); ctx.moveTo(W - rightPx, 0); ctx.lineTo(W - rightPx, H); ctx.stroke();
  }

  document.getElementById('btn-parity-reset').hidden = (leftPx === 0 && rightPx === 0);
}

// =============================================================
// SECTION 6 — DRAG EVENT HANDLING
// =============================================================

function onParityPointerDown(e) {
  if (document.getElementById('parity-panel').dataset.wipeDisabled) return;
  if (state.images.length < 2) return;

  e.preventDefault();
  document.getElementById('parity-canvas').setPointerCapture(e.pointerId);

  state.drag.active        = true;
  state.drag.startX        = e.clientX;
  state.drag.initialLeftPx  = state.drag.leftPx;
  state.drag.initialRightPx = state.drag.rightPx;

  // Fade out the "drag to reveal" hint permanently on first interaction
  const hint = document.getElementById('parity-hint');
  if (hint) hint.classList.add('used');
}

function onParityPointerMove(e) {
  if (!state.drag.active) return;
  e.preventDefault();

  const W = state.canvasW;
  // Convert CSS-pixel drag delta → canvas-buffer-pixel delta.
  // The canvas may be displayed at a different CSS size than its buffer
  // (e.g. a 270px-wide buffer displayed at 480px CSS), so without this
  // scaling the wipe line races ahead of or lags behind the pointer.
  const rect  = document.getElementById('parity-canvas').getBoundingClientRect();
  const scale = rect.width > 0 ? W / rect.width : 1;
  const dx    = (e.clientX - state.drag.startX) * scale;

  if (dx < 0) {
    // Dragging left → extend left peel
    const newLeft = state.drag.initialLeftPx + (-dx);
    state.drag.leftPx = Math.min(Math.max(0, newLeft), W - state.drag.rightPx - 1);
  } else {
    // Dragging right → extend right peel
    const newRight = state.drag.initialRightPx + dx;
    state.drag.rightPx = Math.min(Math.max(0, newRight), W - state.drag.leftPx - 1);
  }

  if (!state.drag.rafPending) {
    state.drag.rafPending = true;
    requestAnimationFrame(renderWipeFrame);
  }
}

function onParityPointerUp(e) {
  if (!state.drag.active) return;
  state.drag.active = false;
  document.getElementById('parity-canvas').releasePointerCapture(e.pointerId);
}

function resetWipe() {
  state.drag.leftPx          = 0;
  state.drag.rightPx         = 0;
  state.drag.initialLeftPx   = 0;
  state.drag.initialRightPx  = 0;
  const btn = document.getElementById('btn-parity-reset');
  if (btn) btn.hidden = true;
}

// =============================================================
// SECTION 7 — INITIALIZATION
// =============================================================

function init() {
  const btnAdd    = document.getElementById('btn-add');
  const fileInput = document.getElementById('file-input');

  btnAdd.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', async () => {
    const files = Array.from(fileInput.files);
    fileInput.value = '';
    for (const f of files) {
      await handleAddImage(f);
    }
  });

  createParityPanel();
}

// =============================================================
// SECTION 8 — ENTRY POINT
// =============================================================

document.addEventListener('DOMContentLoaded', init);
