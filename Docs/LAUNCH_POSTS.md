# Launch posts — ready to paste

Off-site mentions are what move both search rankings and AI citations for a
new domain. These are the posts only a person can submit. Each is written to
lead with the one verifiable claim (0 document bytes sent) rather than an
adjective, and to be honest about limits — that is what gets upvoted and
quoted, and it is what the site itself does.

Replace `hatepdf.com` with the live domain before posting. Do not post the
same text in several places; adapt the framing to each audience.

---

## Show HN (news.ycombinator.com/submit)

**Title** (80 chars max):
`Show HN: HatePDF – 39 PDF tools that run in the browser, zero bytes uploaded`

**URL:** `https://hatepdf.com/`

**First comment** (post immediately after submitting):

> Hi HN. HatePDF is a free PDF toolkit — merge, split, compress, PDF↔Word/Excel/PowerPoint, OCR, redact, sign, encrypt, PDF/A — where every operation runs in a Web Worker in your browser. The file is read into memory, processed on your device, and saved locally. Nothing is uploaded; each job ends with a receipt showing document bytes sent: 0, and you can confirm it in the Network panel.
>
> Why build another one: the documents people put through PDF sites (contracts, IDs, medical records, bank statements) are exactly the ones that should not be uploaded, and "we delete it after an hour" is a description of a copy that shouldn't exist.
>
> What it does not do: certified digital signatures (needs a CA and timestamp — network by definition), team storage (it stores nothing), native apps. The only server-side feature — rendering a public URL to PDF — is marked not-live and involves no file of yours.
>
> Engineering notes people here might care about: pdf.js + pdf-lib + a HarfBuzz subsetter compiled to WASM, tesseract.js self-hosted with its IndexedDB cache disabled, no cross-origin isolation (separate Workers instead of SharedArrayBuffer — ~85% of the throughput, 100% of the compatibility), and a build that fails if any undocumented fetch/XHR or storage call appears in the code. The privacy page is generated from the same audit.
>
> Honest weak spots: PDF→Word on multi-column layouts, OCR is English-only for now, and a phone will run out of memory before a server does on a 500-page scan. Feedback on any of those is very welcome.

---

## Product Hunt

**Name:** HatePDF
**Tagline** (60 chars): `Free PDF tools that never upload your file`
**Topics:** Productivity, Privacy, Developer Tools, Design Tools

**Description:**

> Merge, split, compress, convert, OCR, sign, redact and encrypt PDFs — all inside your browser. HatePDF never receives your document: the operation runs on your device and the result saves locally. No account, no daily limit, no upload to "delete after an hour". 39 tools, and each one ends with a receipt showing document bytes sent: 0.

**First comment:** adapt the Show HN comment; drop the engineering paragraph, keep the "what it does not do" paragraph.

---

## AlternativeTo (alternativeto.net — "Add an app")

**Name:** HatePDF
**Short description:** `Free, browser-based PDF tools that process files on your device. Nothing is uploaded; no account; no daily limits.`
**Alternative to:** iLovePDF, Smallpdf, PDF24 Tools, Sejda, Adobe Acrobat online
**Tags:** pdf-tools, privacy-focused, no-registration, browser-based, merge-pdf, compress-pdf, pdf-editor, ocr
**Platforms:** Web

**Long description:**

> HatePDF is a PDF toolkit that runs entirely in the web browser. Every tool — merge, split, reorder, compress, PDF to Word/Excel/PowerPoint and back, JPG↔PDF, OCR, redact, sign, watermark, page numbers, Bates numbering, metadata, flatten, protect/unlock, repair, PDF/A — reads the file into browser memory, does the work in a Web Worker on your device, and saves the result locally. The site sets no cookies and loads no trackers, and each finished job shows a receipt with document bytes sent: 0. Free, no account, no quota. Not offered: certified digital signatures, cloud storage, native apps.

---

## Reddit — answer template

Only reply where the privacy property is genuinely the answer (someone asking
for a PDF tool that doesn't upload, is worried about a document's
confidentiality, or is asking whether iLovePDF/Smallpdf are safe). Answer the
question first; mention the site once; disclose that you built it. Never post
the same comment twice.

> Depends what "safe" means to you. iLovePDF and Smallpdf both upload the file to their servers, process it there, and state they delete it after a set time (Smallpdf says one hour; iLovePDF's security page gives a number of hours by account type). That's fine for a menu; it's a different question for a contract or an ID.
>
> If you'd rather the file never left the machine: I built HatePDF (hatepdf.com), which does the same jobs — merge/split/compress/convert/OCR/redact/encrypt — in the browser with no upload. You can verify it yourself: open DevTools → Network before choosing the file and watch; nothing the size of your document ever goes out, and the tool shows "document bytes sent: 0" after each job. Free, no account. Limits worth knowing: no certified e-signatures, and a phone can run out of memory on a huge scan.
>
> (Disclosure: it's my project.)

Good subreddits: r/privacy, r/pdf, r/selfhosted, r/degoogle, r/sysadmin,
r/smallbusiness, r/legaladvice (only where documents are the topic), r/india
for the desi-founder angle if the tone fits.

---

## GitHub README first paragraph (already applied)

> **HatePDF** — free PDF tools that run entirely in your browser. Merge, split, compress, convert, OCR, redact, sign and encrypt PDFs with nothing uploaded: the file is processed on your device and each job reports 0 document bytes sent. No account, no limits, no trackers. **[hatepdf.com](https://hatepdf.com)**

---

## Privacy-tool directories to request listing on

- awesome-privacy (GitHub: pluja/awesome-privacy) — open a PR adding HatePDF under PDF tools.
- PrivacyTools.io / PrivacyGuides forum — post in the "tool suggestions" category with the DevTools verification method; do not oversell.
- AlternativeTo (above), Slant ("What are the best free PDF editors?"), Product Hunt (above).
- Directories of client-side / "local-first" web apps.
