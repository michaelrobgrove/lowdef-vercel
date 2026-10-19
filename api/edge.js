// api/edge.js — Vercel Edge Function (standalone, no Next build)
// Replaces the ARRR + DAVY StrongBox bridge.
// Deploy: import repo into Vercel (or `vercel --prod`), set custom domains.

const ALLOWED_HOSTS = [
  'legacy.lowdefpirate.link',
  'ship.lowdefpirate.link',
  'cove.lowdefpirate.link',
  'inlet.lowdefpirate.link',
  '*.lowdefpirate.link',   // wildcard: any lowdefpirate.link sub
  'tfplus.stream',
  'northernsea.net',
  'usethisserver.link',
];
const UPSTREAM = 'http://usethisserver.link';
const EPG_SRC = 'https://myepg.top/dl/ZYxXtj2qH/'; // token URL (30s expiry) — edge fetches fresh on MISS

async function isAllowedHost(host) {
  if (!host) return false;
  if (ALLOWED_HOSTS.includes(host)) return true;
  if (host.endsWith('.lowdefpirate.link')) return true;
  return false;
}

// fetch EPG with redirect follow + gzip decompression
async function fetchEpg() {
  // First request to token URL (follows 302 automatically in Edge)
  const res = await fetch(EPG_SRC, {
    cf: { cacheTtl: 14400 },
    redirect: 'follow'
  }).catch(() => null);
  
  if (!res || !res.ok) return null;
  
  // Response is gzipped — decompress using built-in decompression
  // Edge runtime automatically decompresses if Accept-Encoding not set
  // But the download URL serves raw gzip — need manual decompression
  const arrayBuffer = await res.arrayBuffer();
  const uint8 = new Uint8Array(arrayBuffer);
  
  // Check if it's gzipped (magic bytes 0x1f 0x8b)
  if (uint8.length >= 2 && uint8[0] === 0x1f && uint8[1] === 0x8b) {
    // Decompress using DecompressionStream (Edge supports this)
    try {
      const blob = new Blob([uint8], { type: 'application/gzip' });
      const decompressed = await new Response(blob).body
        .pipeThrough(new DecompressionStream('gzip'))
        .getReader()
        .read();
      // Convert to text
      const decoder = new TextDecoder();
      return decoder.decode(decompressed.value);
    } catch (e) {
      console.error('gzip decompress failed:', e);
      return null;
    }
  }
  
  // Already text
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

  // 2) EPG — fetch upstream token URL, cache 4h on the edge, never redirect
  if (url.pathname.startsWith('/epg/') || url.pathname === '/epg.xml' || url.pathname === '/xmltv.php') {
    const xml = await fetchEpg();
    if (xml) {
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