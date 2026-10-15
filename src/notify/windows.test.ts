import { describe, expect, it } from "vitest";
import { buildToastXml } from "./windows.js";

describe("buildToastXml", () => {
  it("escapes text and the launch URL", () => {
    const xml = buildToastXml({
      title: `Claude · <demo> & "co"`,
      body: "Use 'Bash'?",
      sound: "default",
      clickUrl: "http://127.0.0.1:7878/?a=1&b=2",
    });
    expect(xml).toContain("<text>Claude · &lt;demo&gt; &amp; &quot;co&quot;</text>");
    expect(xml).toContain("<text>Use &apos;Bash&apos;?</text>");
    expect(xml).toContain(`activationType="protocol" launch="http://127.0.0.1:7878/?a=1&amp;b=2"`);
    expect(xml).toContain("ms-winsoundevent:Notification.Default");
  });

  it("supports silent toasts and no click action", () => {
    const xml = buildToastXml({ title: "t", body: "b", sound: "silent" });
    expect(xml).toContain(`<audio silent="true"/>`);
    expect(xml).not.toContain("launch=");
  });
});
