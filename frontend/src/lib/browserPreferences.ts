export const THEME_KEY = 'pdfcraft-theme';
export const PREVIEW_SIZE_KEY = 'pdftool-preview-size';
export const FAVOURITES_KEY = 'projectpdf-favourites';
export const LEGACY_USAGE_KEY = 'projectpdf-tool-usage';
export const PREFERENCE_VERSION = 1;
export const PREFERENCE_TTL_MS = 365 * 24 * 60 * 60 * 1000;

const PREFERENCE_KEYS = [THEME_KEY, PREVIEW_SIZE_KEY, FAVOURITES_KEY] as const;

interface PreferenceEnvelope<T> {
  version: typeof PREFERENCE_VERSION;
  value: T;
  expiresAt: number;
}

function remove(key: string): void {
  localStorage.removeItem(key);
}

/** Reads only a current, bounded preference created by an explicit user action. */
export function readPreference<T>(key: string, accepts: (value: unknown) => value is T): T | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !('version' in parsed) ||
      parsed.version !== PREFERENCE_VERSION ||
      !('expiresAt' in parsed) ||
      typeof parsed.expiresAt !== 'number' ||
      parsed.expiresAt <= Date.now() ||
      !('value' in parsed) ||
      !accepts(parsed.value)
    ) {
      remove(key);
      return null;
    }
    return parsed.value;
  } catch {
    try { remove(key); } catch {}
    return null;
  }
}

/** Persists a preference for at most one year after the person changes it. */
export function writePreference<T>(key: string, value: T): boolean {
  try {
    const record: PreferenceEnvelope<T> = {
      version: PREFERENCE_VERSION,
      value,
      expiresAt: Date.now() + PREFERENCE_TTL_MS,
    };
    localStorage.setItem(key, JSON.stringify(record));
    return true;
  } catch {
    return false;
  }
}

/** Removes every HatePDF preference, including the retired usage counter. */
export function clearPreferences(): void {
  try {
    for (const key of [...PREFERENCE_KEYS, LEGACY_USAGE_KEY]) remove(key);
  } catch {}
}
