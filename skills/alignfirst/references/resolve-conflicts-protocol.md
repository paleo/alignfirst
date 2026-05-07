# How to Resolve Merge Conflicts

## Pre-requisites

You need:

- the TASK_DIR - if you don't have it, use your instructions for finding the **ticket ID**, or ask the user
- the CYCLE_LETTER and FILE_NUMBER — continue the current cycle (same CYCLE_LETTER, bump FILE_NUMBER)

Identify and state these values before starting the protocol.

---

This protocol applies when a branch was just merged (or rebased) and there are conflicts. Follow the steps below.

## 1. Investigate

Take the time to understand how things work in the base branch and in the current branch. For each conflicting file, read enough surrounding context to understand the intent on both sides.

## 2. Resolve

Resolve the conflicts properly — preserve both intents whenever possible. Do not blindly accept one side.

**Special case for lock files:** If a lock file has conflicts:

1. Accept all the changes from the base branch.
2. After all other conflicts are resolved, run the proper install command so the package manager re-applies the current branch's dependency changes.

## 3. Summarize

Write your summary in a new file `{CYCLE_LETTER}{FILE_NUMBER}-resolve-conflicts.summary.md` in the TASK_DIR.

**Keep it lean.** Only document challenging conflicts and the choices made to resolve them. Do not list straightforward resolutions — if everything was trivial, the summary should be almost empty (just a header and a one-line note that there was nothing tricky). Do not include a commit message — git already provides one for merges.

Example:

```markdown
# Resolve Conflicts Summary - [very short title]

## Notable resolutions

- `path/to/file.ts`: [what made it tricky and which choice was made, in one or two sentences]

## Lock file

[Only if there was a lock file conflict: which lock file, which install command was run]
```

Omit any section with nothing to report.

_Ignore markdown lint errors in the summary file._

At the end, give the path of the summary file to the user.
