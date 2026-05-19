#!/usr/bin/env node
import { dispatch } from "../dist/cli.js";

dispatch(process.argv.slice(2)).catch((err) => {
  console.error("openclaw-qa-runner crash:", err);
  process.exit(1);
});
