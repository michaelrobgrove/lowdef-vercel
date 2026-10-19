// api/edge.js — Vercel Edge Function: 302 relay + resilient EPG cache
// Replaces the ARRR + DAVY StrongBox bridge.
// Edge runtime (export const config below) — uses Web Request/Response APIs.
//
// Behavior:
//   /health*         -> 200 OK (origin probes, any host)
//   /epg/* /epg.xml /xmltv.php -> EPG served locally, NEVER redirected:
//        1. myepg.top token URL (primary, 20/day limit -> hard 4h cache)
//        2. on failure: serve stale cache (up to 7d)
//        3. 3 consecutive primary failures -> provider EPG
//           (UPSTREAM_EPG_URL: usethisserver.link /xmltv.php with creds)
//   unknown host     -> 403
//   everything else  -> 302 http://usethisserver.link + path + query (bridge contract)

export const config = { runtime: 'edge' };

// Customer-facing domains: apex + ALL subdomains allowed.
const ALLOWED_DOMAINS = [
  'lowdefpirate.link',   // apex, ship, cove, inlet, legacy
  'tfplus.stream',       // reseller zone (Cloudflare)
  'northernsea.net',     // reseller zone (Cloudflare)
  'usethisserver.link',
];
const UPSTREAM = 'http://usethisserver.link';
const PRIMARY_EPG = 'https://myepg.top/dl/ZYxXtj2qH/'; // token URL; 20/day -> cache hard
const CACHE_TTL = 14400;        // 4h seconds
const STALE_MAX_AGE = 604800;   // serve stale up to 7d on failure
const MAX_FAILURES = 3;

const KV_KEYS = { epg: 'epg:xml', fetchedAt: 'epg:fetchedAt', failures: 'epg:failures' };

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
// Provider EPG (users source) — set in Vercel project env (creds never in git)
const FALLBACK_EPG = process.env.UPSTREAM_EPG_URL || '';

// --- Upstash REST ---------------------------------------------------------
async function kvGet(key) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return null;
  const res = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
  }).catch(() => null);
  if (!res || !res.ok) return null;
  const data = await res.json().catch(() => null);
  return data?.result ?? null;
}

async function kvSet(key, value) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return false;
  const res = await fetch(`${UPSTASH_URL}/set`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify([key, value]),
  }).catch(() => null);
  return res?.ok ?? false;
}

async function kvDel(key) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return false;
  const res = await fetch(`${UPSTASH_URL}/del/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
  }).catch(() => null);
  return res?.ok ?? false;
}

// --- host gate -------------------------------------------------------------
function isAllowedHost(host) {
  if (!host) return false;
  const h = host.toLowerCase();
  return ALLOWED_DOMAINS.some(d => h === d || h.endsWith('.' + d));
}

// --- EPG -------------------------------------------------------------------
function isValidXml(text) {
  if (!text) return false;
  const t = text.trim();
  // real guide: <?xml ...> or <tv ...>; HTML error pages start <!DOCTYPE
  return t.startsWith('<?xml') || t.startsWith('<tv');
}

// Fetch a guide URL: follows redirects, handles gzip (both sources serve gzip)
async function fetchGuide(url) {
  const res = await fetch(url, {
    redirect: 'follow',
    headers: { 'Accept-Encoding': 'gzip' },
  }).catch(() => null);
  if (!res || !res.ok) return null;

  const buf = new Uint8Array(await res.arrayBuffer());
  const isGzip = buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b;
  if (!isGzip) return new TextDecoder().decode(buf);

  try {
    const ds = new DecompressionStream('gzip');
    const w = ds.writable.getWriter();
    w.write(buf); w.close();
    const r = ds.readable.getReader();
    const parts = [];
    for (;;) { const { value, done } = await r.read(); if (done) break; parts.push(value); }
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
    return new TextDecoder().decode(out);
  } catch (e) {
    console.error('guide decompress failed:', e);
    return null;
  }
}

function serveXml(xml, cacheStatus) {
  return new Response(xml, {
    status: 200,
    headers: {
      'content-type': 'application/xml',
      'cache-control': `public, max-age=${CACHE_TTL}, s-maxage=${CACHE_TTL}, stale-while-revalidate=${STALE_MAX_AGE}`,
      'x-epg-cache': cacheStatus,
    },
  });
}

function serveText(status, msg, cacheStatus) {
  return new Response(msg, {
    status,
    headers: { 'content-type': 'text/plain', 'x-epg-cache': cacheStatus },
  });
}

async function handleEpg() {
  // No KV -> direct fetch only (never cache garbage)
  if (!UPSTASH_URL || !UPSTASH_TOKEN) {
    const xml = await fetchGuide(PRIMARY_EPG);
    if (xml && isValidXml(xml)) return serveXml(xml, 'DIRECT-NO-KV');
    return serveText(503, 'EPG unavailable (no KV)', 'NO-KV');
  }

  const cachedXml = await kvGet(KV_KEYS.epg);
  const fetchedAt = await kvGet(KV_KEYS.fetchedAt);
  const failures = await kvGet(KV_KEYS.failures);

  // purge stale garbage (old HTML cached before strict validation)
  let validCached = cachedXml;
  if (cachedXml && !isValidXml(cachedXml)) {
    await kvDel(KV_KEYS.epg);
    validCached = null;
  }

  const now = Date.now();
  const age = now - (parseInt(fetchedAt, 10) || 0);
  const failureCount = parseInt(failures, 10) || 0;

  // fresh cache -> serve
  if (validCached && age < CACHE_TTL * 1000) return serveXml(validCached, 'HIT');

  // 1) PRIMARY: myepg.top token URL
  const primary = await fetchGuide(PRIMARY_EPG);
  if (primary && isValidXml(primary)) {
    await kvSet(KV_KEYS.epg, primary);
    await kvSet(KV_KEYS.fetchedAt, now.toString());
    await kvSet(KV_KEYS.failures, '0');
    return serveXml(primary, 'MISS');
  }

  // primary failed -> count the failure
  const newFailures = failureCount + 1;
  await kvSet(KV_KEYS.failures, String(newFailures));

  // 2) FAILBACK AFTER 3 STRIKES: provider EPG (users source)
  if (newFailures >= MAX_FAILURES && FALLBACK_EPG) {
    const fb = await fetchGuide(FALLBACK_EPG);
    if (fb && isValidXml(fb)) {
      // cache provider guide too -> users keep EPG while primary is rate-limited
      await kvSet(KV_KEYS.epg, fb);
      await kvSet(KV_KEYS.fetchedAt, now.toString());
      return serveXml(fb, 'FALLBACK');
    }
  }

  // serve whatever valid stale copy we have
  if (validCached) {
    return serveXml(validCached, newFailures >= MAX_FAILURES ? 'STALE-FALLBACK' : 'STALE');
  }

  return serveText(503, 'EPG unavailable - all sources failed', 'INVALID');
}

// --- main ------------------------------------------------------------------
export default async (req) => {
  try {
    const url = new URL(req.url);
    // Host header is what the client sent (gate on it); url.host fallback
    const host = (req.headers.get('host') || url.host || '').toLowerCase();

    // debug (no secrets leaked: booleans only)
    if (url.pathname === '/debug') {
      return new Response(JSON.stringify({
        host,
        runtime: config.runtime,
        kvUrl: !!UPSTASH_URL,
        kvToken: !!UPSTASH_TOKEN,
        fallbackEpg: !!FALLBACK_EPG,
        allowed: isAllowedHost(host),
      }, null, 2), { status: 200, headers: { 'content-type': 'application/json' } });
    }

    // health: any host, before gate (origin probes may send any Host)
    if (url.pathname === '/health' || url.pathname === '/health.php') {
      return new Response('OK', { status: 200, headers: { 'content-type': 'text/plain' } });
    }

    // EPG: served locally from cache, NEVER redirected (token stays hidden)
    if (url.pathname.startsWith('/epg/') || url.pathname === '/epg.xml' || url.pathname === '/xmltv.php') {
      return await handleEpg();
    }

    // host gate: deny scanners/unknown hosts
    if (!isAllowedHost(host)) {
      return serveText(403, '403 host not allowed', 'HOST-GATE');
    }

    // bridge contract: path + query preserving 302 to upstream
    return Response.redirect(UPSTREAM + url.pathname + url.search, 302);
  } catch (e) {
    console.error('edge error:', e);
    return serveText(500, 'Internal error', 'ERROR');
  }
};
