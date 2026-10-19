// api/edge.js — Vercel Edge Function with resilient EPG caching via Upstash Redis
// Only caches valid XML responses (starts with '<')
// Uses Upstash Redis REST via @vercel/kv createClient

import { createClient } from '@vercel/kv';

const kv = createClient({
  url: process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN,
});

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

async function isAllowedHost(host) {
  if (!host) return false;
  if (ALLOWED_HOSTS.includes(host)) return true;
  if (host.endsWith('.lowdefpirate.link')) return true;
  return false;
}

function isValidXml(text) {
  if (!text) return false;
  const t = text.trim();
  // Valid EPG XML starts with XML declaration or <tv root element
  return t.startsWith('<?xml') || t.startsWith('<tv');
}

async function fetchEpgFromSource() {
  const res = await fetch(EPG_SRC, {
    redirect: 'follow',
    headers: { 'Accept-Encoding': 'gzip' },
  }).catch(() => null);
  
  if (!res || !res.ok) return null;
  
  const arrayBuffer = await res.arrayBuffer();
  const uint8 = new Uint8Array(arrayBuffer);
  
  if (uint8.length >= 2 && uint8[0] === 0x1f && uint8[1] === 0x8b) {
    try {
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
  
  return new TextDecoder().decode(uint8);
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

export default async (req) => {
  const url = new URL(req.url);
  const host = req.headers.get('host') || '';

  if (url.pathname === '/health' || url.pathname === '/health.php') {
    return new Response('OK', { status: 200, headers: { 'content-type': 'text/plain' } });
  }

  if (url.pathname.startsWith('/epg/') || url.pathname === '/epg.xml' || url.pathname === '/xmltv.php') {
    try {
      const [cachedXml, fetchedAt, failures] = await Promise.all([
        kv.get(KV_KEYS.epg),
        kv.get(KV_KEYS.fetchedAt),
        kv.get(KV_KEYS.failures).catch(() => 0),
      ]);
      
      const now = Date.now();
      const fetchedAtMs = fetchedAt ? parseInt(fetchedAt, 10) : 0;
      const age = now - fetchedAtMs;
      const isFresh = cachedXml && isValidXml(cachedXml) && age < CACHE_TTL * 1000;
      const failureCount = parseInt(failures, 10) || 0;
      
      if (isFresh) {
        return serveXml(cachedXml, 'HIT');
      }
      
      const freshXml = await fetchEpgFromSource();
      
      if (freshXml && isValidXml(freshXml)) {
        await Promise.all([
          kv.set(KV_KEYS.epg, freshXml),
          kv.set(KV_KEYS.fetchedAt, now.toString()),
          kv.set(KV_KEYS.failures, '0'),
        ]);
        return serveXml(freshXml, 'MISS');
      }
      
      const newFailures = failureCount + 1;
      await kv.set(KV_KEYS.failures, newFailures.toString());
      
      // Only serve cached data if it's valid XML (not cached error page)
      if (cachedXml && isValidXml(cachedXml)) {
        const cacheStatus = newFailures >= MAX_FAILURES ? 'STALE-FALLBACK' : 'STALE';
        return serveXml(cachedXml, cacheStatus);
      }
      
      // No valid cached data
      if (newFailures >= MAX_FAILURES) {
        const directXml = await fetchEpgFromSource();
        if (directXml && isValidXml(directXml)) {
          return serveXml(directXml, 'DIRECT');
        }
      }
      
      return new Response('EPG unavailable', { status: 503 });
      
    } catch (e) {
      console.error('EPG handler error:', e);
      const cachedXml = await kv.get(KV_KEYS.epg).catch(() => null);
      if (cachedXml && isValidXml(cachedXml)) return serveXml(cachedXml, 'ERROR-STALE');
      return new Response('EPG unavailable', { status: 503 });
    }
  }

  if (!await isAllowedHost(host)) {
    return new Response('403 host not allowed', { status: 403 });
  }

  const dest = UPSTREAM + url.pathname + url.search;
  return Response.redirect(dest, 302);
};