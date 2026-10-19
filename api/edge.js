// api/edge.js — Vercel Edge Function with resilient EPG caching via Upstash Redis REST
// Simplified: no DecompressionStream (Edge may not support), fetch with identity encoding
// Only caches valid XML responses (starts with '<?xml' or '<tv')

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
const CACHE_TTL = 14400;
const STALE_MAX_AGE = 86400 * 7;
const MAX_FAILURES = 3;

const KV_KEYS = {
  epg: 'epg:xml',
  fetchedAt: 'epg:fetchedAt',
  failures: 'epg:failures',
};

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;

async function kvGet(key) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return null;
  const res = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(key)}`, {
    headers: { 'Authorization': `Bearer ${UPSTASH_TOKEN}` },
  }).catch(() => null);
  if (!res || !res.ok) return null;
  const data = await res.json().catch(() => null);
  return data?.result ?? null;
}

async function kvSet(key, value) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return false;
  const res = await fetch(`${UPSTASH_URL}/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${UPSTASH_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify([value]),
  }).catch(() => null);
  return res?.ok ?? false;
}

async function kvDel(key) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return false;
  const res = await fetch(`${UPSTASH_URL}/del/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${UPSTASH_TOKEN}` },
  }).catch(() => null);
  return res?.ok ?? false;
}

function isAllowedHost(host) {
  if (!host) return false;
  if (ALLOWED_HOSTS.includes(host)) return true;
  if (host.endsWith('.lowdefpirate.link')) return true;
  return false;
}

function isValidXml(text) {
  if (!text) return false;
  const t = text.trim();
  return t.startsWith('<?xml') || t.startsWith('<tv');
}

async function fetchEpgFromSource() {
  // Request identity encoding to avoid gzip issues
  const res = await fetch(EPG_SRC, {
    redirect: 'follow',
    headers: { 'Accept-Encoding': 'identity' },
  }).catch(() => null);
  
  if (!res || !res.ok) return null;
  
  return await res.text();
}

function serveXml(xml, cacheStatus) {
  return new Response(xml, {
    status: 200,
    headers: {
      'content-type': 'application/xml',
      'cache-control': `public, max-age=${CACHE_TTL}, s-maxage=${CACHE_TTL}, stale-while-revalidate=${STALE_MAX_AGE}`,
      'x-vercel-cache': cacheStatus,
    },
  });
}

function serveError(status, msg, cacheStatus) {
  return new Response(msg, { status, headers: { 'content-type': 'text/plain', 'x-vercel-cache': cacheStatus } });
}

export default async (req) => {
  try {
    const url = new URL(req.url);
    const host = req.headers.get('host') || '';

    // Health
    if (url.pathname === '/health' || url.pathname === '/health.php') {
      return new Response('OK', { status: 200, headers: { 'content-type': 'text/plain' } });
    }

    // EPG endpoints
    if (url.pathname.startsWith('/epg/') || url.pathname === '/epg.xml' || url.pathname === '/xmltv.php') {
      // No KV configured - direct fetch only
      if (!UPSTASH_URL || !UPSTASH_TOKEN) {
        const directXml = await fetchEpgFromSource();
        if (directXml && isValidXml(directXml)) return serveXml(directXml, 'DIRECT-NO-KV');
        return serveError(503, 'EPG unavailable (no KV)', 'NO-KV');
      }
      
      // Read KV state
      const [cachedXml, fetchedAt, failures] = await Promise.all([
        kvGet(KV_KEYS.epg),
        kvGet(KV_KEYS.fetchedAt),
        kvGet(KV_KEYS.failures).catch(() => 0),
      ]);
      
      // Clear invalid cached data (HTML error pages)
      let validCachedXml = cachedXml;
      if (cachedXml && !isValidXml(cachedXml)) {
        await kvDel(KV_KEYS.epg);
        validCachedXml = null;
      }
      
      const now = Date.now();
      const fetchedAtMs = fetchedAt ? parseInt(fetchedAt, 10) : 0;
      const age = now - fetchedAtMs;
      const isFresh = validCachedXml && age < CACHE_TTL * 1000;
      const failureCount = parseInt(failures, 10) || 0;
      
      if (isFresh) {
        return serveXml(validCachedXml, 'HIT');
      }
      
      // Fetch fresh
      const freshXml = await fetchEpgFromSource();
      
      if (freshXml && isValidXml(freshXml)) {
        await Promise.all([
          kvSet(KV_KEYS.epg, freshXml),
          kvSet(KV_KEYS.fetchedAt, now.toString()),
          kvSet(KV_KEYS.failures, '0'),
        ]);
        return serveXml(freshXml, 'MISS');
      }
      
      // Fetch failed
      const newFailures = failureCount + 1;
      await kvSet(KV_KEYS.failures, newFailures.toString());
      
      if (validCachedXml) {
        const cacheStatus = newFailures >= MAX_FAILURES ? 'STALE-FALLBACK' : 'STALE';
        return serveXml(validCachedXml, cacheStatus);
      }
      
      if (newFailures >= MAX_FAILURES) {
        const directXml = await fetchEpgFromSource();
        if (directXml && isValidXml(directXml)) {
          return serveXml(directXml, 'DIRECT');
        }
      }
      
      return serveError(503, 'EPG unavailable - source returned invalid data', 'INVALID');
    }

    // Host gate
    if (!isAllowedHost(host)) {
      return serveError(403, '403 host not allowed', 'HOST-GATE');
    }

    // 302 redirect
    const dest = UPSTREAM + url.pathname + url.search;
    return Response.redirect(dest, 302);
    
  } catch (e) {
    console.error('Edge function error:', e);
    return serveError(500, 'Internal error', 'ERROR');
  }
};