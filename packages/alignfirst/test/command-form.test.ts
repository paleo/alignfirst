import { describe, expect, it } from "vitest";

import { renderCommandForm, resolveCommandForm } from "../src/command-form.js";

describe("command form", () => {
  it("uses the installed binary outside a package runner", () => {
    expect(resolveCommandForm({})).toBe("alignfirst");
    expect(resolveCommandForm({ npm_config_user_agent: "" })).toBe("alignfirst");
  });

  it("uses npx inside a package runner", () => {
    expect(resolveCommandForm({ npm_config_user_agent: "npm/11" })).toBe("npx -y alignfirst");
  });

  it("renders every placeholder", () => {
    expect(renderCommandForm("{{CMD}} guide; {{CMD}} ticket", "alignfirst")).toBe(
      "alignfirst guide; alignfirst ticket",
    );
  });
});
