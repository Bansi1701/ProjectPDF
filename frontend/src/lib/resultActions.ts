import '../styles/resultActions.css';
import { extensionOf, safeFilename } from './filename';
import { openResultCollection, previewableResult, resultArchive } from './resultBatch';

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
  let archiveUrl = '';
  let archiveBlob: Blob | null = null;
  let invalidateArchive = () => {};
  const roots: HTMLElement[] = [];
  const models = files.map((file) => {
    file.name = safeFilename(file.name, extensionOf(file.name));
    const blob = file.bytes instanceof Blob ? file.bytes : new Blob([file.bytes as BlobPart], { type: file.type ?? 'application/pdf' });
    return { file, blob, url: URL.createObjectURL(blob), refresh: () => {} };
  });
  host.replaceChildren();
  host.dataset.many = String(files.length > 6);
  const renameDialog = host.closest('[data-pdf-tool], [data-redact], [data-scan]')?.querySelector<RenameDialog>('save-dialog');

  const formatSize = (bytes: number) => bytes >= 1048576 ? `${(bytes / 1048576).toFixed(2)} MB` : `${Math.max(.1, bytes / 1024).toFixed(1)} KB`;
  const summary = document.createElement('section');
  summary.className = 'result-batch'; summary.dataset.resultBatch = '';
  const total = models.reduce((sum, model) => sum + model.blob.size, 0);
  const summaryTitle = document.createElement('strong'); summaryTitle.textContent = `${files.length} ${files.length === 1 ? 'file' : 'files'} ready`;
  summaryTitle.dataset.resultCount = '';
  const summaryDetail = document.createElement('p'); summaryDetail.textContent = `${formatSize(total)} total · ${files.length > 1 ? 'Every file is listed below' : 'Your original is unchanged'}`;
  summary.append(summaryTitle, summaryDetail);
  host.append(summary); roots.push(summary);
  if (files.length > 1) {
    const batchActions = document.createElement('div'); batchActions.className = 'result-batch__actions';
    const batchStatus = document.createElement('p'); batchStatus.className = 'file-result__status'; batchStatus.dataset.batchStatus = ''; batchStatus.setAttribute('role', 'status');
    const say = (message: string) => { if (!disposed) batchStatus.textContent = message; };
    const batchFiles = () => models.map(model => ({ name: model.file.name, blob: model.blob, url: model.url }));
    const action = (label: string, key: string) => {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'btn btn--quiet'; button.textContent = label; button.dataset[key] = ''; batchActions.append(button); return button;
    };
    const saveAll = action('Save all (ZIP)', 'batchSaveAll'); saveAll.className = 'btn btn--primary';
    const downloadAll = document.createElement('a'); downloadAll.className = 'btn btn--primary'; downloadAll.textContent = 'Download all (ZIP)'; downloadAll.download = 'filozy-results.zip'; downloadAll.dataset.downloadAll = ''; downloadAll.hidden = true; batchActions.append(downloadAll);
    downloadAll.addEventListener('click', () => say(`Download requested: ${files.length} files in filozy-results.zip. Extract the ZIP to use them. Your results stay here.`));
    const shareAll = action('Share all', 'shareAll');
    const openAll = action('Open all', 'openAll');
    openAll.addEventListener('click', () => {
      try { say(openResultCollection(batchFiles()) ? `Opened a viewer listing all ${files.length} files in one tab. Select a file there to preview it.` : 'Your browser blocked the viewer. Allow this popup, or use each file’s Open button below.'); }
      catch { say('The viewer could not open. Use each file’s Open or Download button below.'); }
    });
    const prepareArchive = async () => {
      if (archiveBlob) return archiveBlob;
      if (total > 512 * 1048576) throw new Error('This batch is too large to package safely in this browser. Download individual files below.');
      say(`Preparing ZIP: 0 of ${files.length} files…`);
      const blob = await resultArchive(batchFiles(), () => disposed, done => say(`Preparing ZIP: ${done} of ${files.length} files…`));
      if (disposed) return null;
      archiveBlob = blob; archiveUrl = URL.createObjectURL(blob); downloadAll.href = archiveUrl;
      downloadAll.hidden = false; saveAll.hidden = true;
      return blob;
    };
    saveAll.addEventListener('click', () => {
      if (nativeActionBusy || disposed) return;
      nativeActionBusy = true; saveAll.disabled = true;
      void prepareArchive().then(blob => { if (blob && !disposed) { say(`All ${files.length} files are ready in one ZIP. Choose Download all to save them.`); downloadAll.focus(); } }).catch(error => say(error instanceof Error ? error.message : 'Could not prepare a ZIP. Use the individual downloads below.')).finally(() => { nativeActionBusy = false; saveAll.disabled = false; });
    });
    const canShare = (items: File[]) => {
      try { return window.isSecureContext && typeof navigator.share === 'function' && navigator.canShare?.({ files: items }) === true; } catch { return false; }
    };
    shareAll.addEventListener('click', () => {
      if (nativeActionBusy || disposed) return;
      const individual = batchFiles().map(file => new File([file.blob], file.name, { type: file.blob.type }));
      const zip = archiveBlob ? [new File([archiveBlob], 'filozy-results.zip', { type: 'application/zip' })] : [];
      const items = canShare(individual) ? individual : zip.length && canShare(zip) ? zip : null;
      if (!items) {
        say('This browser cannot share this file batch directly. Use Save all (ZIP), then share the downloaded ZIP from your Files app. Individual sharing may also be available below.');
        return;
      }
      nativeActionBusy = true; shareAll.disabled = true;
      // Native share must be called in the click, before any asynchronous work.
      void (async () => {
        try { await navigator.share({ files: items }); say('Share request handed to your device. Check the destination you selected; Filozy cannot confirm the files were saved.'); }
        catch (error) { say(error instanceof DOMException && error.name === 'AbortError' ? 'Sharing cancelled. All results are still here.' : 'Sharing failed. Try Save all (ZIP) or the individual downloads.'); }
        finally { nativeActionBusy = false; shareAll.disabled = false; }
      })();
    });
    invalidateArchive = () => {
      if (archiveUrl) URL.revokeObjectURL(archiveUrl);
      archiveUrl = ''; archiveBlob = null; downloadAll.hidden = true; downloadAll.removeAttribute('href'); saveAll.hidden = false;
    };
    const note = document.createElement('p'); note.className = 'result-batch__hint'; note.textContent = 'ZIP keeps every original output file. Open all uses one viewer tab. Share options depend on your browser and device.';
    summary.append(batchActions, note, batchStatus);
  }

  for (const [index, model] of models.entries()) {
    const card = document.createElement('section');
    card.className = 'file-result';
    card.dataset.resultFile = '';
    const title = document.createElement('strong');
    title.className = 'file-result__name';
    const facts = document.createElement('p');
    facts.className = 'file-result__facts';
    facts.textContent = `${index + 1} of ${files.length} · ${extensionOf(model.file.name).toUpperCase() || 'FILE'} · ${formatSize(model.blob.size)}`;
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
    const previewable = previewableResult(model.blob.type);
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
          invalidateArchive();
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
    if (archiveUrl) URL.revokeObjectURL(archiveUrl);
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
  result.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
}
