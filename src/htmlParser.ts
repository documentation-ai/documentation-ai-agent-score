import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import type { HTMLElement, Node, Options } from 'node-html-parser';

import { HTML_PARSER_VERSION } from './methodology';

/**
 * The HTML parser every check reads pages with, with its two slow steps
 * replaced: one page that left 1,151 lists open ran for over six minutes.
 * The trees are the same. Version 9 is fast, but reads some ordinary pages
 * differently, which would move scores. AFDocs imports the parser itself, so
 * the steps are replaced inside it.
 */

interface ParserModule {
  base_parse(html: string, options?: Partial<Options>): HTMLElement[];
  parse(html: string, options?: Partial<Options>): HTMLElement;
}

/**
 * Removes the elements a page left open and hands their children to the
 * outermost one, moving each child once and not once per level as
 * node-html-parser's `parse` does. `openElements` is its stack: the root, then
 * each open element inside the one before it.
 */
function closeOpenElements(openElements: HTMLElement[]): HTMLElement {
  const [root] = openElements;
  /** Children of the elements removed so far, deepest element first. */
  const hoisted: Node[][] = [];
  while (openElements.length > 2) {
    const last = openElements.pop()!;
    const parent = openElements.at(-1)!;
    parent.removeChild(last);
    hoisted.push(last.childNodes);
    // `<h3> <h3>` reads as `<h3> </h3>`: the first of the pair stays, closed here.
    if (last.tagName === parent.tagName) openElements.pop();
  }
  const receiver = openElements.at(-1)!;
  for (const child of hoisted.reverse().flat()) {
    child.parentNode = receiver;
    receiver.childNodes.push(child);
  }
  return root;
}

/**
 * The parser's own `Node.remove`, which it runs for every node it adds. It
 * copied all the siblings even then, when the node is not among them yet.
 */
function remove(this: Node): Node {
  if (!this.parentNode) return this;
  const siblings = this.parentNode.childNodes;
  const index = siblings.indexOf(this);
  if (index !== -1) this.parentNode.childNodes = siblings.toSpliced(index, 1);
  this.parentNode = null as unknown as HTMLElement;
  return this;
}

/** Replaces the slow steps in the parser `requireFrom` loads, if it is the version they were written for. */
function replaceSlowSteps(requireFrom: NodeJS.Require) {
  const parserRoot = dirname(dirname(requireFrom.resolve('node-html-parser')));
  if (requireFrom(join(parserRoot, 'package.json')).version !== HTML_PARSER_VERSION) return;
  const parserModule: ParserModule = requireFrom(join(parserRoot, 'dist/nodes/html.js'));
  parserModule.parse = (html, options = {}) => {
    const openElements = parserModule.base_parse(html, options);
    return options.parseNoneClosedTags ? openElements[0] : closeOpenElements(openElements);
  };
  requireFrom(join(parserRoot, 'dist/nodes/node.js')).default.prototype.remove = remove;
}

const requireHere = createRequire(import.meta.url);
replaceSlowSteps(requireHere);
// AFDocs' copy is the same one, unless npm installed two.
replaceSlowSteps(createRequire(requireHere.resolve('afdocs')));

export { parse, type HTMLElement } from 'node-html-parser';
