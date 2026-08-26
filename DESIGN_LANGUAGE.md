# PDFCraft Design Language

The shared interface system for PDFCraft. Use this document and the accompanying PDFCraft Design Language reference for every new page, component, and tool.

## Product direction

PDFCraft is a private document studio: calm, precise, and visibly browser-side. It must not resemble a dense, generic file-conversion dashboard. Use white or deep-slate space, strong typography, restrained rose actions, document previews, and honest processing disclosures.

## Tokens

| Role | Light | Dark |
|---|---|---|
| Canvas | `#F8FAFC` | `#0B0F17` |
| Surface | `#FFFFFF` | `#151D2A` |
| Primary action | `#E11D48` | `#FB7185` |
| Primary hover | `#BE123C` | `#F43F5E` |
| Primary text | `#0F172A` | `#F1F5F9` |
| Muted text | `#64748B` | `#94A3B8` |
| Border | `#E2E8F0` | `#1E293B` |

- Brand and headings: Plus Jakarta Sans, 600-700.
- Interface and body: Inter, 400-600.
- Spacing: 4, 8, 12, 16, 24, 32px.
- Cards: 16px corners; buttons and badges: 12px; tags: full pill.
- Elevation: one subtle `0 1px 3px rgba(0,0,0,.05)` shadow with a 1px border.

Use semantic CSS variables in shared styles; do not place raw colours or one-off spacing values in individual components.

## Page rules

1. Header: logo and wordmark left; category navigation centred; theme control and sign-in right.
2. Home: strong search-first hero, then a responsive bento grid of tools.
3. Tool cards: category marker, meaningful icon, title, outcome-oriented description, and a restrained 4px hover lift.
4. Tool workflow: explain -> choose files -> show page thumbnails -> select operation settings -> preview result -> download.
5. Footer: grouped links, language control, and compact legal/copyright information.

## Tool requirements

- Drag-and-drop must also have a keyboard-accessible "Select files" action.
- State supported formats beside the dropzone when relevant.
- Reveal page count and up to 12 previews after file selection.
- Make Split, Reorder, Delete, Extract, and Rotate choices visible before processing.
- Show a processed preview before saving whenever practical.
- Local tools finish with a receipt containing page count, duration, and "0 bytes sent".
- Server tools disclose the transfer before the user selects a file.

## Interaction, accessibility, and review

- Persist theme choice in `localStorage`; otherwise respect system preference.
- Search filters tool cards live and announces no results.
- Use 160-220ms ease-out motion and honour `prefers-reduced-motion`.
- Maintain AA contrast, visible focus, semantic headings, labels, and live status/error messages.
- Test mobile (320px), keyboard navigation, light/dark modes, empty/loading/error/success states, and build output before release.

## Governance

If a reusable visual or interaction decision changes, update both this file and the shared token implementation. A feature exception is acceptable only when documented; repeated exceptions become system rules.
