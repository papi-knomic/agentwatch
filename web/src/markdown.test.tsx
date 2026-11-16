import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./markdown";

const html = (s: string) => renderToStaticMarkup(<div>{renderMarkdown(s)}</div>);

describe("renderMarkdown", () => {
  it("renders headings, lists, bold and code", () => {
    const out = html("## Plan\n- one **bold**\n- two `x`\n  - nested\n\n1. a\n2. b\n\npara");
    expect(out).toContain("<h5>Plan</h5>");
    expect(out).toContain("<strong>bold</strong>");
    expect(out).toContain("<code>x</code>");
    expect(out).toContain("<ul><li>one");
    expect(out).toContain("<ul><li>nested</li></ul>");
    expect(out).toContain("<ol><li>a</li><li>b</li></ol>");
    expect(out).toContain("<p>para</p>");
  });
  it("renders h3/h4 as h6", () => {
    expect(html("### Sub")).toContain("<h6>Sub</h6>");
  });
  it("renders fenced code literally", () => {
    expect(html("```\n- not a list\n**x**\n```")).toContain("<pre><code>- not a list\n**x**</code></pre>");
  });
  it("never emits HTML from the input", () => {
    const out = html("<script>alert(1)</script>\n- <img src=x onerror=alert(1)>\n[a](javascript:alert(1))");
    expect(out).not.toContain("<script");
    expect(out).not.toContain("<img");
    expect(out).not.toContain("<a ");
    expect(out).toContain("&lt;script&gt;");
    expect(out).toContain("&lt;img");
  });
});
