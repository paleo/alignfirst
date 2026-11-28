import { beforeAll, describe, expect, it } from "vitest";

import type { Platform } from "../src/assistant-harness.js";
import { isSurface, SURFACES, type Surface } from "../src/guide/render-template.js";
import { guideContextOf, PLAYBOOK_TOPICS } from "../src/guide/topics.js";
import { NPX_ENV, writeSettings } from "./helpers.js";
import { type Fixture, makeFixture, runAligndev, useProjectFixtures } from "./project/fixtures.js";
import { writeAlignfirstStub } from "./stand-ins.js";

export const CODING_AGENT_VARIANTS: Variant[] = [
  { platform: "codingAgent", label: "codingAgent claude", env: { CLAUDECODE: "1" } },
  { platform: "codingAgent", label: "codingAgent codex", env: { CODEX_THREAD_ID: "thread" } },
  { platform: "codingAgent", label: "codingAgent pi", env: { PI_CODING_AGENT: "true" } },
  { platform: "codingAgent", label: "codingAgent agy", env: { ANTIGRAVITY_AGENT: "1" } },
];
export const OPENCLAW_VARIANTS: Variant[] = [
  { platform: "openclaw", label: "openclaw", env: { ALIGNDEV_ASSISTANT_HARNESS: "openclaw" } },
  ...SURFACES.map(
    (surface): Variant => ({
      platform: "openclaw",
      surface,
      label: `openclaw ${surface}`,
      env: { ALIGNDEV_ASSISTANT_HARNESS: "openclaw" },
    }),
  ),
];

// A harness shows a command's output inline only up to a cap; past it, the assistant reads a fragment.
const SIZE_LIMITS: Record<Platform, number> = { codingAgent: 25_000, openclaw: 40_000 };

// One named profile per agent harness, so `guide code` prints its largest profile table.
const CODING_PROFILES = {
  work: {
    harness: "claude",
    default: true,
    defaultModel: "opus",
    modelAliases: { fast: "model-a" },
  },
  "codex-main": { harness: "codex", defaultEffort: "high" },
  local: { harness: "pi", modelAliases: { quick: "provider/model-b" } },
  gemini: { harness: "agy" },
};
const SETTINGS = {
  projectsRoot: "~/projects",
  code: { fallbackProfile: "work", profiles: CODING_PROFILES },
};
const GUIDE_CALL = /`npx -y aligndev guide(?: --channel (\w+))?(?: ([a-z-]+))?`/g;

interface Render {
  variant: Variant;
  // The arguments of `aligndev guide`.
  args: string[];
  stdout: string;
}

export interface Variant {
  platform: Platform;
  // Absent for a coding agent, and for the OpenClaw guides that take no `--channel`.
  surface?: Surface;
  label: string;
  env: NodeJS.ProcessEnv;
}

// Renders every guide of the variants, then checks the renders.
export function describeRenderedGuides(variants: Variant[]): void {
  const renders: Render[] = [];

  useProjectFixtures();

  describe("rendered guides", () => {
    beforeAll(async () => {
      const fixture = makeFixture();
      writeSettings(fixture.home, SETTINGS);
      for (const variant of variants) {
        for (const args of guideArgsOf(variant)) {
          renders.push(await renderGuide(fixture, variant, args));
        }
      }
    });

    it("stay under the size limit of their platform", () => {
      const offenders = renders
        .filter(({ variant, stdout }) => stdout.length >= SIZE_LIMITS[variant.platform])
        .map((render) => {
          const limit = SIZE_LIMITS[render.variant.platform];
          return `${nameOf(render)}: ${render.stdout.length} characters, limit ${limit}`;
        });
      expect(offenders).toEqual([]);
    });

    it("leave no placeholder and no block marker", () => {
      const offenders = renders.filter(({ stdout }) => stdout.includes("{{")).map(nameOf);
      expect(offenders).toEqual([]);
    });

    it("name only the guide topics served in their context", () => {
      const offenders = renders.flatMap((render) =>
        [...render.stdout.matchAll(GUIDE_CALL)]
          .filter(([, channel, topic]) => !isServed(topic, channel, render.variant))
          .map(([call]) => `${nameOf(render)}: ${call}`),
      );
      expect(offenders).toEqual([]);
    });
  });
}

function guideArgsOf({ platform, surface }: Variant): string[][] {
  if (platform === "openclaw" && surface === undefined) return [[], ["project"]];
  const channel = surface === undefined ? [] : ["--channel", surface];
  const topics = PLAYBOOK_TOPICS[guideContextOf({ platform, surface })];
  return [
    channel,
    ...topics.map((topic) => [...channel, topic]),
    ...Object.keys(CODING_PROFILES).map((name) => [...channel, "code", "--profile", name]),
  ];
}

async function renderGuide(fixture: Fixture, variant: Variant, args: string[]): Promise<Render> {
  const result = await runAligndev(fixture, ["guide", ...args], {
    env: { ...NPX_ENV, ...variant.env },
    alignfirstCommand: writeAlignfirstStub(fixture.base, fixture.root).command,
  });
  const render = { variant, args, stdout: result.stdout };
  if (result.code !== 0) throw new Error(`${nameOf(render)} failed: ${result.stderr}`);
  return render;
}

function nameOf({ variant, args }: Render): string {
  return `\`${["guide", ...args].join(" ")}\` (${variant.label})`;
}

// The dispatcher writes its routes literally: a call that names a surface is checked on that surface.
function isServed(
  topic: string | undefined,
  channel: string | undefined,
  { platform, surface }: Variant,
): boolean {
  if (topic === undefined || topic === "code") return true;
  if (topic === "project") return platform === "openclaw";
  if (channel !== undefined && !isSurface(channel)) return false;
  return PLAYBOOK_TOPICS[guideContextOf({ platform, surface: channel ?? surface })].includes(topic);
}
