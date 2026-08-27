import type { ScenarioContext } from "@paleo/openclaw-test";

export interface PullRequestFixture {
  url: string;
  number: number;
  title: string;
  headRefName: string;
  baseRefName: string;
  state?: string;
}

export interface GhCall {
  argv: string[];
  cwd?: string;
}

export interface GhMockHandle {
  calls: GhCall[];
}

export function setupGhMock(ctx: ScenarioContext, pullRequest?: PullRequestFixture): GhMockHandle {
  const calls: GhCall[] = [];
  ctx.mockCli("gh", async ({ argv, cwd, stdout }) => {
    calls.push({ argv, cwd });
    if (pullRequest === undefined) return 0;
    if (argv[0] === "pr" && argv[1] === "view") {
      stdout.write(`${JSON.stringify(pullRequestView(pullRequest))}\n`);
      return 0;
    }
    if (argv[0] === "pr" && argv[1] === "diff") {
      stdout.write(pullRequestDiff(pullRequest));
      return 0;
    }
    if (argv[0] === "api" && argv.some((arg) => /\/pulls\/\d+$/u.test(arg))) {
      stdout.write(`${JSON.stringify(pullRequestApiView(pullRequest))}\n`);
      return 0;
    }
    return 0;
  });
  return { calls };
}

function pullRequestView(pullRequest: PullRequestFixture): Record<string, unknown> {
  return {
    ...pullRequest,
    state: pullRequest.state ?? "OPEN",
    body: `Ticket ${pullRequest.headRefName.split("/")[0]}`,
    files: [{ path: "home-page.mjs", additions: 1, deletions: 1 }],
  };
}

function pullRequestDiff(pullRequest: PullRequestFixture): string {
  return `diff --git a/home-page.mjs b/home-page.mjs
index 1111111..2222222 100644
--- a/home-page.mjs
+++ b/home-page.mjs
@@ -1 +1 @@
-export const reviewed = false;
+export const reviewed = true; // PR ${pullRequest.number}
`;
}

function pullRequestApiView(pullRequest: PullRequestFixture): Record<string, unknown> {
  return {
    number: pullRequest.number,
    html_url: pullRequest.url,
    title: pullRequest.title,
    state: (pullRequest.state ?? "OPEN").toLowerCase(),
    head: { ref: pullRequest.headRefName },
    base: { ref: pullRequest.baseRefName },
  };
}
