# DOMAIN SETUP (user action — you set these, not Vercel CLI)
# After pushing repo and deploying via Vercel dashboard or vercel deploy,
# point these records at legacy.lowdefpirate.link (Vercel apex).
#
# APEX (Bunny NS — lowdefpirate.link):
#   A 154.12.116.86 -> point A to Vercel CNAME target for legacy.lowdefpirate.link
#   OR keep Bunny in front and proxy; simpler: A -> vercel CNAME IP / CNAME at Bunny.
#
# SHIP / COVE (Bunny managed hostnames):
#   CNAME ship.lowdefpirate.link -> legacy.lowdefpirate.link
#   CNAME cove.lowdefpirate.link -> legacy.lowdefpirate.link
#
# RESELLER ZONES (Cloudflare NS — tfplus.stream, northernsea.net):
#   CNAME @ / apex -> legacy.lowdefpirate.link  (full proxy, orange cloud OK)
#
# Legacy domain lives ONLY on Vercel. No ARRR/DAVY needed after cutover.
# Confirm EPG 4h cache + 302 contract + host gate before switching Bunny A.
