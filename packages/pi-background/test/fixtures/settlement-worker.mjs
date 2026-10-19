import { spawn } from "node:child_process";

if (process.argv[2] === "leaf") {
  process.stdout.write(`${process.pid}\n`);
  process.stdin.resume();
} else {
  const leaf = spawn(process.execPath, [import.meta.filename, "leaf"], { stdio: "pipe" });
  leaf.stderr.pipe(process.stderr);
  leaf.stdout.once("data", (data) => {
    process.stdout.write(`${JSON.stringify([process.pid, Number(data.toString().trim())])}\n`);
  });
  leaf.once("error", (error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
    process.stdin.destroy();
  });
  process.stdin.resume();
  process.stdin.once("end", () => leaf.stdin.end());
  // Waiting for close reaps the direct child before the worker can finish.
  await new Promise((resolve) => leaf.once("close", resolve));
}
