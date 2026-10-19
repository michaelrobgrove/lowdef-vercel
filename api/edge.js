// api/edge.js — Vercel Edge Function (standalone, no Next build)
// Replaces the ARRR + DAVY StrongBox bridge.
// Deploy: import repo into Vercel (or `vercel --prod`), set custom domains.

const ALLOWED_HOSTS = [
  'legacy.lowdefpirate.link',
  'ship.lowdefpirate.link',
  'cove.lowdefpirate.link',
  'inlet.lowdefpirate.link',
  '*.lowdefpirate.link',
  'tfplus.stream',
  'northernsea.net',
  'usethisserver.link',
];
const UPSTREAM = 'http://usethisserver.link';
const EPG_SRC = 'https://myepg.top/dl/ZYxXtj2qH/';

async function isAllowedHost(host) {
  if (!host) return false;
  if (ALLOWED_HOSTS.includes(host)) return true;
  if (host.endsWith('.lowdefpirate.link')) return true;
  return false;
}

// fetch EPG: follow redirects, request gzip, decompress
async function fetchEpg() {
  const res = await fetch(EPG_SRC, {
    redirect: 'follow',
    headers: { 'Accept-Encoding': 'gzip' }, // request gzip
  }).catch(() => null);
  
  if (!res || !res.ok) return null;
  
  const arrayBuffer = await res.arrayBuffer();
  const uint8 = new Uint8Array(arrayBuffer);
  
  // Check if gzipped (magic bytes 0x1f 0x8b)
  if (uint8.length >= 2 && uint8[0] === 0x1f && uint8[1] === 0x8b) {
    try {
      // Decompress using DecompressionStream (Edge supports this)
      const blob = new Blob([uint8], { type: 'application/gzip' });
      const ds = new DecompressionStream('gzip');
      const writer = ds.writable.getWriter();
      await writer.write(uint8);
      await writer.close();
      const reader = ds.readable.getReader();
      const chunks = [];
      let done = false;
      while (!done) {
        const { value, done: d } = await reader.read();
        done = d;
        if (value) chunks.push(value);
      }
      const all = new Uint8Array(chunks.reduce((a, c) => a + c.length, 0));
      let offset = 0;
      for (const c of chunks) { all.set(c, offset); offset += c.length; }
      return new TextDecoder().decode(all);
    } catch (e) {
      console.error('gzip decompress failed:', e);
      return null;
    }
  }
  
  // Not gzipped
  return new TextDecoder().decode(uint8);
}

export default async (req) => {
  const url = new URL(req.url);
  const host = req.headers.get('host') || '';

  // 1) Health (Bunny/Cloudflare probes)
  if (url.pathname === '/health' || url.pathname === '/health.php') {
    return new Response('OK', {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    });
  }

  // 2) EPG — fetch upstream, cache 4h on edge, never redirect
  if (url.pathname.startsWith('/epg/') || url.pathname === '/epg.xml' || url.pathname === '/xmltv.php') {
    const xml = await fetchEpg();
    if (xml && xml.trim().startsWith('<')) {
      return new Response(xml, {
        status: 200,
        headers: {
          'content-type': 'application/xml',
          'cache-control': 'public, max-age=14400, s-maxage=14400',
        },
      });
    }
    return new Response('EPG unavailable', { status: 503 });
  }

  // 3) Host gate — deny unknown hosts
  if (!await isAllowedHost(host)) {
    return new Response('403 host not allowed', { status: 403 });
  }

  // 4) 302 redirect, path + query preserved (same contract as bridge)
  const dest = UPSTREAM + url.pathname + url.search;
  return Response.redirect(dest, 302);
};