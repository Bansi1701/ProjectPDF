/**
 * Protect and unlock.
 *
 * This is the tool where doing the work in the browser stops being a nice
 * property and becomes the whole point. Encrypting a document on someone
 * else's server means handing them the plaintext AND the password that is
 * supposed to protect it. There is no version of that which is private, however
 * the retention policy is worded.
 *
 * Two things about PDF security that most tools quietly misrepresent, and that
 * this module surfaces instead:
 *
 * 1. A USER password encrypts. An OWNER password does not — it sets permission
 *    flags that a well-behaved reader honours and any other reader ignores in
 *    one line of code. Permissions are a request, not a lock.
 * 2. Consequently a document with only an owner password is readable by
 *    everyone. Removing those restrictions needs no password and is not
 *    circumvention; it is asking the file to stop lying about what it enforces.
 */
import { PDFDict, PDFDocument, PDFName } from '@cantoo/pdf-lib';

import type { InputFile, OpResult } from './types';

const baseName = (name: string): string => name.replace(/\.pdf$/i, '');

export interface Permissions {
  printing: boolean;
  copying: boolean;
  modifying: boolean;
  annotating: boolean;
}

/**
 * Rough entropy in bits, for feedback only.
 *
 * Deliberately conservative: it counts the character classes actually used
 * rather than the ones available, so "Password1" scores as the weak thing it is.
 */
export function passwordBits(password: string): number {
  if (!password) return 0;

  let alphabet = 0;
  if (/[a-z]/.test(password)) alphabet += 26;
  if (/[A-Z]/.test(password)) alphabet += 26;
  if (/[0-9]/.test(password)) alphabet += 10;
  if (/[^A-Za-z0-9]/.test(password)) alphabet += 32;

  const unique = new Set(password).size;
  // Repeated characters add length but very little entropy.
  const effective = password.length * Math.min(1, (unique + 2) / password.length);

  return Math.round(effective * Math.log2(Math.max(alphabet, 2)));
}

export function describeStrength(bits: number): string {
  if (bits < 40) return 'Weak — a determined attacker would get through this.';
  if (bits < 60) return 'Fair. Fine for casual privacy, not for anything valuable.';
  if (bits < 80) return 'Strong.';
  return 'Very strong.';
}

export async function protect(
  files: InputFile[],
  userPassword: string,
  ownerPassword: string,
  permissions: Permissions
): Promise<OpResult> {
  const file = files[0];
  if (!file) return { ok: false, error: 'Choose a PDF to protect.' };

  if (!userPassword && !ownerPassword) {
    return {
      ok: false,
      error: 'Set at least one password. Without one there is nothing to protect.',
    };
  }

  const started = performance.now();

  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(file.bytes, { updateMetadata: false });
  } catch (error) {
    const message = (error as Error).message;
    return {
      ok: false,
      error: message.toLowerCase().includes('encrypt')
        ? 'This PDF is already password-protected. Unlock it first.'
        : `This file could not be read as a PDF: ${message}`,
    };
  }

  const pages = doc.getPageCount();

  try {
    doc.encrypt({
      // Both are passed through as given; an empty owner password makes the
      // user password serve both roles, which is what most people expect.
      userPassword: userPassword || undefined,
      ownerPassword: ownerPassword || userPassword,
      permissions: {
        printing: permissions.printing ? 'highResolution' : false,
        copying: permissions.copying,
        modifying: permissions.modifying,
        annotating: permissions.annotating,
        fillingForms: permissions.annotating,
        // Never withheld: screen readers depend on it, and denying it is
        // hostile without being protective.
        contentAccessibility: true,
        documentAssembly: permissions.modifying,
      },
      // AES-256 (/V 5 /R 6). The library can emit RC4 but it is broken, and
      // offering a broken cipher next to a working one only creates a way to
      // pick wrong.
      algorithm: 'AES-256',
    });
  } catch (error) {
    return { ok: false, error: `Could not encrypt: ${(error as Error).message}` };
  }

  const bytes = await doc.save({ useObjectStreams: true, addDefaultPage: false });

  const notes: string[] = [];

  if (userPassword) {
    notes.push('The document is encrypted with AES-256. Without the password its contents cannot be read at all.');
  } else {
    notes.push(
      'No open password was set, so anyone can still open and read this file — only the permission flags were added.'
    );
  }

  const withheld = (
    [
      [!permissions.printing, 'printing'],
      [!permissions.copying, 'copying text'],
      [!permissions.modifying, 'editing'],
      [!permissions.annotating, 'commenting'],
    ] as const
  )
    .filter(([off]) => off)
    .map(([, label]) => label);

  if (withheld.length > 0) {
    notes.push(
      `Restricted: ${withheld.join(', ')}. Permission flags are honoured by well-behaved readers and ignored by others — treat them as a request, not a lock.`
    );
  }

  notes.push('We cannot recover this password. Nobody can. Keep it somewhere safe.');

  return {
    ok: true,
    files: [{ name: `${baseName(file.name)}-protected.pdf`, bytes }],
    bytesIn: file.bytes.byteLength,
    bytesOut: bytes.length,
    pages,
    durationMs: performance.now() - started,
    summary: userPassword ? 'Encrypted with AES-256' : 'Permissions applied',
    notes,
  };
}


/**
 * Which permissions the source document withheld.
 *
 * Read from the raw bytes, not the loaded document: pdf-lib drops the /Encrypt
 * entry from the trailer once it has decrypted, so by the time there is a
 * PDFDocument to ask, the permission bits are gone. Measured — trailerInfo
 * comes back holding only Root.
 *
 * Scanning the file for it is sound because an encryption dictionary is the one
 * dictionary that can never be in an object stream (ISO 32000-1 §7.5.8.2) and
 * is never itself encrypted — it has to be readable to know how to decrypt
 * everything else.
 *
 * /P is a bitfield where a *set* bit means allowed, so a withheld permission is
 * a clear bit (Table 22). It is a signed 32-bit integer and is almost always
 * negative, because the reserved high bits are all set; reading it unsigned
 * reports nonsense.
 */
function liftedPermissions(bytes: ArrayBuffer): string[] {
  const view = new Uint8Array(bytes);
  // latin1 keeps one byte to one character, so offsets stay meaningful.
  let text = '';
  const CHUNK = 0x8000;
  for (let at = 0; at < view.length; at += CHUNK) {
    text += String.fromCharCode(...view.subarray(at, at + CHUNK));
  }

  const handler = text.search(/\/Filter\s*\/Standard/);
  if (handler === -1) return [];

  // The whole dictionary sits well within this of the handler name.
  const window = text.slice(Math.max(0, handler - 2048), handler + 2048);
  const match = /\/P\s+(-?\d+)/.exec(window);
  if (!match) return [];

  const bits = Number(match[1]) | 0;
  const denied = (bit: number) => (bits & bit) === 0;

  return (
    [
      [denied(0b100), 'printing'],
      [denied(0b1000), 'editing'],
      [denied(0b1_0000), 'copying text'],
      [denied(0b10_0000), 'commenting'],
      [denied(0b1_0000_0000), 'filling in forms'],
      [denied(0b100_0000_0000), 'reordering pages'],
      // Only meaningful while printing is otherwise allowed.
      [!denied(0b100) && denied(0b1000_0000_0000), 'printing at full resolution'],
    ] as const
  )
    .filter(([off]) => off)
    .map(([, label]) => label);
}

export async function unlock(files: InputFile[], password: string): Promise<OpResult> {
  const file = files[0];
  if (!file) return { ok: false, error: 'Choose a PDF to unlock.' };

  const started = performance.now();

  let doc: PDFDocument;
  let neededPassword = true;

  try {
    doc = await PDFDocument.load(file.bytes, {
      password: password || undefined,
      updateMetadata: false,
    });
  } catch (error) {
    const message = (error as Error).message.toLowerCase();

    if (message.includes('password') || message.includes('encrypt')) {
      return {
        ok: false,
        error: password
          ? 'That password did not open this document.'
          : 'This PDF needs a password to open. Enter it above.',
      };
    }

    return { ok: false, error: `This file could not be read as a PDF: ${(error as Error).message}` };
  }

  // Loading without a password succeeding means the file was either not
  // encrypted at all, or carried only an owner password — which restricts
  // nothing a reader is obliged to respect.
  if (!password) neededPassword = false;

  const pages = doc.getPageCount();

  // Saving the loaded document is not enough: the /Encrypt dictionary survives
  // as an indirect object and pdf-lib writes it back out, so the "unlocked"
  // file is still encrypted. Rebuilding into a fresh document is what actually
  // drops it. No cipher is broken and no password is guessed — the document was
  // opened with the key its owner supplied.
  const rebuilt = await PDFDocument.create();
  const copied = await rebuilt.copyPages(doc, doc.getPageIndices());
  for (const page of copied) rebuilt.addPage(page);

  const bytes = await rebuilt.save({ useObjectStreams: true, addDefaultPage: false });

  const notes = [
    neededPassword
      ? 'Saved without encryption. Anyone with this copy can open it, so treat it like any other unprotected file.'
      : 'This document was not encrypted — it only carried permission flags, which any reader could already ignore. Those flags are now gone.',
  ];

  // Name the restrictions that were actually lifted. "Unlocked" on its own does
  // not tell somebody whether the thing they could not do — usually printing or
  // copying — is now possible.
  const lifted = liftedPermissions(file.bytes);
  if (lifted.length > 0) {
    notes.push(`Restrictions removed: ${lifted.join(', ')}. Those are now allowed in this copy.`);
  } else if (neededPassword) {
    notes.push('The document restricted nothing beyond needing the password to open it.');
  }

  // Rebuilding carries the pages, not the catalog. Name what is lost rather
  // than letting someone discover it later.
  const catalog = doc.catalog;
  const dropped: string[] = [];
  if (catalog.has(PDFName.of('Outlines'))) dropped.push('bookmarks');
  if (catalog.has(PDFName.of('AcroForm'))) dropped.push('form fields');

  const names = catalog.get(PDFName.of('Names'));
  const nameTree = names ? doc.context.lookupMaybe(names, PDFDict) : undefined;
  if (nameTree?.has(PDFName.of('EmbeddedFiles'))) dropped.push('file attachments');

  if (dropped.length > 0) {
    notes.push(
      `Removing the encryption meant rebuilding the document, which does not carry over ${dropped.join(', ')}. Every page, and everything drawn on it, is unchanged.`
    );
  }

  return {
    ok: true,
    files: [{ name: `${baseName(file.name)}-unlocked.pdf`, bytes }],
    bytesIn: file.bytes.byteLength,
    bytesOut: bytes.length,
    pages,
    durationMs: performance.now() - started,
    summary: neededPassword ? 'Password removed' : 'Restrictions removed',
    notes,
  };
}
