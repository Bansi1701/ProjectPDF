/**
 * Making a typed filename safe to hand to the filesystem.
 *
 * The name someone types in the save dialog goes straight into a `download`
 * attribute, and from there into a real directory on a real machine. Browsers
 * sanitise some of this, inconsistently, and none of them cover all of it — so
 * none of it is assumed here.
 *
 * What is actually being defended against:
 *
 *  - Path separators. "../../notes" names a different directory, not a file.
 *  - Bidirectional overrides. U+202E reverses the text that follows it, so a
 *    name ending in one is drawn by the operating system back-to-front: the
 *    classic way an executable is made to look like a document. It is
 *    completely invisible in the input box.
 *  - Windows device names. A file called CON or LPT1 cannot be created, and
 *    the failure surfaces as something unrelated.
 *  - Trailing dots and spaces, which Windows strips after the fact, quietly
 *    turning "report ." into a different name than the one asked for.
 *  - Length. Most filesystems cap a name at 255 BYTES rather than characters,
 *    so a name in a non-Latin script reaches the ceiling three times sooner.
 *
 * The extension is not the user's to change. The bytes are a PDF whatever the
 * name says, and a PDF called .exe helps nobody.
 */

/** Characters no major filesystem accepts, plus the ones that lie about order. */
const FORBIDDEN = /[\u0000-\u001F\u007F<>:"/\\|?*\u202A-\u202E\u2066-\u2069]/g;

/** Names Windows reserves for devices, with or without an extension. */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

/** Bytes, not characters — the limit filesystems actually enforce. */
const MAX_BYTES = 180;

const encoder = new TextEncoder();

/** Trims to a byte budget without splitting a character in half. */
function clampBytes(value: string, budget: number): string {
  if (encoder.encode(value).length <= budget) return value;

  let out = '';
  let used = 0;
  // Iterating a string yields whole code points, so a surrogate pair or an
  // emoji is never cut down the middle.
  for (const character of value) {
    const size = encoder.encode(character).length;
    if (used + size > budget) break;
    out += character;
    used += size;
  }
  return out;
}

/** The extension of a filename, lowercased, without the dot. */
export function extensionOf(name: string): string {
  const match = /\.([A-Za-z0-9]{1,8})$/.exec(name);
  return match ? match[1].toLowerCase() : '';
}

/** A filename with its extension removed, for pre-filling the dialog. */
export function stemOf(name: string): string {
  const extension = extensionOf(name);
  return extension ? name.slice(0, -(extension.length + 1)) : name;
}

/**
 * Cleans a typed stem and puts the real extension back on it.
 *
 * `extension` is the one the bytes actually are. Whatever was typed, the
 * result ends with it.
 */
export function safeFilename(typed: string, extension: string, fallback = 'document'): string {
  // Compose accents into single code points, so two names that look identical
  // are the same name and the byte count is the smaller of the two.
  let stem = typed.normalize('NFC').replace(FORBIDDEN, '');

  // Drop a redundant extension FIRST, while it is still on the end. Someone
  // who pastes a whole filename means "call it this", not "call it this dot
  // pdf dot pdf". Doing this after the leading dot is stripped would turn a
  // bare ".pdf" into "pdf.pdf" instead of an empty name that falls back.
  // A DIFFERENT extension is only text, so "report.exe" becomes
  // "report.exe.pdf" and stays honest about what the bytes are.
  stem = stem.replace(/\s+$/, '');
  if (extension && stem.toLowerCase().endsWith(`.${extension}`)) {
    stem = stem.slice(0, -(extension.length + 1));
  }

  // A leading dot hides the file on Unix; trailing dots and spaces are removed
  // by Windows afterwards, which silently changes the name.
  stem = stem.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');

  // Collapse runs of whitespace — a filename is not a place for layout.
  stem = stem.replace(/\s+/g, ' ');

  if (RESERVED.test(stem)) stem = `${stem}-file`;
  if (!stem) stem = fallback;

  const suffix = extension ? `.${extension}` : '';
  stem = clampBytes(stem, Math.max(MAX_BYTES - encoder.encode(suffix).length, 1));

  // Clamping can re-expose a trailing dot or space at the new boundary.
  stem = stem.replace(/[.\s]+$/, '') || fallback;

  return `${stem}${suffix}`;
}

/**
 * Names a set of outputs from one typed stem.
 *
 * A split producing eight files becomes "report-1.pdf" through "report-8.pdf".
 * Where the outputs differ by extension instead — a searchable PDF beside its
 * text — the extension already tells them apart, so they share one name.
 */
export function nameSeries(typed: string, originals: string[]): string[] {
  const extensions = originals.map(extensionOf);
  const numbered = originals.length > 1 && new Set(extensions).size === 1;

  return originals.map((original, index) =>
    safeFilename(
      numbered ? `${typed}-${index + 1}` : typed,
      extensions[index],
      stemOf(original) || 'document'
    )
  );
}
