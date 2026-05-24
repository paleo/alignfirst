import { copyFile, mkdir, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startBus } from "./bus.js";
import { envCommand, qaCommand } from "./env-cli.js";
import { main as runnerMain } from "./runner.js";

// `dist/cli.js` ships under `<package>/dist/`; one level up from its dir is the package root.
const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export async function dispatch(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "init":
      await initCommand(rest[0]);
      return;
    case "env":
      envCommand(PACKAGE_DIR, rest);
      return;
    case "qa":
      await qaCommand(PACKAGE_DIR, rest);
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
    "usage: openclaw-qa-runner <init|env|qa|bus|run> [args]\n\n" +
      "  init <target-dir>      copy templates into target dir\n" +
      "  env <build|up|down>    drive the Compose stack (host-side)\n" +
      "  qa [flags] [...]       run scenarios against the stack (host-side)\n" +
      "  bus                    start the bus HTTP server (inside container)\n" +
      "  run [flags] [...]      execute scenarios (inside container)\n",
  );
  process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  dispatch(process.argv.slice(2)).catch((err) => {
    console.error("openclaw-qa-runner crash:", err);
    process.exit(1);
  });
}
