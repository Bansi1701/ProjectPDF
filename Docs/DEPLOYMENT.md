# Deployment

The site is static, so any host that runs `npm run build` and serves a folder
will work. [TECH_STACK.md](TECH_STACK.md) picks **Cloudflare Pages**, and the
reason is bandwidth: a single OCR session pulls a tesseract core (~4.5 MB), its
language data (~2 MB) and the pdf.js renderer. Cloudflare's egress is free;
GitHub Pages has a 100 GB/month soft limit and a terms-of-service line
discouraging sites run as a business, which matters once ads are on.

Both hosts deploy on push to `main`. That is not the difference between them.

## Cloudflare Pages (intended host)

One-time setup, in the Cloudflare dashboard:

1. **Workers & Pages → Create → Pages → Connect to Git**, and pick the
   `Bansi1701/ProjectPDF` repository.
2. Build settings:

   | Setting | Value |
   | --- | --- |
   | Production branch | `main` |
   | Root directory | `frontend` |
   | Build command | `npm run build` |
   | Build output directory | `dist` |

3. **Settings → Environment variables → Production**, add
   `SITE_ORIGIN = https://filozy.com`. Optionally `INDEXNOW_KEY`,
   `PUBLIC_GOOGLE_SITE_VERIFICATION`, `PUBLIC_BING_SITE_VERIFICATION` — the same
   variables the GitHub workflow reads, documented in `frontend/.env.example`.
4. **Custom domains → Set up a domain → `filozy.com`**. If the domain's
   nameservers point at Cloudflare, the DNS record is created for you; add
   `www.filozy.com` too so it redirects to the apex.

After that, every push to `main` builds and deploys. Preview deployments are
built for other branches and pull requests.

### Response headers

`frontend/public/_headers` sets caching and security headers. Cloudflare reads
it; GitHub Pages ignores it, so it is safe to ship from either. Content-hashed
`/_astro/*` is immutable for a year; engine payloads keep fixed filenames so
they get a month; HTML always revalidates, so a deploy is visible immediately.

It deliberately sets no `Cross-Origin-Opener-Policy` or
`Cross-Origin-Embedder-Policy` — cross-origin isolation is banned repo-wide.
`Permissions-Policy` keeps `camera=(self)` because Scan to PDF needs it.

### Verify after the first deploy

- `https://filozy.com/robots.txt` names `https://filozy.com/sitemap-index.xml`
  — if it still says `github.io`, `SITE_ORIGIN` is not set.
- Any tool page's canonical points at `filozy.com`.
- `sitemap-0.xml` carries varied `lastmod` dates. The dates come from
  `git log` per file, so a shallow clone would flatten them all to one date or
  drop them; if that happens, raise the build's clone depth.
- A tool still runs: choose a file, check the receipt reports 0 document bytes.

## GitHub Pages (current host)

`.github/workflows/deploy.yml` builds and publishes to
`bansi1701.github.io/ProjectPDF` on every push to `main`.

**Do not set `SITE_ORIGIN` as a GitHub repository variable while Cloudflare is
the live host.** It would rebuild the github.io copy with `base: '/'`, and that
site is served from `/ProjectPDF/` — every asset path would break. Cloudflare
reads its own copy of the variable from its own dashboard.

Once filozy.com is serving, this workflow can be disabled
(**Actions → Deploy site to GitHub Pages → Disable workflow**) or left running
as a warm spare. Leaving it on costs nothing and changes nothing on the domain.

## Backend

Not deployed. The one server-side tool (Web page to PDF) is dormant: the
frontend gates on `PUBLIC_API_URL`, which is unset, so the build strips the
call entirely. See [TECH_STACK.md](TECH_STACK.md) for the container-host plan
when it does ship.
