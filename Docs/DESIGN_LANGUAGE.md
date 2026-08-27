# PDFCraft Design Language v1.2

## Product direction
PDFCraft is a private document studio: calm, precise, and visibly browser-side. It must not resemble a dense, generic file-conversion dashboard. Use white or deep-slate space, strong typography, restrained rose actions, document previews, and honest processing disclosures.

## Tokens
- Canvas: #F8FAFC light / #0B0F17 dark
- Surface: #FFFFFF light / #151D2A dark
- Primary action: #E11D48 light / #FB7185 dark
- Text: #0F172A light / #F1F5F9 dark
- Muted: #64748B light / #94A3B8 dark
- Border: #E2E8F0 light / #1E293B dark
- Headings: Plus Jakarta Sans, 600-700. Interface: Inter, 400-600.
- Spacing: 4, 8, 12, 16, 24, 32px. Cards: 16px. Buttons/badges: 12px. Tags: full pill.

## Signature: Fold & Flow
A document is a living object moving through a precise, private workspace.
- The folded-page mark is the only branded illustration style.
- A thin curved fold line or cropped paper edge is a rare framing motif.
- Page thumbnails sit on a neutral document stage with an inset border.
- Rose marks action and active state only; never use a red navigation bar, red card wall, or large red upload hero.
- Dark mode uses a deep working surface with bright paper previews.

## Do-not-copy boundaries
Do not reproduce a competitor's tool-tile proportions, upload hero, copy, navigation grouping, icon treatment, or workflow. Build around PDFCraft's own sequence: document stage -> focused settings -> visible result -> save receipt.

## Tool identity system
Every live app has its own semantic Fold & Flow mark, rendered by `frontend/src/components/ToolIcon.astro`.
- Foundation: a rounded tile, an inset folded document, and one quiet curved flow line. This shared silhouette makes the set recognizable as ProjectPDF.
- Meaning: the foreground line drawing must communicate the actual operation. Do not use a generic letter when a merge, crop, lock, signature, table, or page relationship can be drawn.
- Colour is categorical, not decorative: orange Organize, green Optimize, gold Convert to PDF, blue Convert from PDF, magenta Edit & Compose, violet Review & Data, teal Secure & Archive.
- Icons are inline SVG so they stay sharp, inherit theme colours, and require no network request. They are decorative beside a visible tool name and therefore remain hidden from assistive technology.
- Use 52-56px marks on tool cards and 26-30px marks in menus. Never enlarge the small navigation mark as a substitute for the card treatment.
- New tools must add a unique semantic drawing to `ToolIcon.astro` and must be assigned to exactly one group in `frontend/src/config/navigation.ts` before they appear in discovery surfaces.

## Page and tool rules
1. Header: mark and wordmark left; categories centred; persistent theme control and sign-in right.
2. Home: search-first hero and responsive bento grid.
3. Tool cards: category marker, simple icon, title, outcome-oriented description, restrained 4px hover lift.
4. Tool workflow: explain -> choose files -> page thumbnails -> focused settings -> result preview -> save.
5. Drag-and-drop must include a keyboard-accessible Select files action.
6. Local tools finish with page count, duration, and 0 bytes sent. Server tools disclose transfer before file selection.

## Accessibility and quality
- Use semantic CSS variables; no one-off colours or spacing in components.
- Maintain AA contrast, visible focus, labels, semantic headings, and live status/error messages.
- Persist explicit theme choice in localStorage; otherwise respect system preference.
- Use 160-220ms ease-out motion and honour prefers-reduced-motion.
- Test 320px mobile, keyboard flow, both themes, empty/loading/error/success states, and result preview before release.

## Governance
Update this guide and shared tokens whenever a reusable visual or interaction decision changes. A repeated exception becomes a system rule. Review competitor pages only to identify patterns to avoid, never as a layout source.
