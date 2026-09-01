import { FAVOURITES_KEY, PREVIEW_SIZE_KEY, THEME_KEY } from '../lib/browserPreferences';

export interface BrowserStorageItem {
  name: string;
  technology: string;
  key: string;
  starts: string;
  contents: string;
  purpose: string;
  retention: string;
}

export const BROWSER_STORAGE_ITEMS: readonly BrowserStorageItem[] = [
  {
    name: 'Colour theme',
    technology: 'localStorage',
    key: THEME_KEY,
    starts: 'Only after you choose light or dark mode.',
    contents: 'The word “light” or “dark” and an expiry time.',
    purpose: 'Keeps the appearance you explicitly selected between pages and visits.',
    retention: 'Up to 12 months after your last change, or until you clear site data.',
  },
  {
    name: 'PDF preview size',
    technology: 'localStorage',
    key: PREVIEW_SIZE_KEY,
    starts: 'Only after you choose a preview size.',
    contents: 'Small, medium or large and an expiry time.',
    purpose: 'Keeps the page-thumbnail size you explicitly selected.',
    retention: 'Up to 12 months after your last change, or until you clear site data.',
  },
  {
    name: 'Favourite tools',
    technology: 'localStorage',
    key: FAVOURITES_KEY,
    starts: 'Only after you mark a tool as a favourite.',
    contents: 'The public URL slugs of the tools you selected and an expiry time.',
    purpose: 'Builds your local shortcut list. It is never transmitted to HatePDF.',
    retention: 'Up to 12 months after your last change, or until you clear site data.',
  },
  {
    name: 'Connected workflow handoff',
    technology: 'IndexedDB',
    key: 'projectpdf-handoff / files',
    starts: 'Only after you choose “Continue with” another PDF tool.',
    contents: 'The result PDF, filename, media type, random handoff key and creation time.',
    purpose: 'Lets the next local tool claim the file without uploading it to a server.',
    retention: 'Deleted when claimed. If abandoned, it becomes inaccessible after one hour and is removed the next time HatePDF opens; Clear site data removes it sooner.',
  },
] as const;
