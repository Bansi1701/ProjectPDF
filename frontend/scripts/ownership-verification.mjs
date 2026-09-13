import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const googleVerificationPath = fileURLToPath(new URL('../dist/google3c766f02caba05a5.html', import.meta.url));

// This exact, content-checked ownership proof is not a website page. Keep it
// unwrapped: Google expects the supplied token, not layout/SEO/advertising tags.
export function isOwnershipVerification(file) {
  if (resolve(file) !== googleVerificationPath) return false;
  if (readFileSync(file, 'utf8').trim() !== 'google-site-verification: google3c766f02caba05a5.html') {
    throw new Error('Google ownership verification file was modified');
  }
  return true;
}
