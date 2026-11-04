// Tiny helpers to build the Panel's DOM.
//
// Everything is made with `createElement` and `textContent`, never `innerHTML`: a
// link title such as `<script>` is shown as text and creates no element
// (Requirement 14.9). SVG properties are set as attributes, not as `style`,
// because the Panel's CSP does not allow inline styles.

export interface Props {
  readonly class?: string;
  readonly text?: string;
  readonly attrs?: Readonly<Record<string, string>>;
}

type Child = Node | string | null | undefined;

function apply(node: Element, props: Props, children: readonly Child[]): void {
  if (props.class !== undefined) {
    node.setAttribute('class', props.class);
  }
  if (props.text !== undefined) {
    node.textContent = props.text;
  }
  for (const [name, value] of Object.entries(props.attrs ?? {})) {
    node.setAttribute(name, value);
  }
  for (const child of children) {
    if (child !== null && child !== undefined) {
      node.append(child);
    }
  }
}

/** Creates an HTML element with its class, text, attributes and children. */
export function h<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  props: Props = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  apply(node, props, children);
  return node;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Creates an SVG element. */
export function s<K extends keyof SVGElementTagNameMap>(
  doc: Document,
  tag: K,
  props: Props = {},
  ...children: Child[]
): SVGElementTagNameMap[K] {
  const node = doc.createElementNS(SVG_NS, tag);
  apply(node, props, children);
  return node;
}

/** Replaces everything inside `container` with the given children. */
export function setChildren(container: Element, ...children: Child[]): void {
  container.replaceChildren(
    ...children.filter((child): child is Node | string => child !== null && child !== undefined),
  );
}
