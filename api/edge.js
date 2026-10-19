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
  // exact match
  if (ALLOWED_HOSTS.includes(host)) return true;
  // wildcard *.lowdefpirate.link
  if (host.endsWith('.lowdefpirate.link')) return true;
  return false;
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
    const res = await fetch(EPG_SRC, { cf: { cacheTtl: 14400 } }).catch(() => null);
    if (res && res.ok) {
      const body = await res.text();
      return new Response(body, {
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