# Frontend

Astro static site. All PDF processing will run here, in the browser.

## Run

```bash
npm install
npm run dev      # http://localhost:4321
npm run build    # -> dist/
npm run preview
```

## Structure

```
src/
├── components/   # UI pieces (Logo, ComingSoon)
├── config/       # site.ts — brand name, tool list
├── layouts/      # BaseLayout.astro — <head>, meta tags
├── pages/        # one file = one route
└── styles/       # global.css — design tokens
public/           # served as-is (favicon)
```

## Notes

- `output: 'static'` — no server rendering. Deploys to any CDN.
- Change the brand name and tool list in `src/config/site.ts`.
- PDF libraries (`pdf.js`, `pdf-lib`) are not installed yet. They come with the first tool.
