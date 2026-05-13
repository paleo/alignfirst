---
title: Code Style Guidelines
summary: Code style conventions and formatting rules. Always read before writing code, even for code inside a spec or a plan.
read_when:
  - writing or reviewing code
  - writing code inside a spec or a plan
---

# Code Style Guidelines

## General Rules

- Use UTF-8 encoding with 2-space indentation, 100-char line width
- Dead (unused) code SHOULD NOT be kept (_YAGNI principle_).
- Multiple consecutive blank lines SHOULD NOT be written.
- Changes to linter rules MUST be discussed before being implemented.
- Code SHOULD NOT contain commented out code, unless accompanied by a valid explanation in comments.

## Code Organization

The general rule is: **Usage comes first**, implementation comes after. Except for inheritance: for example, when an interface _extends_ another, write the parent interface first.

- Order code top-down: each file reads as a story, from entry point to leaves. The reader meets the highest-level thing first, then drills down into its dependencies:

  ```ts
  // 1. Imports
  import { ... } from "...";

  // 2. Module-level constants and variables (exported first, then internal)
  export const PUBLIC_CONST = ...;
  const INTERNAL_CONST = ...;

  // 3. Shared types — main type first, then types it references
  export interface MainType {
    detail: DetailType;
  }
  export interface DetailType { ... }

  // 4. Entry-point (exported) function
  export function doThing() {
    stepOne();
    stepTwo();
  }

  // 5. Internal functions called by the entry point, in call order
  function stepOne() {
    stepOneHelper();
  }
  function stepOneHelper() { ... }

  function stepTwo() { ... }
  ```

- Module-level constants and variables (`const`, `let`, `var` value declarations at the top of the file — both exported and internal) MUST be placed immediately after imports, before any type definitions, functions, or classes. This is the first thing a reader sees and treats them as the file's configuration surface.
- Functions: write the caller first, then the functions it calls, recursively. A helper appears _just below_ its caller, not grouped at the bottom of the file. If a helper is called by several siblings, place it after its first caller.
- Types: write the main (top-level) type first, then the types it references, recursively. Same "usage comes first" principle as functions.
- Types attached to a single function (or class, or other declaration) — i.e. used only in that one signature, like a `MyComponentProps` interface used only by `MyComponent` — must be placed immediately before that declaration, not in the top type block.
- Exports are not a sorting criterion on their own: a `function` being `export`ed does not pull it to the top — its position is determined by who calls it. The entry points of a file are usually exported, which is why they tend to appear first, but that is a consequence of the top-down rule, not the rule itself.

## Code Quality Standards

- Strive for elegant solutions from the first implementation
- Avoid redundant operations, especially expensive ones like image conversion
- Avoid duplicated code and logic
- Pass previously calculated values between functions instead of recalculating
- Use early returns to simplify code flow when possible
- For code that leaves the current flow (`throw`, `return`, `continue`, `break`), when it fits on one line, write it on one line (e.g., `if (!condition) return false;` instead of multi-line format)
- Use function and variable names that clearly convey intent, reducing the need for comments
- Keep functions small with a single responsibility
- Avoid using `any`, take the time to find the proper type. If you fail to find a type, then always insert a `/* FIXME */` after your `any`. For example: `let myVariable: any /* FIXME */;`.
- Export only functions (or variables, classes) that are imported from elsewhere. By default, do not export.
- When an interface is used in the signature of an exported function or component, that interface must also be exported.

## Imports

- Always use ESM import syntax for imports (e.g., `import { X } from "y.js"` instead of `require`)
- Avoid import modules recursively.

## TypeScript, JavaScript

- Use the semicolon syntax.
- Prefer double quotes `"`.
- Never use `enum` and `namespace`.
- Prefer `const` over `let`.
- Prefer `undefined` over `null`.
- Prefer `??` over `||`.
- Prefer `++i` and `--i` over `i++` and `i--`.
- Prefer `new Error()` over `Error()`.
- At the top level, prefer the `function` and `class` declarative syntax over creating them as constants.
- Keep an empty line between top-level functions, classes, interfaces.
- Implementation of a getter or setter (EcmaScript 5 syntax) must never throw exceptions.
- Prefer `interface` declarations over `type` aliases.
- Prefer a single capital letter for generics parameters, such as `T`, `K`, etc.
- We don't want to differentiate between an absent property and a property with an `undefined` value.
- Use camelCase for string literal values in TypeScript union types (e.g., `"normal" | "gracefulShutdown" | "backupMode"` instead of `"normal" | "graceful-shutdown" | "backup-mode"`).
- Never use an empty string `""` as a default value unless you really mean an empty string. If a variable might not have a value, use `undefined` or throw an error if the absence of value indicates a problem.
- The existence of string, number, boolean values (and identifiers when they are string or number) must NEVER be tested by coercing to boolean. Use explicit comparisons with `undefined` or `null`.
- The existence of objects and arrays CAN be done by coercing to boolean.
- Never explicitly assign or return `undefined` when it's the default value. Use `return;` instead of `return undefined;` and `let myVariable;` instead of `let myVariable = undefined;`. However, explicitly passing `undefined` is fine when intentionally setting a value.
- Avoid using `as any` or any kind of type assertion. Always make the effort to find the proper type. Except when the type is incorrect or truly unknown: then justify your decision with an inline comment.
- Never re-export, except from the package's main file.
- Avoid using inline `import("some-package-or-module").SomeType`, prefer using direct imports at the top of the file.
- Avoid using inline `await import("some-package-or-module")`, prefer static imports at the top of the file. Except when there is a valid reason to do so, then justify your decision with an inline comment.

## OOP

- Prefer functions over classes.
- Prefer writing functions with a context object instead of a class
- Avoid class inheritance, except in the context of a framework that requires it.

## Adding a package dependency

Every time you need to add a dependency or a devDependency, always search for it in the codebase first, then use the same version as in the codebase.
