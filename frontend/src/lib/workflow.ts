import { recipeBySlug } from '../config/recipes';
import { claim, stash } from './handoff';

/** Resolve only known recipes on their actual tool route, never an arbitrary destination. */
export function workflowContext(url: URL) {
  const recipe = recipeBySlug(url.searchParams.get('recipe') ?? '');
  const step = Number(url.searchParams.get('step'));
  if (!recipe || !Number.isInteger(step) || step < 1 || step > recipe.steps.length) return null;
  const current = recipe.steps[step - 1];
  if (!url.pathname.replace(/\/$/, '').endsWith(`/${current.slug}`)) return null;
  return { recipe, step, current, next: recipe.steps[step] };
}

export async function receiveWorkflow(
  root: HTMLElement,
  receive: (file: File) => void | Promise<void>,
  isEmpty: () => boolean,
  fail: (message: string) => void,
) {
  const url = new URL(location.href);
  const context = workflowContext(url);
  if (context) {
    const banner = document.createElement('aside');
    banner.className = 'workflow-banner';
    const title = document.createElement('strong');
    title.textContent = `Step ${context.step} of ${context.recipe.steps.length} · ${context.current.name}`;
    const instruction = document.createElement('p');
    instruction.textContent = context.current.instruction;
    const link = document.createElement('a');
    link.href = `${import.meta.env.BASE_URL.replace(/\/$/, '')}/how-to/${context.recipe.slug}/`;
    link.textContent = 'View the workflow';
    banner.append(title, instruction, link);
    root.prepend(banner);

    if (context.recipe.slug === 'make-print-ready-booklet') {
      const kind = root.querySelector<HTMLSelectElement>('[data-impose-kind]');
      if (kind) kind.value = 'booklet';
    }
    if (context.recipe.slug === 'redact-bank-statement-before-sending') {
      const strip = root.querySelector<HTMLInputElement>('[data-metadata-strip]');
      if (strip) strip.checked = true;
    }
  }
  const key = url.searchParams.get('from');
  if (!key) return;
  if (!isEmpty()) return;
  // Do not let a picker/drop race consume and silently discard the handoff.
  const wasInert = root.inert;
  const blockSelection = (event: Event) => { event.preventDefault(); event.stopImmediatePropagation(); };
  root.inert = true;
  root.addEventListener('drop', blockSelection, true);
  root.addEventListener('change', blockSelection, true);
  try {
    const file = await claim(key);
    if (!file) {
      fail('The local handoff could not open. Allow browser storage and refresh to retry, or choose your saved PDF if it expired or was already opened.');
      return;
    }
    // Only a consumed identifier is removed; failed storage can be retried.
    url.searchParams.delete('from');
    history.replaceState(history.state, '', `${url.pathname}${url.search}${url.hash}`);
    await receive(file);
  } finally {
    root.inert = wasInert;
    root.removeEventListener('drop', blockSelection, true);
    root.removeEventListener('change', blockSelection, true);
  }
}

export function appendWorkflowAction(
  host: HTMLElement,
  files: readonly { name: string; bytes: Uint8Array; type?: string }[],
) {
  const context = workflowContext(new URL(location.href));
  if (!context) return;
  const status = document.createElement('p');
  status.className = 'workflow-status';
  status.setAttribute('role', 'status');
  if (!context.next) {
    status.textContent = 'Workflow complete. Review and save your finished file.';
    host.append(status);
    return;
  }
  const pdfFiles = files.filter((file) => /\.pdf$/i.test(file.name));
  if (pdfFiles.length !== 1) {
    status.textContent = 'Save the output, then choose the PDF you want in the next workflow step.';
    host.append(status);
    return;
  }
  const button = document.createElement('button');
  if (files.length > 1) status.textContent = 'Continue with the PDF. You can also save the separate text result above.';
  button.type = 'button';
  button.className = 'btn btn--quiet';
  button.textContent = `Continue to ${context.next.name}`;
  button.addEventListener('click', async () => {
    button.disabled = true;
    status.textContent = 'Preparing the next step on this device…';
    const file = pdfFiles[0];
    const key = await stash(new Blob([file.bytes as BlobPart], { type: 'application/pdf' }), file.name);
    if (!key) {
      status.textContent = 'Local storage is unavailable. Save this PDF and open the next tool manually.';
      button.disabled = false;
      return;
    }
    const params = new URLSearchParams({ recipe: context.recipe.slug, step: String(context.step + 1), from: key });
    location.href = `${import.meta.env.BASE_URL.replace(/\/$/, '')}/${context.next!.slug}/?${params}`;
  });
  host.append(button, status);
}
