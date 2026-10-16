import { describe, expect, it } from "vitest";
import type { DesktopNotification } from "./types.js";
import { buildToastXml } from "./windows.js";

const base: DesktopNotification = {
  title: "t",
  body: "b",
  sound: "default",
  status: "needs_input",
  color: "#d97757",
};

describe("buildToastXml", () => {
  it("escapes text and the launch URL", () => {
    const xml = buildToastXml({
      ...base,
      title: `Claude · <demo> & "co"`,
      body: "Use 'Bash'?",
      clickUrl: "http://127.0.0.1:7878/?a=1&b=2",
    });
    expect(xml).toContain("<text>Claude · &lt;demo&gt; &amp; &quot;co&quot;</text>");
    expect(xml).toContain("<text>Use &apos;Bash&apos;?</text>");
    expect(xml).toContain(`activationType="protocol" launch="http://127.0.0.1:7878/?a=1&amp;b=2"`);
    expect(xml).toContain("ms-winsoundevent:Notification.Default");
  });

  it("supports silent toasts and no click action", () => {
    const xml = buildToastXml({ ...base, sound: "silent" });
    expect(xml).toContain(`<audio silent="true"/>`);
    expect(xml).not.toContain("launch=");
    expect(xml).not.toContain("<actions>");
    expect(xml).not.toContain("<image");
  });

  it("adds the attribution line, status icon and buttons", () => {
    const xml = buildToastXml(
      {
        ...base,
        attribution: "Claude Code · VS Code",
        actions: [{ label: "Open dashboard", url: "http://127.0.0.1:7878" }],
      },
      "file:///C:/Users/dev/.orchestrator/icons/d97757-needs_input.png",
    );
    expect(xml).toContain(`<text placement="attribution">Claude Code · VS Code</text>`);
    expect(xml).toContain(
      `<image placement="appLogoOverride" hint-crop="circle" src="file:///C:/Users/dev/.orchestrator/icons/d97757-needs_input.png"/>`,
    );
    expect(xml).toContain(
      `<actions><action content="Open dashboard" activationType="protocol" arguments="http://127.0.0.1:7878"/></actions>`,
    );
  });
});
