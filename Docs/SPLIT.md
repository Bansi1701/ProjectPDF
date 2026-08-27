# Track ownership

This table is the contract between the shell/crawler work and the page/content work. Do not edit a file owned by the other track without agreeing on the change first.

| File | Owner | Rule |
| --- | --- | --- |
| `frontend/astro.config.mjs`, `frontend/package.json` | Track A | Dependencies and integrations land here only. |
| `frontend/src/layouts/BaseLayout.astro` | Track A | All head tags; Track B consumes them through props. |
| `frontend/src/components/Masthead.astro` | Track A | Site-wide navigation. |
| `frontend/src/pages/index.astro` | Track A | Homepage and footer columns. |
| `frontend/src/lib/seo.ts`, `frontend/src/components/Seo.astro` | Track A | Track B calls these and never edits them after the contract commit. |
| `frontend/public/robots.txt`, `frontend/public/og/` | Track A | Crawler and share-card assets. |
| `frontend/src/components/PdfTool.astro` | Track B | Track B alone owns this file. |
| `frontend/src/content/tools/*` | Track B | All per-tool copy. |
| `frontend/src/pages/how-to/*`, `frontend/src/pages/vs/*`, legal pages | Track B | New routes and their copy. |
| `frontend/src/components/Breadcrumbs.astro`, `frontend/src/components/ToolFooter.astro` | Track B | Tool-page components. |
| `frontend/src/config/site.ts` | Contract | Frozen after this contract. A later change requires both tracks. |

Branch prefixes are `seo/*` for Track A and `pages/*` for Track B. Keep one concern per commit and do not add AI attribution or co-author trailers.
