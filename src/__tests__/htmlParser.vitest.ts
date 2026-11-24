import { createRequire } from 'node:module';

import { createContext, getCheck } from 'afdocs';
import type { HTMLElement } from 'node-html-parser';
import { describe, expect, it } from 'vitest';

import { parse } from '../htmlParser';

/** The parser as npm installs it, loaded afresh so the replaced steps are not in it. */
function loadOriginalParse(): typeof parse {
  const requireHere = createRequire(import.meta.url);
  for (const path of Object.keys(requireHere.cache)) {
    if (path.includes('/node-html-parser/')) delete requireHere.cache[path];
  }
  return requireHere('node-html-parser').parse;
}

const parseAsInstalled = loadOriginalParse();

/** A tree as text, with each node's recorded parent checked, so a moved child cannot keep its old one. */
function describeTree(node: HTMLElement): string {
  return node.childNodes
    .map((child) => {
      expect(child.parentNode).toBe(node);
      const element = child as HTMLElement;
      const text = element.tagName ? `<${element.tagName} ${element.rawAttrs}>${describeTree(element)}</>` : child.rawText;
      return `${child.range}${text}`;
    })
    .join('|');
}

function expectSameTree(html: string) {
  const expected = parseAsInstalled(html);
  const actual = parse(html);
  expect(describeTree(actual)).toBe(describeTree(expected));
  for (const root of [expected, actual]) root.querySelectorAll('span, a').forEach((element) => element.remove());
  expect(describeTree(actual)).toBe(describeTree(expected));
}

const ELEMENTS = ['ul', 'li', 'div', 'p', 'span', 'a', 'table', 'tr', 'td', 'h3', 'main', 'html', 'my-card'];
/** Twice as many start tags as end tags, so most pages leave some elements open. */
const MARKUP_PIECES = [
  ...ELEMENTS.flatMap((name) => [`<${name}>`, `<${name} id=x>`, `</${name}>`]),
  ...['text', '<br>', '<img src=a>', '<!-- note -->', '<pre>code</pre>'],
];

/** Repeatable pseudo-random markup: the same seed always gives the same page. */
function randomMarkup(seed: number): string {
  let state = seed;
  const nextBelow = (limit: number) => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return Math.floor((state / 2_147_483_648) * limit);
  };
  const pieces = Array.from({ length: 2 + nextBelow(60) }, () => MARKUP_PIECES[nextBelow(MARKUP_PIECES.length)]);
  return pieces.join('');
}

async function timeMs(work: () => unknown): Promise<number> {
  const startedAt = Date.now();
  await work();
  return Date.now() - startedAt;
}

describe('the tree', () => {
  it.each([
    ['nothing open', '<div><p>One</p></div>'],
    ['one element open', '<main><div><p>One</p></main>'],
    ['a pair of the same element', '<main><h3>One<h3>Two</main>'],
    ['a pair at the top', '<h3>One<h3>Two'],
    ['several levels open', '<html><body><main>a<ul><li>b</li><div>c<ul>d'],
    ['an end tag with no start', '</div><p>One'],
    ['no markup', 'text'],
    ['an empty page', ''],
  ])('is the one the installed parser builds for %s', (_, html) => expectSameTree(html));

  it('is the one the installed parser builds for malformed markup of every kind', () => {
    for (let seed = 1; seed <= 5_000; seed++) expectSameTree(randomMarkup(seed));
  });
});

describe('the time', () => {
  const openLists = '<div><ul><li><a href=/docs/x/>Item</a></li></div>';

  it.each([
    ['lists left open', openLists.repeat(5_000)],
    ['table rows with no end tags', '<tr><td>a<td>b'.repeat(5_000)],
    ['definition lists with no end tags', '<dt>a<dd>b'.repeat(5_000)],
    ['custom elements left open', '<div><my-icon><p>x</p></div>'.repeat(5_000)],
    ['thousands of nodes side by side', 'text<br>'.repeat(15_000)],
  ])('is short for %s', async (_, body) => {
    expect(await timeMs(() => parse(`<main>${body}</main>`))).toBeLessThan(3_000);
  });

  it('is short in the checks AFDocs runs', async () => {
    const context = createContext('https://docs.acme.test', { samplingStrategy: 'none' });
    const html = `<!doctype html><html><body><main>${openLists.repeat(2_000)}</main></body></html>`;
    context.http = { fetch: async () => new Response(html, { headers: { 'content-type': 'text/html' } }) };
    expect(await timeMs(() => getCheck('tabbed-content-serialization')!.run(context))).toBeLessThan(3_000);
  });
});
