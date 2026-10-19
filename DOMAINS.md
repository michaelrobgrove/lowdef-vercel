# DOMAIN SETUP (user-side — Bunny/Cloudflare DNS + Vercel dashboard)

## Vercel dashboard (lowdef-vercel project)
- Settings -> Domains: legacy.lowdefpirate.link  (setup, shown correct)
- Settings -> Environment Variables:
  - UPSTASH_REDIS_REST_URL  (from Upstash: upstash-kv-charcoal-xylophone)
  - UPSTASH_REDIS_REST_TOKEN

## Bunny DNS (zone lowdefpirate.link)
  CNAME  legacy.lowdefpirate.link -> <vercel target>
  CNAME  ship.lowdefpirate.link   -> legacy.lowdefpirate.link
  CNAME  cove.lowdefpirate.link   -> legacy.lowdefpirate.link
  CNAME  inlet.lowdefpirate.link  -> legacy.lowdefpirate.link

## Cloudflare DNS (already CF zones)
  tfplus.stream     apex @ -> CNAME legacy.lowdefpirate.link (proxied)
  northernsea.net   apex @ -> CNAME legacy.lowdefpirate.link (proxied)

## Contract
  /health*        -> 200 any host
  /epg/* /epg.xml /xmltv.php -> cached guide.xml (4h Upstash cache, stale-serving)
  unknown host    -> 403
  everything else -> 302 http://usethisserver.link + path + query
