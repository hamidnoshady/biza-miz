/**
 * The collapsed rail keeps every nav link named.
 *
 * A link's accessible name is its text content, minus anything the browser
 * drops from the accessibility tree. `display:none` drops it, so when the
 * shared label used `group-data-[state=collapsed]/sidebar:hidden` every icon
 * row at the 4rem rail was an unnamed link — «فضای کار حسابداری» included. The
 * label must be visually hidden instead (`sr-only`).
 *
 * jsdom does not load Tailwind, so a DOM test cannot see the hiding at all.
 * This test compiles the real `NAV_LABEL_CLASS` with Tailwind's own compiler
 * and asserts on the CSS the browser will receive.
 */
import { compile } from "tailwindcss";
import { describe, expect, it } from "vitest";
import { NAV_LABEL_CLASS } from "./sidebar-nav-styles";

const COLLAPSED_PREFIX = "group-data-[state=collapsed]/sidebar:";

async function compiledCss(classNames: readonly string[]): Promise<string> {
  const compiler = await compile(
    "@layer theme, base, components, utilities; @layer utilities { @tailwind utilities; }",
    { base: process.cwd() },
  );
  return compiler.build([...classNames]);
}

function collapsedTokensOf(className: string): string[] {
  return className.split(/\s+/).filter((token) => token.startsWith(COLLAPSED_PREFIX));
}

describe("NAV_LABEL_CLASS at the collapsed icon rail", () => {
  it("names the rail label with the sr-only variant, not the hidden one", () => {
    const tokens = collapsedTokensOf(NAV_LABEL_CLASS);
    expect(tokens).toEqual([`${COLLAPSED_PREFIX}sr-only`]);
  });

  it("compiles the collapsed label to visually-hidden CSS, never display:none", async () => {
    const css = await compiledCss(collapsedTokensOf(NAV_LABEL_CLASS));
    // The rule exists and is scoped to the collapsed rail.
    expect(css).toContain("sr-only");
    expect(css).toContain('[data-state="collapsed"]');
    // It is the standard visually-hidden recipe: out of flow, one pixel, clipped.
    expect(css).toContain("position: absolute");
    expect(css).toContain("clip-path: inset(50%)");
    // And it never removes the text from the accessibility tree.
    expect(css).not.toContain("display: none");
  });
});
