// @ts-expect-error test-only Node built-in; the Worker tsconfig omits Node types
import { readFileSync } from "node:fs";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";

/** Extract `langSel.onchange = () => { ... }` body from the listener page. */
function langChangeBody(): string {
  const source = ts.createSourceFile(
    "listener.js",
    readFileSync("public/js/pages/listener.js", "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  let body = "";
  const visit = (node: ts.Node) => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      node.left.getText(source) === "langSel.onchange" &&
      (ts.isArrowFunction(node.right) || ts.isFunctionExpression(node.right))
    ) {
      body = node.right.body.getText(source);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!body) throw new Error("langSel.onchange not found");
  return body;
}

describe("listener language change and the slide overlay", () => {
  it("redraws the slide when the listener picks a new language", () => {
    // Without drawSlide(), the designed/translated overlay stays in the old language
    // until the speaker advances or a slidetr message arrives — which feels like a
    // long wait even when every language was already translated.
    expect(langChangeBody()).toMatch(/\bdrawSlide\s*\(/);
  });
});
