// api/edge.js — Vercel Edge function (replaces bridge)
export const config = { runtime: 'edge', regions: ['cdg1','iad1'] };

const ALLOWED_HOSTS = [
  'legacy.lowdefpirate.link','ship.lowdefpirate.link','cove.lowdefpirate.link',
  '*.lowdefpirate.link','tfplus.stream','northernsea.net','usethisserver.link',
];
const UPSTREAM = 'http://usethisserver.link';
const EPG_SRC = process.env.MYEPG_URL || 'https://myepg.top/epg/guide.xml';

export default async (req) => {
  const url = new URL(req.url);
  // Health
  if (url.pathname === '/health') return new Response('OK', {status:200, headers:{'content-type':'text/plain'}});
  // EPG (cached 4h edge-cache via Cache-Control)
  if (url.pathname.startsWith('/epg/')) {
    const epg = await fetch(EPG_SRC, {cf:{cacheTtl:14400}}).catch(()=>null);
    return epg ? new Response(epg.body, {status:200, headers:{'content-type':'application/xml','cache-control':'max-age=14400'}}) : new Response('EPG unavailable', {status:503});
  }
  // Host gate (replicate bridge deny for unknown hosts)
  const host = req.headers.get('host') || '';
  const ok = ALLOWED_HOSTS.some(p => p.startsWith('*.') ? host.endsWith(p.slice(1)) : host === p);
  if (!ok) return new Response('403 host not allowed', {status:403});
  // 302 redirect (same contract as bridge)
  return Response.redirect(UPSTREAM + url.pathname + url.search, 302);
};
