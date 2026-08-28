# ProjectPDF Design Language

This is the shared visual and interaction contract for ProjectPDF. Use it for every new page, component, tool, and marketing surface. If a feature needs to break a rule, document the reason in its pull request and update this file if the exception becomes a pattern.

## 1. Product character

**Paper & Light** is our direction: a calm document workspace built from warm paper, legible ink, and carefully limited glass effects. It should feel precise and private, not like a generic file-conversion dashboard.

The product promise is visible in the interface:

- Files stay in the browser unless a tool explicitly says it needs a server.
- A user should always know what will happen before they select a file.
- Results should explain what changed and offer a clear next action.
- Calm, useful feedback beats decorative motion.

Do not imitate the dense red-card style common in PDF tools. One meaningful accent, generous whitespace, and document previews make the product recognisable.

## 2. Source of truth

The live tokens and shared primitives are in [`frontend/src/styles/global.css`](../frontend/src/styles/global.css). Components must use its semantic CSS variables instead of hard-coded colours, shadows, spacing, or radii.

When a token is missing, add a semantic token to `global.css` first. Do not add a one-off hex value to a component.

## 3. Core tokens

| Purpose | Token | Use |
|---|---|---|
| Canvas | `--paper` | Main page background |
| Raised surface | `--paper-raised` | Cards, forms, tool workspaces |
| Recessed surface | `--paper-sunk` | Result areas and grouped controls |
| Primary text | `--ink` | Headings and key labels |
| Secondary text | `--ink-2` | Supporting body copy |
| Quiet text | `--muted` | Metadata and captions only |
| Primary action | `--accent` | Main actions and focus ring |
| Status | `--ok` | Successful local processing only |
| Warning/error | `--seal` | Errors and irreversible actions |
| Server disclosure | `--disclose` | Any feature that sends data away |
| Borders | `--line`, `--line-strong` | Surface separation and active fields |
| Surface elevation | `--shadow-paper` | Paper cards only |
| Card corner | `--radius` | Default cards and fields |

Use `--accent` for one primary action per local area. Green is a status colour, never a second call-to-action. `--disclose` is reserved for transparent server warnings.

## 4. Typography and content

- Use `--font-sans` for all interface text and `--font-mono` for measurements, job receipts, and technical facts.
- Use the fluid `--step-*` scale. Do not introduce arbitrary font sizes unless a component needs an icon-sized label.
- Headings are short, direct, and sentence case: “Split PDF”, not “THE BEST PDF SPLITTER”.
- Body copy explains the outcome first, then the mechanism: “Creates separate PDFs from your selected ranges. Processing stays in this tab.”
- Avoid hype, unexplained claims, and faux security badges.

## 5. Layout and spacing

- Use `.wrap` for page-level content. Never invent a competing max-width.
- Use the existing gutter and a simple 8px rhythm: 8, 16, 24, 32, 48, 64px.
- Tool pages have three clear states: introduction, workspace, result. Keep them vertically ordered.
- Desktop grids may expand; touch targets and fields must remain comfortable at mobile widths.
- Mobile is not a reduced version of desktop: place the primary action before secondary controls, and keep file details readable without horizontal scrolling.

## 6. Shared components

### Header and navigation

- Keep navigation quiet and let the current tool or primary task lead.
- The logo mark is used at 28–32px in the header, 48–64px for app/browser contexts, and 512px for source export. Keep clear space equal to one-quarter of the mark width.
- Pair the mark with the wordmark **ProjectPDF** until a formal product rename is approved.
- Theme controls must respect the system preference by default and persist an explicit user choice.

### Cards

- Use `.sheet` for ordinary cards: paper texture, 1px border, and `--shadow-paper`.
- A card has one clear job: navigation, an explanation, or a result. Do not make every card interactive.
- Hover elevation is subtle: a 1–2px lift and a softer shadow. Never use bouncy or continuous card movement.
- Labels such as “in your browser” are trust information, not decorative badges.

### Buttons and fields

- Use `.btn--primary` for the one action that moves the user forward and `.btn--quiet` for secondary actions.
- Buttons must have text labels. Icons can support a label but cannot replace an unfamiliar action.
- Inputs need visible labels, clear examples, helpful constraints, and error text beside the action that caused it.
- Preserve the global `:focus-visible` treatment. Never remove keyboard focus.

### Tool workspace

Every PDF tool should follow this sequence:

1. Explain the operation and where the file is processed.
2. Provide a drag-and-drop zone and a keyboard-accessible file chooser.
3. Show selected files, their page count when known, and a lightweight page preview.
4. Ask only for the operation-specific choices, such as ranges, rotation, watermark text, or order.
5. Show the processed preview before the download action whenever practical.
6. Present a concise result receipt: pages, duration, and `0 bytes sent` for local tools.

Use page thumbnails to make page-based choices understandable. Show at most 12 initial thumbnails, then clearly state when more pages exist.

### Errors and empty states

- Say what went wrong and how to recover: “Page 14 is outside this 12-page PDF. Choose a page from 1 to 12.”
- Do not expose stack traces, internal library names, or raw exceptions.
- Empty states must point to the next useful action, not just state that nothing exists.

## 7. Motion and feedback

- Motion is optional enhancement. Honour `prefers-reduced-motion`.
- Use 160–220ms ease-out for hover and button feedback.
- Use a short, visible processing state for file work. Never leave a disabled button without context.
- Scroll reveals should improve hierarchy, never hide content or delay usability.

## 8. Accessibility and privacy

- Meet WCAG AA contrast for text, controls, and focus indicators.
- Use semantic landmarks, heading order, labels, and live regions for asynchronous processing status.
- Never rely on colour alone for warnings, selected state, or success.
- State whether a tool runs locally or needs a server before file selection. Server tools must state what is sent and why.
- Never display file contents, filenames, or document text in analytics or telemetry.

## 9. Design review checklist

Before merging a UI change, check all of the following:

- [ ] Uses global semantic tokens; no one-off colour or spacing values.
- [ ] Works at mobile, tablet, and desktop widths.
- [ ] Has keyboard focus, labels, and useful status/error messages.
- [ ] Preserves dark-mode compatibility.
- [ ] Has a single obvious primary action.
- [ ] Explains privacy behaviour before file selection.
- [ ] Uses restrained motion and honours reduced-motion preferences.
- [ ] For tool output, shows a result preview or clearly explains why a preview is not available.
- [ ] Builds successfully with `npm run build`.

## 10. Updating this language

Treat this as a living system. A reusable decision belongs here and in `global.css`; a one-off exception belongs in the feature discussion. When changing a token or shared primitive, test one homepage card, one tool workspace, one result state, and both colour themes before release.
