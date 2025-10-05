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
const hudLat = document.getElementById('hudLat');
const hudLon = document.getElementById('hudLon');
const hudNknStatus = document.getElementById('hudNknStatus');
const hudTerrainStatus = document.getElementById('hudTerrainStatus');
const gpsLockToggle = document.getElementById('gpsLockToggle');
const yawAssistToggle = document.getElementById('yawAssistToggle');
const yawOffsetRange = document.getElementById('yawOffsetRange');
const yawOffsetValue = document.getElementById('yawOffsetValue');
const miniMapMove = document.getElementById('miniMapMove');
const miniMapCenter = document.getElementById('miniMapCenter');
const terrainRelayStatus = document.getElementById('terrainRelayStatus');
const terrainRelayInput = document.getElementById('terrainRelayInput');
const terrainDatasetInput = document.getElementById('terrainDatasetInput');
const terrainModeGeohash = document.getElementById('terrainModeGeohash');
const terrainModeLatLng = document.getElementById('terrainModeLatLng');
if (hudQos) hudQos.addEventListener('animationend', () => hudQos.classList.remove('flash'));

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

export function setNkn(t, c) {
  txtNkn.textContent = t;
  dotNkn.className = 'dot ' + (c || '');
  if (hudNknStatus) {
    hudNknStatus.textContent = t;
    const state = c === 'err' ? 'error' : (c || '');
    hudNknStatus.dataset.state = state;
  }
}
export function setSig(t, c) { txtSig.textContent = t; dotSig.className = 'dot ' + (c || ''); }
export function setSigMeta(t) { txtSigMeta.textContent = t; }

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
  hudLat, hudLon, hudNknStatus, hudTerrainStatus,
  gpsLockToggle, yawAssistToggle, yawOffsetRange, yawOffsetValue,
  miniMapMove, miniMapCenter,
  terrainRelayStatus, terrainRelayInput, terrainDatasetInput,
  terrainModeGeohash, terrainModeLatLng,
  openMenu, closeMenu
};
