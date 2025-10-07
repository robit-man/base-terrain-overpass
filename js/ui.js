// UI references and helpers (menu, dots, labels)
const menuBtn = document.getElementById('menu');
const menuPane = document.getElementById('menuPane');
const backdrop = document.getElementById('backdrop');
const closeButton = document.getElementById('closeButton');

const dotNkn = document.getElementById('dotNkn');
const txtNkn = document.getElementById('txtNkn');
const dotSig = document.getElementById('dotSig');
const txtSig = document.getElementById('txtSig');
const txtSigMeta = document.getElementById('txtSigMeta');
const myAddr = document.getElementById('myAddr');
const myPub = document.getElementById('myPub');

const poseHzEl = document.getElementById('poseHz');
const poseSentEl = document.getElementById('poseSent');
const poseDropEl = document.getElementById('poseDrop');
const poseRateEl = document.getElementById('poseRate');

const lpPos = document.getElementById('lpPos');
const lpEul = document.getElementById('lpEul');
const lpSpd = document.getElementById('lpSpd');

const peerSummary = document.getElementById('peerSummary');
const peerList = document.getElementById('peerList');

const hexSig = document.getElementById('hexSig');
const nukeBtn = document.getElementById('nuke');
const hudFps = document.getElementById('hudFps');
const hudQos = document.getElementById('hudQos');
const hudDetail = document.getElementById('hudDetail');
const hudHeadingText = document.getElementById('hudHeadingText');
const hudDetailTiles = document.getElementById('hudDetailTiles');
const hudDetailBuild = document.getElementById('hudDetailBuild');
const hudDetailRadius = document.getElementById('hudDetailRadius');
const hudCompassNeedle = document.getElementById('hudCompassNeedle');
const perfHud = document.getElementById('perfHud');
const hudGpsReckon = document.getElementById('hudGpsReckon');
const hudGeohash = document.getElementById('hudGeohash');
const hudLat = document.getElementById('hudLat');
const hudLon = document.getElementById('hudLon');
const hudAltitude = document.getElementById('hudAltitude');
const hudPeerCount = document.getElementById('hudPeerCount');
const hudStatusNknDot = document.getElementById('hudStatusNknDot');
const hudStatusTerrainDot = document.getElementById('hudStatusTerrainDot');
const hudStatusSigDot = document.getElementById('hudStatusSigDot');
const hudStatusNknLabel = document.getElementById('hudStatusNknLabel');
const hudStatusTerrainLabel = document.getElementById('hudStatusTerrainLabel');
const hudStatusSigLabel = document.getElementById('hudStatusSigLabel');
const gpsLockToggle = document.getElementById('gpsLockToggle');
const yawAssistToggle = document.getElementById('yawAssistToggle');
const yawOffsetRange = document.getElementById('yawOffsetRange');
const yawOffsetValue = document.getElementById('yawOffsetValue');
const miniMapMove = document.getElementById('miniMapMove');
const miniMapSnap = document.getElementById('miniMapSnap');
const terrainRelayStatus = document.getElementById('terrainRelayStatus');
const terrainRelayInput = document.getElementById('terrainRelayInput');
const terrainDatasetInput = document.getElementById('terrainDatasetInput');
const terrainModeGeohash = document.getElementById('terrainModeGeohash');
const terrainModeLatLng = document.getElementById('terrainModeLatLng');
if (hudQos) hudQos.addEventListener('animationend', () => hudQos.classList.remove('flash'));
const displayNameInput = document.getElementById('displayNameInput');
const displayNameSave = document.getElementById('displayNameSave');
const toastHost = document.getElementById('toastHost');

function openMenu() {
  backdrop.style.display = 'block';
  menuPane.style.display = 'block';
  document.body?.classList?.add('modal-open');
  perfHud?.setAttribute('aria-expanded', 'true');
}
function closeMenu() {
  backdrop.style.display = 'none';
  menuPane.style.display = 'none';
  document.body?.classList?.remove('modal-open');
  perfHud?.setAttribute('aria-expanded', 'false');
}

menuBtn?.addEventListener('click', openMenu);
perfHud?.addEventListener('click', openMenu);
perfHud?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    openMenu();
  }
});
backdrop?.addEventListener('click', closeMenu);
closeButton?.addEventListener('click', closeMenu);
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && menuPane?.style.display === 'block') closeMenu();
});

function interpretHudState(state) {
  if (!state) return { className: '', dataState: '' };
  const value = state.toString().toLowerCase();
  if (value === 'ok' || value === 'ready' || value === 'connected') {
    return { className: 'ok', dataState: 'ok' };
  }
  if (value === 'warn' || value === 'warning') {
    return { className: 'warn', dataState: 'warn' };
  }
  if (value === 'err' || value === 'error' || value === 'fail' || value === 'failed') {
    return { className: 'err', dataState: 'error' };
  }
  return { className: '', dataState: '' };
}

export function applyHudStatusDot(dotEl, state) {
  if (!dotEl) return;
  const { className, dataState } = interpretHudState(state);
  const classes = ['hud-status-dot', 'dot'];
  if (className) classes.push(className);
  dotEl.className = classes.join(' ');
  if (dataState) dotEl.dataset.state = dataState;
  else delete dotEl.dataset.state;
}

export function setNkn(text, state) {
  txtNkn.textContent = text;
  dotNkn.className = 'dot ' + (state || '');

  applyHudStatusDot(hudStatusNknDot, state);
  if (hudStatusNknLabel) hudStatusNknLabel.title = text;
}

export function setSig(text, state) {
  txtSig.textContent = text;
  dotSig.className = 'dot ' + (state || '');
  applyHudStatusDot(hudStatusSigDot, state);
  if (hudStatusSigLabel) hudStatusSigLabel.title = text;
}
export function setSigMeta(t) { txtSigMeta.textContent = t; }

export function pushToast(message, { duration = 3200 } = {}) {
  if (!toastHost || !message) return;
  const node = document.createElement('div');
  node.className = 'toast';
  node.textContent = message;
  toastHost.appendChild(node);
  requestAnimationFrame(() => node.classList.add('show'));

  const dispose = () => {
    node.removeEventListener('transitionend', onTransitionEnd);
    if (node.parentElement === toastHost) toastHost.removeChild(node);
  };

  const hide = () => {
    node.classList.remove('show');
    node.classList.add('hide');
  };

  const onTransitionEnd = (ev) => {
    if (ev.propertyName === 'opacity' && node.classList.contains('hide')) {
      dispose();
    }
  };

  node.addEventListener('transitionend', onTransitionEnd);
  setTimeout(() => hide(), Math.max(1200, duration || 0));
}

export const ui = {
  menuBtn, menuPane, backdrop,
  dotNkn, txtNkn, dotSig, txtSig, txtSigMeta,
  myAddr, myPub,
  hudDetailTiles, hudDetailBuild, hudDetailRadius,
  poseHzEl, poseSentEl, poseDropEl, poseRateEl,
  lpPos, lpEul, lpSpd,
  peerSummary, peerList,
  hexSig, nukeBtn,
  hudFps, hudQos, hudDetail, hudHeadingText, hudCompassNeedle,
  hudGpsReckon, hudGeohash, hudLat, hudLon, hudAltitude, hudPeerCount,
  hudStatusNknDot, hudStatusTerrainDot, hudStatusSigDot,
  hudStatusNknLabel, hudStatusTerrainLabel, hudStatusSigLabel,
  gpsLockToggle, yawAssistToggle, yawOffsetRange, yawOffsetValue,
  miniMapMove, miniMapSnap,
  terrainRelayStatus, terrainRelayInput, terrainDatasetInput,
  terrainModeGeohash, terrainModeLatLng,
  displayNameInput, displayNameSave, toastHost,
  applyHudStatusDot,
  openMenu, closeMenu
};
