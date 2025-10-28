// UI references and helpers (menu, dots, labels)
const menuBtn = document.getElementById('menuBtn');
const menuPane = document.getElementById('menuPane');
const backdrop = document.getElementById('backdrop');
const closeButton = document.getElementById('closeButton');
const controlTabsRoot = document.getElementById('controlTabs');

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
const hybridPeerSummary = document.getElementById('hybridPeerSummary');
const hybridPeerList = document.getElementById('hybridPeerList');
const hybridNetworkButtons = document.querySelectorAll('[data-hybrid-network]');
const hybridChatPeer = document.getElementById('hybridChatPeer');
const hybridChatStatus = document.getElementById('hybridChatStatus');
const hybridChatLog = document.getElementById('hybridChatLog');
const hybridChatInput = document.getElementById('hybridChatInput');
const hybridChatSend = document.getElementById('hybridChatSend');
const processLeaderboardSection = document.getElementById('processLeaderboardSection');
const processLeaderboard = document.getElementById('processLeaderboard');
const processCards = document.getElementById('processCards');
const processGraph = document.getElementById('processGraph');
const processEmptyState = document.getElementById('processEmptyState');
const processReset = document.getElementById('processReset');
const diagPidTargetFps = document.getElementById('diagPidTargetFps');
const diagPidSmoothedFps = document.getElementById('diagPidSmoothedFps');
const diagPidError = document.getElementById('diagPidError');
const diagPidIntegral = document.getElementById('diagPidIntegral');
const diagPidDerivative = document.getElementById('diagPidDerivative');
const diagPidQuality = document.getElementById('diagPidQuality');
const diagPidKp = document.getElementById('diagPidKp');
const diagPidKi = document.getElementById('diagPidKi');
const diagPidKd = document.getElementById('diagPidKd');
const diagPidGain = document.getElementById('diagPidGain');
const diagPidDeadband = document.getElementById('diagPidDeadband');
const diagPidSmoothing = document.getElementById('diagPidSmoothing');
const diagPidApply = document.getElementById('diagPidApply');
const diagPidReset = document.getElementById('diagPidReset');

const hexSig = document.getElementById('hexSig');
const nukeBtn = document.getElementById('nuke');
const hudFps = document.getElementById('hudFps');
const hudQos = document.getElementById('hudQos');
const hudDetail = document.getElementById('hudDetail');
const hudHeadingText = document.getElementById('hudHeadingText');
const hudDetailTiles = document.getElementById('hudDetailTiles');
const hudDetailBuild = document.getElementById('hudDetailBuild');
const hudDetailRadius = document.getElementById('hudDetailRadius');
const hudDetailRender = document.getElementById('hudDetailRender');
const hudCompassNeedle = document.getElementById('hudCompassNeedle');
const perfHud = document.getElementById('perfHud');
const hudGpsReckon = document.getElementById('hudGpsReckon');
const hudDebugToggle = document.getElementById('hudDebugToggle');
const hudWireframeToggle = document.getElementById('hudWireframeToggle');
const hudReset = document.getElementById('hudReset');
const hudTeleportToggle = document.getElementById('hudTeleportToggle');
const hudPointerLock = document.getElementById('hudPointerLock');
const pointerRing = document.getElementById('pointerRing');
const hudPlaceToggle = document.getElementById('hudPlaceToggle');
const hudRadioToggle = document.getElementById('hudRadioToggle');
const hudRadioPanel = document.getElementById('hudRadioPanel');
const hudRadioStatus = document.getElementById('hudRadioStatus');
const hudRadioDial = document.getElementById('hudRadioDial');
const hudRadioList = document.getElementById('hudRadioList');
const hudGeohash = document.getElementById('hudGeohash');
const hudLat = document.getElementById('hudLat');
const hudLon = document.getElementById('hudLon');
const hudAltitude = document.getElementById('hudAltitude');
const hudPeerCount = document.getElementById('hudPeerCount');
const hudClockLocal = document.getElementById('hudClockLocal');
const hudClockUtc = document.getElementById('hudClockUtc');
const hudSunInfo = document.getElementById('hudSunInfo');
const hudMoonInfo = document.getElementById('hudMoonInfo');
const hudWeather = document.getElementById('hudWeather');
const hudWeatherIcon = document.getElementById('hudWeatherIcon');
const hudWeatherTemp = document.getElementById('hudWeatherTemp');
const hudWeatherDesc = document.getElementById('hudWeatherDesc');
const hudWeatherHumidity = document.getElementById('hudWeatherHumidity');
const hudWeatherWind = document.getElementById('hudWeatherWind');
const hudWeatherRain = document.getElementById('hudWeatherRain');
const hudWeatherForecast = document.getElementById('hudWeatherForecast');
const hudScale = document.getElementById('hudScale');
const hudScaleTrack = document.getElementById('hudScaleTrack');
const hudScaleLine1 = document.getElementById('hudScaleLine1');
const hudScaleLine10 = document.getElementById('hudScaleLine10');
const hudScaleMarker1 = document.getElementById('hudScaleMarker1');
const hudScaleMarker10 = document.getElementById('hudScaleMarker10');
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
const pointerLockHint = document.getElementById('pointerLockHint');
const teleportToastHost = document.getElementById('teleportToastHost');
const hudUsersToggle = document.getElementById('hudUsersToggle');
const hudUserPanel = document.getElementById('hudUserPanel');
const hudUserList = document.getElementById('hudUserList');
const overviewBrowser = document.getElementById('overviewBrowser');
const overviewPlatform = document.getElementById('overviewPlatform');
const overviewResolution = document.getElementById('overviewResolution');
const overviewUserAgent = document.getElementById('overviewUserAgent');
const charAnimState = document.getElementById('charAnimState');
const charSpeedValue = document.getElementById('charSpeedValue');
const charElevationValue = document.getElementById('charElevationValue');
const charEyeHeightValue = document.getElementById('charEyeHeightValue');
const charCrouchState = document.getElementById('charCrouchState');
const charJumpState = document.getElementById('charJumpState');
const charFlipForward = document.getElementById('charFlipForward');
const charFlipStrafe = document.getElementById('charFlipStrafe');
const charFlipYaw = document.getElementById('charFlipYaw');
const envInteractiveRing = document.getElementById('envInteractiveRing');
const envInteractiveRingValue = document.getElementById('envInteractiveRingValue');
const envInteractiveRingCurrent = document.getElementById('envInteractiveRingCurrent');
const envVisualRing = document.getElementById('envVisualRing');
const envVisualRingValue = document.getElementById('envVisualRingValue');
const envVisualRingCurrent = document.getElementById('envVisualRingCurrent');
const envFarfieldExtra = document.getElementById('envFarfieldExtra');
const envFarfieldExtraValue = document.getElementById('envFarfieldExtraValue');
const envFarfieldExtraCurrent = document.getElementById('envFarfieldExtraCurrent');
const envFarfieldNearPad = document.getElementById('envFarfieldNearPad');
const envFarfieldNearPadValue = document.getElementById('envFarfieldNearPadValue');
const envFarfieldNearPadCurrent = document.getElementById('envFarfieldNearPadCurrent');
const envFarfieldBudget = document.getElementById('envFarfieldBudget');
const envFarfieldBudgetValue = document.getElementById('envFarfieldBudgetValue');
const envFarfieldBudgetCurrent = document.getElementById('envFarfieldBudgetCurrent');
const envFarfieldBatch = document.getElementById('envFarfieldBatch');
const envFarfieldBatchValue = document.getElementById('envFarfieldBatchValue');
const envFarfieldBatchCurrent = document.getElementById('envFarfieldBatchCurrent');
const envHorizonRadius = document.getElementById('envHorizonRadius');
const envHorizonRadiusValue = document.getElementById('envHorizonRadiusValue');
const envHorizonRadiusCurrent = document.getElementById('envHorizonRadiusCurrent');
const envTileRadius = document.getElementById('envTileRadius');
const envTileRadiusValue = document.getElementById('envTileRadiusValue');
const envTileRadiusCurrent = document.getElementById('envTileRadiusCurrent');
const envFogNear = document.getElementById('envFogNear');
const envFogNearValue = document.getElementById('envFogNearValue');
const envFogNearCurrent = document.getElementById('envFogNearCurrent');
const envFogFar = document.getElementById('envFogFar');
const envFogFarValue = document.getElementById('envFogFarValue');
const envFogFarCurrent = document.getElementById('envFogFarCurrent');
const envTerrainApply = document.getElementById('envTerrainApply');
const envTerrainAuto = document.getElementById('envTerrainAuto');
const envTerrainTargetFps = document.getElementById('envTerrainTargetFps');
const envTerrainTargetFpsValue = document.getElementById('envTerrainTargetFpsValue');
const envBuildingRadius = document.getElementById('envBuildingRadius');
const envBuildingRadiusValue = document.getElementById('envBuildingRadiusValue');
const envBuildingRadiusCurrent = document.getElementById('envBuildingRadiusCurrent');
const envBuildingApply = document.getElementById('envBuildingApply');
const envBuildingAuto = document.getElementById('envBuildingAuto');
const envBuildingTargetFps = document.getElementById('envBuildingTargetFps');
const envBuildingTargetFpsValue = document.getElementById('envBuildingTargetFpsValue');
const envImageryVintage = document.getElementById('envImageryVintage');
const envImageryTimeline = document.getElementById('envImageryTimeline');
const envImageryTimelineLabel = document.getElementById('envImageryTimelineLabel');
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

const CONTROL_TAB_STORAGE = 'xr.controlTab.v1';

function activateControlTab(tabId, { persist = true, focus = true } = {}) {
  if (!controlTabsRoot) return;
  const buttons = controlTabsRoot.querySelectorAll('[data-tab]');
  const panels = controlTabsRoot.querySelectorAll('[data-tab-panel]');
  let targetId = tabId;
  if (!targetId) {
    const activeBtn = controlTabsRoot.querySelector('.control-tab.is-active');
    targetId = activeBtn?.dataset?.tab || buttons[0]?.dataset?.tab;
  }
  if (!targetId) return;
  buttons.forEach((btn) => {
    const isActive = btn.dataset.tab === targetId;
    btn.classList.toggle('is-active', isActive);
    btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
    if (isActive && focus) btn.focus({ preventScroll: true });
  });
  panels.forEach((panel) => {
    const match = panel.dataset.tabPanel === targetId;
    panel.classList.toggle('is-active', match);
    if (match) panel.removeAttribute('hidden');
    else panel.setAttribute('hidden', '');
  });
  if (persist) {
    try { localStorage.setItem(CONTROL_TAB_STORAGE, targetId); } catch {}
  }
}

if (controlTabsRoot) {
  const buttons = controlTabsRoot.querySelectorAll('[data-tab]');
  buttons.forEach((btn) => {
    btn.addEventListener('click', () => activateControlTab(btn.dataset.tab, { focus: true }));
  });
  let initialTab = null;
  try {
    initialTab = localStorage.getItem(CONTROL_TAB_STORAGE);
  } catch {}
  if (initialTab && controlTabsRoot.querySelector(`[data-tab="${initialTab}"]`)) {
    activateControlTab(initialTab, { persist: false, focus: false });
  } else if (buttons.length) {
    activateControlTab(buttons[0].dataset.tab, { persist: false, focus: false });
  }
}

menuBtn?.addEventListener('click', openMenu);
menuBtn?.addEventListener('keydown', (e) => {
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
  hudDetailTiles, hudDetailBuild, hudDetailRadius, hudDetailRender,
  poseHzEl, poseSentEl, poseDropEl, poseRateEl,
  lpPos, lpEul, lpSpd,
  peerSummary, peerList,
  hybridPeerSummary, hybridPeerList, hybridNetworkButtons,
  hybridChatPeer, hybridChatStatus, hybridChatLog, hybridChatInput, hybridChatSend,
  controlTabsRoot,
  processLeaderboardSection, processLeaderboard, processCards, processGraph, processEmptyState, processReset,
  diagPidTargetFps, diagPidSmoothedFps, diagPidError, diagPidIntegral, diagPidDerivative, diagPidQuality,
  diagPidKp, diagPidKi, diagPidKd, diagPidGain, diagPidDeadband, diagPidSmoothing, diagPidApply, diagPidReset,
  hexSig, nukeBtn,
  hudFps, hudQos, hudDetail, hudHeadingText, hudCompassNeedle,
  hudScale, hudScaleTrack, hudScaleLine1, hudScaleLine10, hudScaleMarker1, hudScaleMarker10,
  hudGpsReckon, hudDebugToggle, hudReset, hudTeleportToggle, hudPointerLock, pointerRing, hudGeohash, hudLat, hudLon, hudAltitude, hudPeerCount,
  hudClockLocal, hudClockUtc, hudSunInfo, hudMoonInfo,
  hudWeather, hudWeatherIcon, hudWeatherTemp, hudWeatherDesc,
  hudWeatherHumidity, hudWeatherWind, hudWeatherRain, hudWeatherForecast,
  hudWireframeToggle,
  hudPlaceToggle,
  hudRadioToggle, hudRadioPanel, hudRadioStatus, hudRadioDial, hudRadioList,
  hudStatusNknDot, hudStatusTerrainDot, hudStatusSigDot,
  hudStatusNknLabel, hudStatusTerrainLabel, hudStatusSigLabel,
  gpsLockToggle, yawAssistToggle, yawOffsetRange, yawOffsetValue,
  miniMapMove, miniMapSnap,
  terrainRelayStatus, terrainRelayInput, terrainDatasetInput,
  terrainModeGeohash, terrainModeLatLng,
  pointerLockHint,
  teleportToastHost,
  hudUsersToggle, hudUserPanel, hudUserList,
  overviewBrowser, overviewPlatform, overviewResolution, overviewUserAgent,
  charAnimState, charSpeedValue, charElevationValue, charEyeHeightValue, charCrouchState, charJumpState,
  charFlipForward, charFlipStrafe, charFlipYaw,
  envInteractiveRing, envInteractiveRingValue, envInteractiveRingCurrent,
  envVisualRing, envVisualRingValue, envVisualRingCurrent,
  envFarfieldExtra, envFarfieldExtraValue, envFarfieldExtraCurrent,
  envFarfieldNearPad, envFarfieldNearPadValue, envFarfieldNearPadCurrent,
  envFarfieldBudget, envFarfieldBudgetValue, envFarfieldBudgetCurrent,
  envFarfieldBatch, envFarfieldBatchValue, envFarfieldBatchCurrent,
  envHorizonRadius, envHorizonRadiusValue, envHorizonRadiusCurrent,
  envTileRadius, envTileRadiusValue, envTileRadiusCurrent,
  envFogNear, envFogNearValue, envFogNearCurrent,
  envFogFar, envFogFarValue, envFogFarCurrent,
  envTerrainApply, envTerrainAuto,
  envTerrainTargetFps, envTerrainTargetFpsValue,
  envBuildingRadius, envBuildingRadiusValue, envBuildingRadiusCurrent,
  envBuildingApply, envBuildingAuto,
  envBuildingTargetFps, envBuildingTargetFpsValue,
  envImageryVintage, envImageryTimeline, envImageryTimelineLabel,
  displayNameInput, displayNameSave, toastHost,
  applyHudStatusDot,
  openMenu, closeMenu,
  activateControlTab
};
