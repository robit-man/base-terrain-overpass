// UI references and helpers (menu, dots, labels)
const menuBtn = document.getElementById('menu');
const menuPane = document.getElementById('menuPane');
const backdrop = document.getElementById('backdrop');

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
const perfHud = document.getElementById('perfHud');
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
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && menuPane?.style.display === 'block') closeMenu();
});

export function setNkn(t, c) { txtNkn.textContent = t; dotNkn.className = 'dot ' + (c || ''); }
export function setSig(t, c) { txtSig.textContent = t; dotSig.className = 'dot ' + (c || ''); }
export function setSigMeta(t) { txtSigMeta.textContent = t; }

export const ui = {
  menuBtn, menuPane, backdrop,
  dotNkn, txtNkn, dotSig, txtSig, txtSigMeta,
  myAddr, myPub,
  poseHzEl, poseSentEl, poseDropEl, poseRateEl,
  lpPos, lpEul, lpSpd,
  peerSummary, peerList,
  hexSig, nukeBtn,
  hudFps, hudQos,
  openMenu, closeMenu
};
