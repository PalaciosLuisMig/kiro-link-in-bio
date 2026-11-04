// Confirmation dialog (task 15.10, Requirements 6.16, 15.1, 16.1, 16.2).
//
// A native `<dialog>` opened with `showModal()`, so the page behind it cannot be
// reached and Escape closes it. The first focus is on "Cancelar": a stray Enter
// must never confirm a destructive action. It works with the keyboard alone.

import { h } from './dom.js';

export interface ConfirmOptions {
  readonly title: string;
  readonly message: string;
  readonly confirmLabel: string;
  readonly cancelLabel: string;
}

let counter = 0;

/**
 * Asks the owner to confirm and resolves `true` only if they press the confirm
 * button. Cancel, Escape or any other way of closing resolves `false`, and nothing
 * else is sent. Focus goes back to where it was.
 */
export function confirmDialog(doc: Document, options: ConfirmOptions): Promise<boolean> {
  counter += 1;
  const titleId = `dialog-title-${counter}`;
  const messageId = `dialog-message-${counter}`;
  const previouslyFocused = doc.activeElement instanceof HTMLElement ? doc.activeElement : null;

  const cancel = h(doc, 'button', {
    class: 'button',
    text: options.cancelLabel,
    attrs: { type: 'button', autofocus: '' },
  });
  const confirm = h(doc, 'button', {
    class: 'button button--danger',
    text: options.confirmLabel,
    attrs: { type: 'button' },
  });

  const dialog = h(
    doc,
    'dialog',
    { class: 'dialog', attrs: { 'aria-labelledby': titleId, 'aria-describedby': messageId } },
    h(doc, 'h2', { class: 'dialog-title', text: options.title, attrs: { id: titleId } }),
    h(doc, 'p', { text: options.message, attrs: { id: messageId } }),
    h(doc, 'div', { class: 'dialog-actions' }, cancel, confirm),
  );

  return new Promise<boolean>((resolve) => {
    let answered = false;
    const finish = (answer: boolean): void => {
      if (answered) {
        return;
      }
      answered = true;
      if (dialog.open && typeof dialog.close === 'function') {
        dialog.close();
      }
      dialog.remove();
      if (previouslyFocused?.isConnected === true) {
        previouslyFocused.focus();
      }
      resolve(answer);
    };

    confirm.addEventListener('click', () => finish(true));
    cancel.addEventListener('click', () => finish(false));
    // Escape fires `cancel`; any other close without a confirmation is a "no".
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      finish(false);
    });
    dialog.addEventListener('close', () => finish(false));

    doc.body.append(dialog);
    if (typeof dialog.showModal === 'function') {
      dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
    cancel.focus();
  });
}
