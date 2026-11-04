// Link management (task 15.10, Requirements 6, 7.1, 7.10, 15.1).
//
// Every action is a button, so everything works with the keyboard alone and
// nothing depends on dragging. Texts of links are plain text (14.9).
//
// The list is drawn when the LINKS change, not on every metrics update: counters
// change up to once a second and a full redraw would wipe what the owner is typing
// in an edit form. `updateCounts` changes only the numbers, in place.

import { MAX_LINKS, validateTitle, validateUrl, type AdminLink } from '@link-in-bio/shared';

import { PANEL, panelLabel } from '../../lib/messages.js';
import type { LinkDraft, LinkPatch } from '../api.js';

import { h, setChildren } from './dom.js';

/** What the view asks the Panel to do. Each resolves `true` when it worked. */
export interface LinkActions {
  create(draft: LinkDraft): Promise<boolean>;
  update(id: string, patch: LinkPatch): Promise<boolean>;
  /** Moves a link one place up (-1) or down (+1). */
  move(id: string, direction: -1 | 1): Promise<void>;
  remove(link: AdminLink): Promise<void>;
}

export type LinkControl = 'up' | 'down' | 'edit' | 'toggle' | 'remove';

export interface LinksView {
  /** Draws the list. Keeps an edit that is in progress if its link still exists. */
  render(links: readonly AdminLink[], clicksOf: (id: string) => number): void;
  /** Updates only the click numbers, in place. */
  updateCounts(clicksOf: (id: string) => number): void;
  /** While an action runs, every button waits, so nothing is sent twice. */
  setBusy(busy: boolean): void;
  /** Moves the keyboard focus to a control of a link (or the other arrow at the end). */
  focusControl(id: string, control: LinkControl): void;
  /** Moves the focus to the section's heading, for when the focused element is gone. */
  focusHeading(): void;
}

const CONTROL_CLASS: Record<LinkControl, string> = {
  up: 'js-up',
  down: 'js-down',
  edit: 'js-edit',
  toggle: 'js-toggle',
  remove: 'js-remove',
};

/**
 * The Panel is stricter than the API (which also accepts `http://`): every link the
 * owner saves must use `https://`. The title must not be blank. The URL is checked
 * as typed (no trim), exactly as the API checks it.
 */
const startsWithHttps = (url: string): boolean => /^https:\/\//i.test(url);

export function isLinkInputValid(title: string, url: string): boolean {
  return validateTitle(title) !== null && startsWithHttps(url) && validateUrl(url) !== null;
}

/** Whether to tell the owner the URL is wrong: only once something was typed in it. */
const urlProblem = (url: string): boolean => url !== '' && !startsWithHttps(url);

/**
 * Builds the management section inside `container`: the list, and under it the
 * form to add a link. The form is created once, so what is typed in it survives
 * list updates.
 */
export function createLinksView(container: HTMLElement, actions: LinkActions): LinksView {
  const doc = container.ownerDocument;
  let links: readonly AdminLink[] = [];
  let clicksOf: (id: string) => number = () => 0;
  let editingId: string | null = null;
  let busy = false;

  const heading = h(doc, 'h2', {
    class: 'section-title',
    text: PANEL.linksHeading,
    attrs: { tabindex: '-1', id: 'links-heading' },
  });
  const listBox = h(doc, 'div', { class: 'links-list' });

  // --- Add form (built once) ---
  const titleInput = h(doc, 'input', {
    class: 'field',
    attrs: { id: 'new-link-title', name: 'title', type: 'text', autocomplete: 'off' },
  });
  const urlInput = h(doc, 'input', {
    class: 'field',
    attrs: {
      id: 'new-link-url',
      name: 'url',
      type: 'url',
      autocomplete: 'off',
      spellcheck: 'false',
    },
  });
  const addButton = h(doc, 'button', {
    class: 'button button--primary',
    text: PANEL.addLink,
    attrs: { type: 'submit' },
  });
  const limitMessage = h(doc, 'p', {
    class: 'message',
    text: PANEL.linkLimit,
    attrs: { id: 'links-limit', hidden: '' },
  });
  const urlHint = h(doc, 'p', {
    class: 'message message--error',
    text: PANEL.urlNeedsHttps,
    attrs: { id: 'new-link-url-hint', hidden: '' },
  });
  urlInput.setAttribute('aria-describedby', 'new-link-url-hint');
  const addForm = h(
    doc,
    'form',
    { class: 'add-form', attrs: { novalidate: '' } },
    h(doc, 'h3', { class: 'subsection-title', text: PANEL.addHeading }),
    h(doc, 'label', { class: 'label', text: PANEL.titleLabel, attrs: { for: 'new-link-title' } }),
    titleInput,
    h(doc, 'label', { class: 'label', text: PANEL.urlLabel, attrs: { for: 'new-link-url' } }),
    urlInput,
    urlHint,
    limitMessage,
    addButton,
  );
  // The button waits until both fields are filled and the URL starts with https://.
  const syncAddForm = (): void => {
    const reached = links.length >= MAX_LINKS;
    const valid = isLinkInputValid(titleInput.value, urlInput.value);
    const wrongUrl = urlProblem(urlInput.value);
    urlHint.toggleAttribute('hidden', !wrongUrl);
    urlInput.setAttribute('aria-invalid', wrongUrl ? 'true' : 'false');
    limitMessage.toggleAttribute('hidden', !reached);
    addButton.dataset.intrinsicDisabled = String(reached || !valid);
    addButton.disabled = busy || reached || !valid;
  };
  titleInput.addEventListener('input', syncAddForm);
  urlInput.addEventListener('input', syncAddForm);
  addForm.addEventListener('submit', (event) => {
    event.preventDefault();
    if (links.length >= MAX_LINKS || busy) {
      return;
    }
    if (!isLinkInputValid(titleInput.value, urlInput.value)) {
      syncAddForm();
      (titleInput.value.trim() === '' ? titleInput : urlInput).focus();
      return;
    }
    void actions.create({ title: titleInput.value, url: urlInput.value }).then((created) => {
      if (created) {
        titleInput.value = '';
        urlInput.value = '';
        syncAddForm();
        titleInput.focus();
      }
    });
  });

  setChildren(container, heading, listBox, addForm);

  // --- Helpers ---
  const button = (
    className: string,
    text: string,
    label: string,
    disabled: boolean,
    onClick: () => void,
  ): HTMLButtonElement => {
    const node = h(doc, 'button', {
      class: `button button--small ${className}`,
      text,
      attrs: { type: 'button', 'aria-label': label },
    });
    node.disabled = disabled;
    node.dataset.intrinsicDisabled = String(disabled);
    node.addEventListener('click', onClick);
    return node;
  };

  const applyBusy = (): void => {
    for (const node of container.querySelectorAll<HTMLButtonElement>('button')) {
      node.disabled = busy || node.dataset.intrinsicDisabled === 'true';
    }
    for (const input of [titleInput, urlInput]) {
      input.disabled = busy || links.length >= MAX_LINKS;
    }
    container.setAttribute('aria-busy', busy ? 'true' : 'false');
  };

  const applyLimit = (): void => {
    const reached = links.length >= MAX_LINKS;
    syncAddForm();
    titleInput.disabled = busy || reached;
    urlInput.disabled = busy || reached;
  };

  const clicksNode = (link: AdminLink): HTMLElement =>
    h(
      doc,
      'span',
      { class: 'link-clicks', attrs: { 'data-clicks-for': link.id } },
      h(doc, 'strong', { text: String(clicksOf(link.id)) }),
      ` ${PANEL.clicks.toLowerCase()}`,
    );

  const editForm = (link: AdminLink): HTMLFormElement => {
    const title = h(doc, 'input', {
      class: 'field',
      attrs: {
        id: `edit-title-${link.id}`,
        type: 'text',
        autocomplete: 'off',
        'aria-label': PANEL.titleLabel,
      },
    });
    title.value = link.title;
    const url = h(doc, 'input', {
      class: 'field',
      attrs: {
        id: `edit-url-${link.id}`,
        type: 'url',
        autocomplete: 'off',
        spellcheck: 'false',
        'aria-label': PANEL.urlLabel,
      },
    });
    url.value = link.url;
    const hint = h(doc, 'p', {
      class: 'message message--error',
      text: PANEL.urlNeedsHttps,
      attrs: { id: `edit-url-hint-${link.id}`, hidden: '' },
    });
    url.setAttribute('aria-describedby', hint.id);
    const saveButton = h(doc, 'button', {
      class: 'button button--small button--primary',
      text: PANEL.save,
      attrs: { type: 'submit' },
    });
    const syncEdit = (): void => {
      const valid = isLinkInputValid(title.value, url.value);
      const wrongUrl = urlProblem(url.value);
      hint.toggleAttribute('hidden', !wrongUrl);
      url.setAttribute('aria-invalid', wrongUrl ? 'true' : 'false');
      saveButton.dataset.intrinsicDisabled = String(!valid);
      saveButton.disabled = busy || !valid;
    };
    title.addEventListener('input', syncEdit);
    url.addEventListener('input', syncEdit);

    const form = h(
      doc,
      'form',
      { class: 'edit-form', attrs: { novalidate: '' } },
      title,
      url,
      hint,
      h(
        doc,
        'div',
        { class: 'link-actions' },
        saveButton,
        button('js-cancel', PANEL.cancel, PANEL.cancel, false, () => {
          editingId = null;
          draw();
          focusControl(link.id, 'edit');
        }),
      ),
    );
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (busy || !isLinkInputValid(title.value, url.value)) {
        return;
      }
      void actions.update(link.id, { title: title.value, url: url.value }).then((saved) => {
        if (saved) {
          editingId = null;
          draw();
          focusControl(link.id, 'edit');
        }
      });
    });
    syncEdit();
    queueMicrotask(() => title.focus());
    return form;
  };

  const row = (link: AdminLink, index: number): HTMLLIElement => {
    if (editingId === link.id) {
      return h(
        doc,
        'li',
        { class: 'link-row link-row--editing', attrs: { 'data-link-id': link.id } },
        editForm(link),
      );
    }
    const isFirst = index === 0;
    const isLast = index === links.length - 1;
    return h(
      doc,
      'li',
      {
        class: `link-row${link.active ? '' : ' link-row--inactive'}`,
        attrs: { 'data-link-id': link.id },
      },
      h(
        doc,
        'div',
        { class: 'link-info' },
        h(doc, 'span', { class: 'link-title', text: link.title }),
        h(doc, 'span', { class: 'link-url', text: link.url }),
      ),
      h(
        doc,
        'div',
        { class: 'link-meta' },
        h(doc, 'span', {
          class: `link-state link-state--${link.active ? 'active' : 'inactive'}`,
          text: link.active ? PANEL.stateActive : PANEL.stateInactive,
        }),
        clicksNode(link),
      ),
      h(
        doc,
        'div',
        { class: 'link-actions' },
        button(CONTROL_CLASS.up, PANEL.moveUp, panelLabel.moveUp(link.title), isFirst, () => {
          void actions.move(link.id, -1);
        }),
        button(CONTROL_CLASS.down, PANEL.moveDown, panelLabel.moveDown(link.title), isLast, () => {
          void actions.move(link.id, 1);
        }),
        button(CONTROL_CLASS.edit, PANEL.edit, panelLabel.edit(link.title), false, () => {
          editingId = link.id;
          draw();
        }),
        button(
          CONTROL_CLASS.toggle,
          link.active ? PANEL.deactivate : PANEL.activate,
          panelLabel.toggle(link.title, link.active),
          false,
          () => {
            void actions.update(link.id, { active: !link.active }).then((done) => {
              if (done) {
                focusControl(link.id, 'toggle');
              }
            });
          },
        ),
        button(CONTROL_CLASS.remove, PANEL.remove, panelLabel.remove(link.title), false, () => {
          void actions.remove(link);
        }),
      ),
    );
  };

  function draw(): void {
    if (links.length === 0) {
      setChildren(listBox, h(doc, 'p', { class: 'message', text: PANEL.noLinks }));
    } else {
      setChildren(listBox, h(doc, 'ul', { class: 'link-rows' }, ...links.map(row)));
    }
    applyLimit();
    applyBusy();
  }

  function focusControl(id: string, control: LinkControl): void {
    const item = [...container.querySelectorAll<HTMLElement>('[data-link-id]')].find(
      (node) => node.dataset.linkId === id,
    );
    if (item === undefined) {
      return;
    }
    const pick = (name: LinkControl): HTMLButtonElement | null =>
      item.querySelector<HTMLButtonElement>(`.${CONTROL_CLASS[name]}`);
    let target = pick(control);
    // At the end of the list the arrow that was used is disabled: use the other one.
    if (target?.disabled === true && (control === 'up' || control === 'down')) {
      target = pick(control === 'up' ? 'down' : 'up');
    }
    if (target !== null && !target.disabled) {
      target.focus();
    } else {
      pick('edit')?.focus();
    }
  }

  return {
    render(next, counts) {
      links = next;
      clicksOf = counts;
      if (editingId !== null && !next.some((link) => link.id === editingId)) {
        editingId = null;
      }
      draw();
    },
    updateCounts(counts) {
      clicksOf = counts;
      for (const node of container.querySelectorAll<HTMLElement>('[data-clicks-for]')) {
        const strong = node.querySelector('strong');
        const id = node.dataset.clicksFor;
        if (strong !== null && id !== undefined) {
          strong.textContent = String(counts(id));
        }
      }
    },
    setBusy(next) {
      busy = next;
      applyBusy();
    },
    focusControl,
    focusHeading() {
      heading.focus();
    },
  };
}
