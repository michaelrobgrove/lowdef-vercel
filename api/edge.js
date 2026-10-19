// api/edge.js — Vercel Edge Function: 302 relay + resilient EPG cache
// Replaces the ARRR + DAVY StrongBox bridge.
// Edge runtime (export const config below) — uses Web Request/Response APIs.
//
// Behavior:
//   /health*         -> 200 OK (origin probes, any host)
//   /epg/* /epg.xml /xmltv.php -> cached XML from myepg.top token URL
//                                (4h KV cache; serve stale on failure;
//                                 3 consecutive failures -> direct source fallback)
//   unknown host     -> 403
//   everything else  -> 302 http://usethisserver.link + path + query (bridge contract)

export const config = { runtime: 'edge' };

// Customer-facing domains: apex + ALL subdomains allowed.
const ALLOWED_DOMAINS = [
  'lowdefpirate.link',   // apex, ship, cove, inlet, legacy, *.lowdefpirate.link
  'tfplus.stream',       // reseller zone (Cloudflare) — subdomains allowed
  'northernsea.net',     // reseller zone (Cloudflare) — subdomains allowed
  'usethisserver.link',
];
const UPSTREAM = 'http://usethisserver.link';
const EPG_SRC = 'https://myepg.top/dl/ZYxXtj2qH/'; // token URL; 20 fetches/day limit -> cache hard
const CACHE_TTL = 14400;        // 4h seconds
const STALE_MAX_AGE = 604800;   // serve stale up to 7d on failure
const MAX_FAILURES = 3;

const KV_KEYS = { epg: 'epg:xml', fetchedAt: 'epg:fetchedAt', failures: 'epg:failures' };

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;

// --- Upstash REST (documented call shapes) -------------------------------
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
  // POST /set with ["key","value"] body (value too large for URL path)
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

// --- host gate -----------------------------------------------------------
function isAllowedHost(host) {
  if (!host) return false;
  const h = host.toLowerCase();
  return ALLOWED_DOMAINS.some(d => h === d || h.endsWith('.' + d));
}

// --- EPG -----------------------------------------------------------------
function isValidXml(text) {
  if (!text) return false;
  const t = text.trim();
  // real guide: <?xml ...> or <tv ...>; HTML error pages start <!DOCTYPE
  return t.startsWith('<?xml') || t.startsWith('<tv');
}

async function fetchEpgFromSource() {
  // source serves gzip regardless of Accept-Encoding -> detect + decompress
  const res = await fetch(EPG_SRC, {
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
    console.error('epg decompress failed:', e);
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
    const xml = await fetchEpgFromSource();
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

  if (validCached && age < CACHE_TTL * 1000) return serveXml(validCached, 'HIT');

  const fresh = await fetchEpgFromSource();
  if (fresh && isValidXml(fresh)) {
    await kvSet(KV_KEYS.epg, fresh);
    await kvSet(KV_KEYS.fetchedAt, now.toString());
    await kvSet(KV_KEYS.failures, '0');
    return serveXml(fresh, 'MISS');
  }

  // source failed (rate limit / outage): keep counter, serve stale
  const newFailures = failureCount + 1;
  await kvSet(KV_KEYS.failures, String(newFailures));

  if (validCached) {
    return serveXml(validCached, newFailures >= MAX_FAILURES ? 'STALE-FALLBACK' : 'STALE');
  }

  // no cached copy + repeated failure -> one more direct attempt
  if (newFailures >= MAX_FAILURES) {
    const retry = await fetchEpgFromSource();
    if (retry && isValidXml(retry)) return serveXml(retry, 'DIRECT');
  }

  return serveText(503, 'EPG unavailable - source returned invalid data', 'INVALID');
}

// --- main ----------------------------------------------------------------
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
