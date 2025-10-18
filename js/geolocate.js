/** Geospatial helpers shared across the client ____________________________ */

export const EARTH_RADIUS_METERS = 6378137;
const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;
const TWO_PI = Math.PI * 2;

/** Returns the metres-per-degree scale factors for latitude & longitude. */
export const metresPerDegree = (lat) => {
  const phi = lat * DEG2RAD;
  return {
    dLat: 111132.92 - 559.82 * Math.cos(2 * phi) + 1.175 * Math.cos(4 * phi),
    dLon: 111412.84 * Math.cos(phi) - 93.5 * Math.cos(3 * phi),
  };
};

/** Clamp a latitude to the valid WGS84 range. */
export const clampLat = (lat) => {
  if (!Number.isFinite(lat)) return 0;
  return Math.max(-85, Math.min(85, lat));
};

/** Wrap a longitude into [-180, 180]. */
export const wrapLon = (lon) => {
  if (!Number.isFinite(lon)) return 0;
  let x = lon;
  while (x < -180) x += 360;
  while (x > 180) x -= 360;
  return x;
};

/** Convert local world XY (x,z) into latitude/longitude using an origin. */
export const worldToLatLon = (x, z, originLat, originLon) => {
  if (!Number.isFinite(originLat) || !Number.isFinite(originLon)) return null;
  const lat0Rad = originLat * DEG2RAD;
  const cosLat = Math.cos(lat0Rad);
  const safeCos = Math.max(1e-6, cosLat);
  const deltaLat = (-z) / EARTH_RADIUS_METERS;
  const deltaLon = x / (EARTH_RADIUS_METERS * safeCos);
  let lat = originLat + deltaLat * RAD2DEG;
  let lon = originLon + deltaLon * RAD2DEG;
  lon = wrapLon(lon);
  return { lat, lon };
};

/** Convert latitude/longitude into local world XY (x,z) using an origin. */
export const latLonToWorld = (lat, lon, originLat, originLon) => {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (!Number.isFinite(originLat) || !Number.isFinite(originLon)) return null;
  const latRad = lat * DEG2RAD;
  const lonRad = lon * DEG2RAD;
  const originLatRad = originLat * DEG2RAD;
  const originLonRad = originLon * DEG2RAD;

  let deltaLonRad = lonRad - originLonRad;
  while (deltaLonRad > Math.PI) deltaLonRad -= TWO_PI;
  while (deltaLonRad < -Math.PI) deltaLonRad += TWO_PI;

  const cosLat0 = Math.max(1e-6, Math.cos(originLatRad));

  const x = deltaLonRad * cosLat0 * EARTH_RADIUS_METERS;
  const z = (originLatRad - latRad) * EARTH_RADIUS_METERS;

  return {
    x,
    z,
  };
};

export function latLonToECEF(lat, lon, height = 0) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return { x: 0, y: 0, z: 0 };
  }
  const radius = EARTH_RADIUS_METERS + (Number.isFinite(height) ? height : 0);
  const phi = (90 - lat) * DEG2RAD;
  const theta = (lon + 180) * DEG2RAD;
  const sinPhi = Math.sin(phi);
  const cosPhi = Math.cos(phi);
  const cosTheta = Math.cos(theta);
  const sinTheta = Math.sin(theta);
  return {
    x: -radius * sinPhi * cosTheta,
    y: radius * cosPhi,
    z: radius * sinPhi * sinTheta,
  };
}

export function computeLocalFrame(lat, lon) {
  const phi = lat * DEG2RAD;
  const theta = lon * DEG2RAD;
  const sinPhi = Math.sin(phi);
  const cosPhi = Math.cos(phi);
  const sinTheta = Math.sin(theta);
  const cosTheta = Math.cos(theta);

  const east = {
    x: -sinTheta,
    y: 0,
    z: cosTheta,
  };
  const north = {
    x: -sinPhi * cosTheta,
    y: cosPhi,
    z: -sinPhi * sinTheta,
  };
  const up = {
    x: cosPhi * cosTheta,
    y: sinPhi,
    z: cosPhi * sinTheta,
  };
  return { east, north, up };
}

/** IP geolocation seeder → dispatches 'gps-updated' once. */
export async function ipLocate() {
  const tries = [
    async () => { const r = await fetch('https://ipapi.co/json/'); const j = await r.json(); return { lat:+j.latitude, lon:+j.longitude }; },
    async () => { const r = await fetch('https://ipwho.is/'); const j = await r.json(); return { lat:+j.latitude, lon:+j.longitude }; },
    async () => { const r = await fetch('https://get.geojs.io/v1/ip/geo.json'); const j = await r.json(); return { lat:+j.latitude, lon:+j.longitude }; }
  ];
  for (const f of tries) {
    try {
      const { lat, lon } = await f();
      if (Number.isFinite(lat) && Number.isFinite(lon)) {
        document.dispatchEvent(new CustomEvent('gps-updated', {
          detail: { lat, lon, source: 'ip' }
        }));
        return true;
      }
    } catch { /* next */ }
  }
  return false;
}
