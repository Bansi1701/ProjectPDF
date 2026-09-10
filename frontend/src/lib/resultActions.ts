import '../styles/resultActions.css';
import { extensionOf, safeFilename } from './filename';

export interface ResultFile {
  name: string;
  bytes: Uint8Array | Blob;
  type?: string;
}
interface RenameAnswer { name: string; all: string[] | null }
interface RenameDialog extends HTMLElement {
  ask(request: { name: string; siblings: string[]; index: number }): Promise<RenameAnswer | null>;
}
interface SaveHandle {
  name: string;
  createWritable(): Promise<{ write(data: Blob): Promise<void>; close(): Promise<void>; abort(): Promise<void> }>;
}
interface PickerWindow extends Window {
  showSaveFilePicker?: (options: { suggestedName: string }) => Promise<SaveHandle>;
}

/** Shared by all tool results. No upload or persistent document storage. */
export function mountResultActions(host: HTMLElement, files: ResultFile[]) {
  let disposed = false;
  let nativeActionBusy = false;
  const roots: HTMLElement[] = [];
  const models = files.map((file) => {
    file.name = safeFilename(file.name, extensionOf(file.name));
    const blob = file.bytes instanceof Blob ? file.bytes : new Blob([file.bytes as BlobPart], { type: file.type ?? 'application/pdf' });
    return { file, blob, url: URL.createObjectURL(blob), refresh: () => {} };
  });
  host.replaceChildren();
  host.dataset.many = String(files.length > 6);
  const renameDialog = host.closest('[data-pdf-tool], [data-redact], [data-scan]')?.querySelector<RenameDialog>('save-dialog');

  for (const [index, model] of models.entries()) {
    const card = document.createElement('section');
    card.className = 'file-result';
    card.dataset.resultFile = '';
    const title = document.createElement('strong');
    title.className = 'file-result__name';
    const facts = document.createElement('p');
    facts.className = 'file-result__facts';
    facts.textContent = `${model.blob.size >= 1048576 ? `${(model.blob.size / 1048576).toFixed(2)} MB` : `${Math.max(0.1, model.blob.size / 1024).toFixed(1)} KB`} · Ready on this device`;
    const actions = document.createElement('div');
    actions.className = 'file-result__actions';
    const status = document.createElement('p');
    status.className = 'file-result__status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    const say = (message: string) => { if (!disposed) status.textContent = message; };
    const link = (label: string) => {
      const anchor = document.createElement('a');
      anchor.className = 'btn btn--quiet';
      anchor.href = model.url;
      // Safari may display a PDF instead of downloading it. Preserve the tool tab.
      anchor.target = '_blank';
      anchor.rel = 'noopener';
      anchor.textContent = label;
      actions.append(anchor);
      return anchor;
    };
    const button = (label: string, action: () => void) => {
      const element = document.createElement('button');
      element.type = 'button';
      element.className = 'btn btn--quiet';
      element.textContent = label;
      element.addEventListener('click', action);
      actions.append(element);
      return element;
    };
    const download = link('Download');
    download.className = 'btn btn--primary';
    download.dataset.fileDownload = '';
    download.addEventListener('click', () => say(`Download requested for ${model.file.name}. Check your browser's Downloads. Your result stays here.`));

    // Do not navigate generated HTML/SVG, which could contain active content.
    const previewable = /^(application\/pdf|image\/(?:png|jpeg|webp)|text\/plain)(?:;|$)/i.test(model.blob.type);
    if (previewable) {
      const open = link('Open');
      open.dataset.fileOpen = '';
      open.addEventListener('click', () => say(`Opening ${model.file.name} in another tab. Opening a file does not save a copy; return here if you need Download or Share.`));
    }
    const shareFile = () => new File([model.blob], model.file.name, { type: model.blob.type });
    const canShare = () => {
      try { return window.isSecureContext && typeof navigator.share === 'function' && navigator.canShare?.({ files: [shareFile()] }) === true; }
      catch { return false; }
    };
    const share = button('Share or save', () => {
      if (nativeActionBusy || disposed) return;
      nativeActionBusy = true;
      share.disabled = true;
      say('Choose a destination in your device’s share menu. Saving options depend on your device.');
      // Call synchronously inside this click: awaiting Rename loses activation.
      void (async () => {
        try {
          await navigator.share({ files: [shareFile()] });
          say(`Share request handed to your device for ${model.file.name}. Check the destination you chose; Filozy cannot confirm it was saved.`);
        } catch (error) {
          say(error instanceof DOMException && error.name === 'AbortError'
            ? 'Sharing cancelled or no destination available. Your file is still ready here.'
            : 'This device could not share that file. Try Download or Open instead.');
        } finally { nativeActionBusy = false; share.disabled = false; }
      })();
    });
    share.dataset.fileShare = '';

    const picker = (window as PickerWindow).showSaveFilePicker;
    if (window.isSecureContext && typeof picker === 'function') {
      const save = button('Save as…', () => {
        if (nativeActionBusy || disposed) return;
        nativeActionBusy = true;
        save.disabled = true;
        void (async () => {
          let writable: Awaited<ReturnType<SaveHandle['createWritable']>> | undefined;
          try {
            const handle = await picker.call(window, { suggestedName: model.file.name });
            writable = await handle.createWritable();
            await writable.write(model.blob);
            await writable.close();
            say(`Saved as ${handle.name} in the location you selected. Your result remains available here.`);
          } catch (error) {
            if (writable) await writable.abort().catch(() => {});
            say(error instanceof DOMException && error.name === 'AbortError'
              ? 'Save cancelled. Your file is still ready here.'
              : 'The file could not be saved to that location. Try Download instead.');
          } finally { nativeActionBusy = false; save.disabled = false; }
        })();
      });
      save.dataset.filePicker = '';
    }
    if (renameDialog) {
      button('Rename', () => {
        if (nativeActionBusy || disposed) return;
        nativeActionBusy = true;
        void (async () => {
          try {
          const answer = await renameDialog.ask({ name: model.file.name, siblings: models.map((item) => item.file.name), index });
          if (!answer || disposed) return;
          models.forEach((item, at) => {
            const name = answer.all?.[at] ?? (at === index ? answer.name : undefined);
            if (name) item.file.name = safeFilename(name, extensionOf(item.file.name));
            item.refresh();
          });
          say(`Named ${model.file.name}. Choose Download, Open or Share to use it.`);
          } catch {
            say('The rename dialog could not open. Your original file is still ready to download.');
          } finally { nativeActionBusy = false; }
        })();
      }).dataset.fileRename = '';
    }
    model.refresh = () => {
      title.textContent = model.file.name;
      download.download = model.file.name;
      download.setAttribute('aria-label', `Download ${model.file.name}`);
      share.hidden = !canShare();
      card.setAttribute('aria-label', model.file.name);
    };
    model.refresh();
    card.append(title, facts, actions, status);
    roots.push(card);
    host.append(card);
  }
  const help = document.createElement('details');
  help.className = 'file-result-help';
  const heading = document.createElement('summary');
  heading.textContent = 'Where is my saved file?';
  help.append(heading);
  for (const message of [
    'iPhone or iPad: use Share or save, then Save to Files if your device offers it. Safari downloads usually appear in the Files app under Downloads.',
    'Android: look in Chrome’s Downloads or your Files app. Your browser settings determine the download location. Use Share or save to choose another available app.',
    'If no new tab opens, your browser may have blocked it. Try Download or use Safari/Chrome instead of an in-app browser.',
    'Keep this tab open until you have checked your saved copy. Starting over, choosing another file or closing/reloading the tab can remove these results. Sharing gives the file to the app you choose; Filozy does not upload it.',
  ]) {
    const p = document.createElement('p'); p.textContent = message; help.append(p);
  }
  host.append(help);
  roots.push(help);
  const onPageHide = (event: PageTransitionEvent) => { if (!event.persisted) dispose(); };
  window.addEventListener('pagehide', onPageHide);
  function dispose() {
    if (disposed) return;
    disposed = true;
    window.removeEventListener('pagehide', onPageHide);
    for (const model of models) URL.revokeObjectURL(model.url);
    for (const element of roots) element.remove();
  }
  return { dispose };
}

export function revealResult(result: HTMLElement) {
  result.hidden = false;
  result.tabIndex = -1;
  result.setAttribute('role', 'region');
  result.setAttribute('aria-label', 'Finished files and saving options');
  result.focus({ preventScroll: true });
  result.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
}
