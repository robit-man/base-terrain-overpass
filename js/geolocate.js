// IP geolocation seeder → dispatches 'gps-updated' once
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
        document.dispatchEvent(new CustomEvent('gps-updated', { detail: { lat, lon } }));
        return true;
      }
    } catch { /* next */ }
  }
  return false;
}
