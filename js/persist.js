// Persist the full page & module code to localStorage on load (same behavior as before)
(function () {
  const KEY_HTML = 'XR_NAV_APP_SRC_HTML_V1';
  const KEY_MOD  = 'XR_NAV_APP_SRC_MODULE_V1';
  const KEY_META = 'XR_NAV_APP_SRC_META_V1';

  function toHex(bytes) {
    return Array.from(new Uint8Array(bytes)).map(b => b.toString(16).padStart(2, '0')).join('');
  }
  async function sha256(text) {
    const enc = new TextEncoder().encode(text);
    const buf = await (crypto.subtle || (crypto.webcrypto && crypto.webcrypto.subtle)).digest('SHA-256', enc);
    return toHex(buf);
  }

  async function persist() {
    try {
      const html = document.documentElement.outerHTML;
      const mod  = ''; // modules are separate now (we still keep the slot for continuity)

      const hash = await sha256(html);
      const meta = {
        savedAtISO: new Date().toISOString(),
        href: location.href,
        userAgent: navigator.userAgent,
        htmlBytes: new Blob([html]).size,
        modBytes: new Blob([mod]).size,
        sha256: hash
      };

      try { localStorage.setItem(KEY_HTML, html); } catch (e) { console.warn('[persist] HTML save failed:', e); }
      try { localStorage.setItem(KEY_MOD, mod); } catch (e) { console.warn('[persist] MODULE save failed:', e); }
      try { localStorage.setItem(KEY_META, JSON.stringify(meta)); } catch (e) { console.warn('[persist] META save failed:', e); }

      console.log('[persist] saved page to localStorage', { KEY_HTML, KEY_MOD, KEY_META, meta });
    } catch (e) {
      console.warn('[persist] failed:', e);
    }
  }

  (document.readyState === 'complete' || document.readyState === 'interactive')
    ? setTimeout(persist, 0)
    : window.addEventListener('DOMContentLoaded', () => setTimeout(persist, 0));
})();
