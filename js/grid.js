import Delaunator from './vendor/delaunator.js';
import { metresPerDegree } from './geolocate.js';

const C30 = Math.cos(Math.PI / 6);
const S30 = Math.sin(Math.PI / 6);
const MAX_LEVELS = 256;

function insideHexXY(x, y, apothem) {
  if (Math.abs(y) > apothem + 1e-6) return false;
  if (Math.abs(x * C30 + y * S30) > apothem + 1e-6) return false;
  if (Math.abs(-x * C30 + y * S30) > apothem + 1e-6) return false;
  return true;
}

function spacingAtRho(rho, s0, s1, gamma) {
  const t = Math.min(1, Math.max(0, rho));
  return s0 + (s1 - s0) * Math.pow(t, gamma);
}

function buildBoundarySamples(stepMeters, apothem) {
  const radius = (2 * apothem) / Math.sqrt(3);
  const verts = [];
  for (let k = 0; k < 6; k++) {
    const theta = (Math.PI / 3) * k;
    verts.push({
      x: radius * Math.cos(theta),
      y: radius * Math.sin(theta),
    });
  }
  const samples = [];
  const segStep = Math.max(1, stepMeters * 0.5);
  for (let k = 0; k < 6; k++) {
    const a = verts[k];
    const b = verts[(k + 1) % 6];
    const dist = Math.hypot(b.x - a.x, b.y - a.y);
    const segs = Math.max(1, Math.ceil(dist / segStep));
    for (let s = 0; s <= segs; s++) {
      const t = s / segs;
      const x = a.x * (1 - t) + b.x * t;
      const y = a.y * (1 - t) + b.y * t;
      samples.push({ x, y, r: Math.hypot(x, y) });
    }
  }
  return samples;
}

function buildRadialLevels(core, radius, spacingCenter, spacingEdge, falloff) {
  const edges = [0];
  let r = 0;
  const minStep = Math.max(0.35 * spacingCenter, 0.75);
  while (r < radius && edges.length < MAX_LEVELS) {
    const step = Math.max(minStep, spacingAtRho(r / radius, spacingCenter, spacingEdge, falloff) * 0.75);
    r = Math.min(radius, r + step);
    edges.push(r);
    if (radius - r < 0.1) break;
  }
  if (edges[edges.length - 1] !== radius) edges.push(radius);

  const levels = Array.from({ length: Math.max(1, edges.length - 1) }, () => []);
  for (let i = 0; i < core.length; i++) {
    const pt = core[i];
    const rr = Math.min(radius, Math.max(0, pt.r || 0));
    let li = edges.findIndex((edge) => rr <= edge + 1e-6);
    if (li === -1) li = edges.length - 1;
    if (li > 0) li -= 1;
    levels[li].push(i);
  }

  for (const layer of levels) {
    layer.sort((ia, ib) => {
      const a = Math.atan2(core[ia].y, core[ia].x);
      const b = Math.atan2(core[ib].y, core[ib].x);
      return a - b;
    });
  }
  return levels;
}

export function generateHexSurface({
  centerLat,
  centerLon,
  apothem,
  spacingCenter,
  spacingEdge,
  falloff,
}) {
  if (!Number.isFinite(apothem) || apothem <= 0) {
    throw new Error('generateHexSurface: apothem must be positive');
  }

  const R = (2 * apothem) / Math.sqrt(3);
  const metersCenter = metresPerDegree(centerLat);
  const mDegLatCenter = metersCenter.dLat || 111132;

  const core = [];
  let y = 0;
  let parity = 0;
  const maxRows = 2048;
  for (let row = 0; row < maxRows; row++) {
    if (y > apothem + spacingEdge * 1.2) break;
    const rhoRow = Math.min(1, Math.abs(y) / R);
    const spacing = spacingAtRho(rhoRow, spacingCenter, spacingEdge, falloff);
    const rowStep = Math.max(spacing * Math.sqrt(3) / 2, 0.25);
    const zValues = y === 0 ? [0] : [y, -y];
    for (const yy of zValues) {
      const lat = centerLat + yy / mDegLatCenter;
      const metersRow = metresPerDegree(lat);
      const mDegLonRow = metersRow.dLon || metersCenter.dLon || 111319;
      const xOffset = (parity & 1) ? spacing * 0.5 : 0;
      for (let x = -R - spacing * 1.5; x <= R + spacing * 1.5; x += spacing) {
        const xx = x + xOffset;
        if (!insideHexXY(xx, yy, apothem)) continue;
        const lon = centerLon + xx / mDegLonRow;
        core.push({
          x: xx,
          y: yy,
          r: Math.hypot(xx, yy),
          lat,
          lon,
        });
      }
    }
    y += rowStep;
    parity += 1;
  }

  const boundary = buildBoundarySamples(Math.max(2, spacingCenter), apothem);
  for (const pt of boundary) {
    const lat = centerLat + pt.y / mDegLatCenter;
    const metersRow = metresPerDegree(lat);
    const mDegLonRow = metersRow.dLon || metersCenter.dLon || 111319;
    const lon = centerLon + pt.x / mDegLonRow;
    pt.lat = lat;
    pt.lon = lon;
  }

  const points = core.concat(boundary);
  const coreCount = core.length;
  const dela = Delaunator.from(points, (p) => p.x, (p) => p.y);
  const triangles = [];
  for (let t = 0; t < dela.triangles.length; t += 3) {
    const ia = dela.triangles[t];
    const ib = dela.triangles[t + 1];
    const ic = dela.triangles[t + 2];
    const ax = points[ia].x;
    const ay = points[ia].y;
    const bx = points[ib].x;
    const by = points[ib].y;
    const cx = points[ic].x;
    const cy = points[ic].y;
    const mx = (ax + bx + cx) / 3;
    const my = (ay + by + cy) / 3;
    if (insideHexXY(mx, my, apothem * 1.01)) triangles.push(ia, ib, ic);
  }

  const levels = buildRadialLevels(core, R, spacingCenter, spacingEdge, falloff);

  return {
    points,
    coreCount,
    boundaryCount: boundary.length,
    triangles,
    levels,
    apothem,
    radius: R,
  };
}

