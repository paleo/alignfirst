import assert from "node:assert/strict";
import type { ScenarioContext } from "@alignfirst/openclaw-test";
import { execCommandOf } from "./agent-tool-calls.ts";
import { OLD_HISTORY } from "../../scripts/lightweight-fixture.ts";
import { setupCodingAgentMock } from "./mock-coding-agent.ts";
import { setupGhMock } from "./mock-gh.ts";
import { NIMBUS_PROJECT_PATH } from "./project-fixtures.ts";
import { resetFixtures } from "./reset-fixture.ts";
import { bootstrapThreadFromChannel, sendInThread } from "./thread-bootstrap.ts";
import { waitForThreadSettlement } from "./thread-settlement.ts";

const SCRIPT = "/opt/alignfirst/aligndev-openclaw-tests/scripts/lightweight-fixture.ts";
const REQUEST = `Sur nimbus, sans ticket, améliore le libellé d'export.

- Remplace Export par Download dans label.mjs.
- Adapte le test label.test.mjs et exécute npm test.
- Ne pousse rien.`;

interface Snapshot {
  branches: string;
  worktrees: string;
  registry: string;
  companionExists: boolean;
  projectPlans: string[];
  history?: string;
}

export async function runLightweightApprovalCase(
  ctx: ScenarioContext,
  mode: "missing" | "tracked",
): Promise<void> {
  await resetFixtures(ctx);
  await gatewayNode(
    ctx,
    `const {prepareLightweightFixture} = await import(${JSON.stringify(SCRIPT)});
    prepareLightweightFixture({repo: ${JSON.stringify(NIMBUS_PROJECT_PATH)}, plans: ${JSON.stringify(mode)}});`,
  );
  const before = await snapshot(ctx);
  const coding = setupCodingAgentMock(ctx, {
    onPrompt: async (gateway, cwd, prompt) => {
      assert.notEqual(cwd, NIMBUS_PROJECT_PATH, "coding requires an already-created worktree");
      assert.match(prompt, /side-1/);
      const outcome = await gatewayNode(
        gateway,
        `
        const fs = await import('node:fs'); const cp = await import('node:child_process');
        const git = (...args) => cp.execFileSync('git', args, {cwd:${JSON.stringify(cwd)},encoding:'utf8'}).trim();
        if (!git('branch','--show-current').startsWith('side-1/')) throw Error('wrong branch');
        const config = JSON.parse(cp.execFileSync('alignfirst',['config','--json'],{cwd:${JSON.stringify(cwd)},encoding:'utf8'}));
        const plans = config.locations['.plans'].path;
        if (fs.existsSync(plans+'/old-history.md')) throw Error('old history copied');
        const request = fs.readFileSync(plans+'/side-1/A1-request.md','utf8');
        const {assertCapturedRequest} = await import(${JSON.stringify(SCRIPT)});
        assertCapturedRequest(request);
        if (fs.lstatSync(${JSON.stringify(cwd)}+'/.git').birthtimeMs < fs.statSync(plans+'/side-1/A1-request.md').birthtimeMs)
          throw Error('worktree created before request capture');
        fs.writeFileSync(plans+'/side-1/mock-access.md','Read request and wrote companion with normal mock permissions.\\n');
        fs.writeFileSync(${JSON.stringify(cwd)}+'/label.mjs','export const label = "Download";\\n');
        fs.writeFileSync(${JSON.stringify(cwd)}+'/label.test.mjs',fs.readFileSync(${JSON.stringify(cwd)}+'/label.test.mjs','utf8').replace('"Export"','"Download"'));
        const result = cp.spawnSync('npm',['test'],{cwd:${JSON.stringify(cwd)},encoding:'utf8'});
        if(result.status!==0) throw Error(result.stdout+result.stderr);
        const noCommit = ${JSON.stringify(/do not commit|don't commit|ne .{0,20}commit/i.test(prompt))};
        if (!noCommit) {
          git('add','label.mjs','label.test.mjs');
          git('-c','user.name=test','-c','user.email=test@local','commit','-qm','update export label');
        }
        console.log('Changed label to Download; npm test passed (1 test). '+(noCommit?'Left uncommitted.':'Committed locally.')+' No server or push.');
      `,
      );
      return outcome.trim();
    },
  });
  setupGhMock(ctx);
  const starter = await bootstrapThreadFromChannel(ctx, {
    text: REQUEST,
    project: "nimbus",
    projectPath: NIMBUS_PROJECT_PATH,
    request: REQUEST,
  });
  const target = await ctx.waitForAgentToolCall(
    (call) => call.sessionKey?.includes(starter.threadId) === true,
    {
      label: "observe the native target session",
      timeoutMs: 120_000,
    },
  );
  assert(target.sessionKey !== undefined);
  const targetSessionKey = target.sessionKey;
  const approval = await ctx.waitForOutbound(
    (message) =>
      message.threadId === starter.threadId &&
      ((/companion|compagnon/i.test(message.text) && /[?？]/u.test(message.text)) ||
        /(?:ID|identifiant) du ticket/i.test(message.text)),
    {
      sinceCursor: starter.nextCursor,
      timeoutMs: 180_000,
      failFastUnmatchedOutbounds: false,
    },
  );
  await waitForThreadSettlement(ctx, targetSessionKey);
  const paused = await snapshot(ctx);
  assert.deepEqual(
    paused,
    before,
    "approval must precede registry/plans/ticket/branch/worktree effects",
  );
  assert.equal(coding.codingAgentCalls.length, 0, "no delegation before approval");
  await ctx.judgeLLM({
    attachTo: approval.entry,
    message: approval.match.text,
    label: `${mode}-plans-approval`,
    rubric:
      mode === "tracked"
        ? "Asks permission to select companion work files because project plans are tracked. Explains the shared selection affects all worktrees. Leaves old files untouched and does not offer or ask to copy/migrate them."
        : "Asks permission to prepare companion work files because plans are missing, before reserving a side ticket or creating a worktree.",
  });
  await sendInThread(
    ctx,
    starter.threadId,
    "Oui, prépare et sélectionne le companion pour les fichiers de travail de tous les worktrees, " +
      "puis continue sans ticket externe. Laisse les fichiers existants intacts.",
  );
  const call = await coding.waitForCall({
    predicate: (call) => call.cwd !== NIMBUS_PROJECT_PATH && call.stdin.includes("side-1"),
    timeoutMs: 240_000,
  });
  await waitForThreadSettlement(ctx, targetSessionKey);
  const state = await gatewayNode(
    ctx,
    `
    const fs = await import('node:fs'); const cp = await import('node:child_process');
    const main=${JSON.stringify(NIMBUS_PROJECT_PATH)};
    const inventory=JSON.parse(cp.execFileSync('alignfirst',['workspace','list','--json'],{cwd:main,encoding:'utf8'}));
    const selected=inventory.workspaces.find(entry=>entry.branch?.startsWith('side-1/'));
    if(!selected || selected.path!==${JSON.stringify(call.cwd)}) throw Error('delegation did not use the registered ticket worktree');
    const worktree=selected.path;
    const config=JSON.parse(cp.execFileSync('alignfirst',['config','--json'],{cwd:worktree,encoding:'utf8'}));
    const plans=config.locations['.plans'].path;
    const registry=JSON.parse(fs.readFileSync(process.env.HOME+'/.alignfirst/companions/registry.json','utf8'));
    const key=Object.keys(registry.projects).find(key=>(key.startsWith('~/')?process.env.HOME+'/'+key.slice(2):key)===main);
    const entry=registry.projects[key];
    if(!entry || entry.items?.['.plans']!=='companion') throw Error('companion not explicitly selected');
    if(Object.keys(registry).some(key=>key!=='projects')) throw Error('unexpected registry fields created');
    if(fs.existsSync(plans+'/old-history.md')) throw Error('history copied');
    if(!fs.existsSync(plans+'/side-1/mock-access.md')) throw Error('mock did not finish');
    if(!fs.existsSync(plans+'/side-1/_aligndev') || fs.readdirSync(plans+'/side-1/_aligndev').length===0) throw Error('session not in companion');
    if(${JSON.stringify(mode)}==='tracked' && fs.readFileSync(worktree+'/.plans/old-history.md','utf8')!==fs.readFileSync(main+'/.plans/old-history.md','utf8')) throw Error('tracked worktree history changed');
    if(fs.existsSync(worktree+'/.plans') && fs.lstatSync(worktree+'/.plans').isSymbolicLink()) throw Error('redundant companion link');
    console.log(JSON.stringify({plans,history:${JSON.stringify(mode)}==='tracked'?fs.readFileSync(main+'/.plans/old-history.md','utf8'):null,
      mainBranch:cp.execFileSync('git',['branch','--show-current'],{cwd:main,encoding:'utf8'}).trim()}));
  `,
  );
  const final = JSON.parse(state);
  assert.equal(final.mainBranch, "main");
  if (mode === "tracked") assert.equal(final.history, OLD_HISTORY);
  const calls = await ctx.getAgentToolCalls();
  const commands = calls.map(execCommandOf).filter((command) => command !== undefined);
  const register = commands.findIndex((command) => /companion\s+register/.test(command));
  const reserve = commands.findIndex((command) => /ticket\s+--side/.test(command));
  const add = commands.findIndex((command) => /alignfirst\s+workspace\s+setup/.test(command));
  assert(
    register >= 0 && reserve > register && add > reserve,
    "separate companion preparation must precede ticket reservation and real worktree add",
  );
  assert(
    !commands.some((command) => /\b(?:cp|rsync)\b[^\n]*\.plans/.test(command)),
    "no history copying",
  );
  ctx.log(`Verified ${mode} plans: ${final.plans}; delegation from ${call.cwd}; npm test passed.`);
  ctx.markScenarioAsEnded("PASS");
}

async function snapshot(ctx: ScenarioContext): Promise<Snapshot> {
  return JSON.parse(
    await gatewayNode(
      ctx,
      `
    const fs=await import('node:fs'); const cp=await import('node:child_process');
    const cwd=${JSON.stringify(NIMBUS_PROJECT_PATH)};
    const git=(...args)=>cp.execFileSync('git',args,{cwd,encoding:'utf8'}).trim();
    const config=JSON.parse(cp.execFileSync('alignfirst',['config','--json'],{cwd,encoding:'utf8'}));
    const registry=process.env.HOME+'/.alignfirst/companions/registry.json';
    console.log(JSON.stringify({branches:git('branch','--format=%(refname)'),worktrees:git('worktree','list','--porcelain'),
      registry:fs.existsSync(registry)?fs.readFileSync(registry,'utf8'):'',
      companionExists:config.companion!==null && fs.existsSync(config.companion.dir),
      projectPlans:fs.existsSync(cwd+'/.plans')?fs.readdirSync(cwd+'/.plans').sort():[],
      ...(fs.existsSync(cwd+'/.plans/old-history.md')?{history:fs.readFileSync(cwd+'/.plans/old-history.md','utf8')}:{})}));
  `,
    ),
  );
}

async function gatewayNode(ctx: ScenarioContext, source: string): Promise<string> {
  const result = await ctx.execInGateway(["node", "--input-type=module", "-e", source], {
    timeoutMs: 30_000,
  });
  if (result.exitCode !== 0)
    throw new Error(`Lightweight fixture command failed: ${result.stderr}`);
  return result.stdout;
}
