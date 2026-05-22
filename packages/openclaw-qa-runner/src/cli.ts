import { copyFile, mkdir, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startBus } from "./bus.js";
import { main as runnerMain } from "./runner.js";

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export async function dispatch(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "init":
      await initCommand(rest[0]);
      return;
    case "bus":
      startBus();
      return;
    case "run":
      await runnerMain(rest);
      return;
    default:
      usage();
  }
}

async function initCommand(targetDirRaw: string | undefined): Promise<void> {
  if (!targetDirRaw) usage();
  const target = resolve(process.cwd(), targetDirRaw);
  const templatesDir = join(PACKAGE_DIR, "templates");
  await mkdir(target, { recursive: true });
  const entries = await readdir(templatesDir);
  for (const name of entries) {
    await copyFile(join(templatesDir, name), join(target, name));
    console.log(`copied ${name} -> ${join(target, name)}`);
  }
}

function usage(): never {
  console.error(
    "usage: openclaw-qa-runner <init|bus|run> [args]\n\n" +
      "  init <target-dir>   copy templates into target dir\n" +
      "  bus                 start the bus HTTP server\n" +
      "  run [flags] [...]   execute scenarios (see runner.ts)\n",
  );
  process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  dispatch(process.argv.slice(2)).catch((err) => {
    console.error("openclaw-qa-runner crash:", err);
    process.exit(1);
  });
}
