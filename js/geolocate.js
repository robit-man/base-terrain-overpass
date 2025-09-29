/** Geospatial helpers shared across the client ____________________________ */

/** Returns the metres-per-degree scale factors for latitude & longitude. */
export const metresPerDegree = (lat) => {
  const phi = (lat * Math.PI) / 180;
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
  const { dLat, dLon } = metresPerDegree(originLat);
  return {
    lat: originLat - z / dLat,
    lon: originLon + x / dLon,
  };
};

/** Convert latitude/longitude into local world XY (x,z) using an origin. */
export const latLonToWorld = (lat, lon, originLat, originLon) => {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (!Number.isFinite(originLat) || !Number.isFinite(originLon)) return null;
  const { dLat, dLon } = metresPerDegree(originLat);
  return {
    x: (lon - originLon) * dLon,
    z: (originLat - lat) * dLat,
  };
};

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
