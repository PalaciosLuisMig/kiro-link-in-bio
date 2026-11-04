// Sign-in form (task 15.10, Requirements 5.1, 5.8, 5.12, 5.13).

import { PANEL } from '../../lib/messages.js';

import { h, setChildren } from './dom.js';

export interface LoginView {
  /** Shows a message under the field, or hides it when the text is empty. */
  setMessage(text: string): void;
  /** While the token is being checked, the button waits and cannot be pressed twice. */
  setBusy(busy: boolean): void;
  focus(): void;
}

/**
 * Draws the sign-in form. The token field is a password field with autocomplete
 * off, so the browser does not offer to store the token. Submitting calls
 * `onSubmit` with exactly what was typed; trimming and the "empty" rule belong to
 * `signIn`.
 */
export function renderLogin(
  container: HTMLElement,
  onSubmit: (rawToken: string) => void,
): LoginView {
  const doc = container.ownerDocument;

  const input = h(doc, 'input', {
    class: 'field',
    attrs: {
      id: 'owner-token',
      name: 'token',
      type: 'password',
      autocomplete: 'off',
      spellcheck: 'false',
      autocapitalize: 'off',
      'aria-describedby': 'login-message',
    },
  });
  const message = h(doc, 'p', {
    class: 'message message--error',
    attrs: { id: 'login-message', role: 'alert', hidden: '' },
  });
  const button = h(doc, 'button', {
    class: 'button button--primary',
    text: PANEL.signIn,
    attrs: { type: 'submit' },
  });

  const form = h(
    doc,
    'form',
    { class: 'login', attrs: { novalidate: '' } },
    h(doc, 'p', { class: 'hint', text: PANEL.tokenHint }),
    h(doc, 'label', { class: 'label', text: PANEL.tokenLabel, attrs: { for: 'owner-token' } }),
    input,
    message,
    button,
  );
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    onSubmit(input.value);
  });

  setChildren(container, form);

  return {
    setMessage(text) {
      message.textContent = text;
      message.toggleAttribute('hidden', text === '');
      input.setAttribute('aria-invalid', text === '' ? 'false' : 'true');
    },
    setBusy(busy) {
      button.disabled = busy;
      button.textContent = busy ? PANEL.signingIn : PANEL.signIn;
      form.setAttribute('aria-busy', busy ? 'true' : 'false');
    },
    focus() {
      input.focus();
    },
  };
}
