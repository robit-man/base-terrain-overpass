// Minimal geohash utilities adapted from examples/geohash.html
const GH32 = '0123456789bcdefghjkmnpqrstuvwxyz';

export function geohashEncode(lat, lon, precision = 9) {
  let bit = 0;
  let even = true;
  let latMin = -90, latMax = 90;
  let lonMin = -180, lonMax = 180;
  let ch = 0;
  let hash = '';

  while (hash.length < precision) {
    if (even) {
      const mid = (lonMin + lonMax) / 2;
      if (lon > mid) {
        ch |= (1 << (4 - bit));
        lonMin = mid;
      } else {
        lonMax = mid;
      }
    } else {
      const mid = (latMin + latMax) / 2;
      if (lat > mid) {
        ch |= (1 << (4 - bit));
        latMin = mid;
      } else {
        latMax = mid;
      }
    }

    even = !even;

    if (bit < 4) {
      bit++;
    } else {
      hash += GH32[ch];
      bit = 0;
      ch = 0;
    }
  }

  return hash;
}

export function pickGeohashPrecision(spacingMeters) {
  const spacing = Math.max(1, Number(spacingMeters) || 1);
  if (spacing >= 1500) return 6;
  if (spacing >= 300) return 7;
  if (spacing >= 60) return 8;
  if (spacing >= 10) return 9;
  return 10;
}
