import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const [dir, mode, role = "leader"] = process.argv.slice(2);
const stat = readFileSync(`/proc/${process.pid}/stat`, "utf8");
const identity = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
writeFileSync(
  join(dir, `${process.pid}.json`),
  JSON.stringify({ pid: process.pid, identity, role }),
);
if (role === "leaf") {
  if (mode !== "cooperative") process.on("SIGTERM", () => {});
  setInterval(() => {}, 1_000);
} else {
  const create = (name, detached = false, stdio = "inherit") =>
    spawn(process.execPath, [import.meta.filename, dir, mode, name], { detached, stdio });
  if (role === "branch") {
    create("leaf");
    process.on("SIGTERM", () => {});
  } else if (mode === "late") {
    process.on("SIGTERM", () => {
      writeFileSync(join(dir, "term"), "received");
      setTimeout(() => {
        create("branch", true);
      }, 100);
    });
  } else {
    create(
      mode === "grouped" ? "branch" : "leaf",
      mode === "grouped",
      mode === "closed" ? "ignore" : "inherit",
    );
    if (mode === "natural" || mode === "closed") {
      const timer = setInterval(() => {
        if (existsSync(join(dir, "exit"))) {
          clearInterval(timer);
          process.exit(0);
        }
      }, 10);
    }
  }
  setInterval(() => {}, 1_000);
}
