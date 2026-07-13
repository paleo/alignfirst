---
name: top-down-typescript
description: TypeScript and JavaScript coding style conventions, centered on top-down narrative ordering (caller first, helpers below) and functions over classes. Read before writing or reviewing TypeScript/JavaScript code, including code inside a spec or a plan.
license: CC0 1.0
metadata:
  author: Paleo
  version: "0.3.0"
  repository: https://github.com/paleo/skills
---

# Top-Down TypeScript Coding Style

## General Rules

- Dead (unused) code SHOULD NOT be kept (_YAGNI principle_).
- Do not write multiple consecutive blank lines.
- Changes to linter rules MUST be discussed before being implemented.
- Code SHOULD NOT contain commented-out code, unless a comment explains why.

## Code Organization

**Usage comes first**, implementation after. Exception: with inheritance — when an interface _extends_ another, write the parent first.

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

- Module-level constants and variables (`const`, `let`, `var` value declarations at the top of the file — both exported and internal) MUST be placed immediately after imports, before any type definitions, functions, or classes. The reader sees them first and treats them as the file's configuration surface.
- Functions: write the caller first, then the functions it calls, recursively. A helper appears _just below_ its caller, not grouped at the bottom of the file. If a helper is called by several siblings, place it after its first caller.
- Types: write the main (top-level) type first, then the types it references, recursively. Same top-down rule as functions.
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
- Avoid `any`; take the time to find the proper type. If you fail to find one, always insert a `/* FIXME */` after the `any`. For example: `let myVariable: any /* FIXME */;`.
- Export only functions (or variables, classes) that are imported from elsewhere. By default, do not export.
- When an interface is used in the signature of an exported function or component, that interface must also be exported.

## Imports

- Always use ESM import syntax (e.g., `import { X } from "y.js"` instead of `require`).
- Avoid circular imports between modules.

## TypeScript, JavaScript

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
- Do not differentiate between an absent property and a property with an `undefined` value.
- Use camelCase for string literal values in TypeScript union types (e.g., `"normal" | "gracefulShutdown" | "backupMode"` instead of `"normal" | "graceful-shutdown" | "backup-mode"`).
- Never use an empty string as a default value unless you really mean an empty string. If a variable might not have a value, use `undefined` or throw an error if the absence of value indicates a problem.
- The existence of string, number, boolean values (and identifiers when they are string or number) must NEVER be tested by coercing to boolean. Use explicit comparisons with `undefined` or `null`.
- Existence checks for objects and arrays MAY use boolean coercion.
- Never explicitly assign or return `undefined` when it is the default value. Use `return;` instead of `return undefined;` and `let myVariable;` instead of `let myVariable = undefined;`. Explicitly passing `undefined` is fine when intentionally setting a value.
- Avoid `as any` or any kind of type assertion. Always make the effort to find the proper type. Exception: when the type is incorrect or truly unknown — justify with an inline comment.
- Never re-export, except from the package's index file.
- Avoid inline `import("some-package-or-module").SomeType`; prefer direct imports at the top of the file.
- Avoid inline `await import("some-package-or-module")`; prefer static imports at the top of the file. Exception: when there is a valid reason — justify with an inline comment.

## OOP

- Prefer factory functions over classes.
- Prefer writing functions with a context object instead of a class.
- Avoid class inheritance, except in the context of a framework that requires it.

## Adding a package dependency

Before adding a dependency or dev-dependency, search the codebase first and reuse the version already in use. If not found, install the latest version using the default install command.

## Commit, PR/MR, and changeset messages

Never add AI attribution — `Co-Authored-By: …`, "Generated with …", or similar — to a commit, PR, MR, or changeset message.

## Changeset messages

Write for someone already using the project who wants to know what changed, in a few words. Mention only what is actionable for them; skip the _why_ and the internal details. Always a single short paragraph.

- New feature: name it in a few words.
- Extends a feature: title it if obvious, otherwise "Improved the {X} feature."
- Nothing actionable (for example documentation or refactoring): stay succinct, like "Improved documentation about {topic}."

When a version mixes actionable and non-actionable changes (for example a big refactoring plus a small feature), mention only the actionable one. Mention non-actionable changes only when there is nothing else for the user.

## Improving code quality

### SRP - Single Responsibility Principle

Think of it as **narrative decomposition**: the caller reads like a paragraph that names what happens; each helper expands one sentence of that paragraph.

For example, this code:

```ts
export function myFunction() {
  // Check something
  // ... 20 lines ...

  // Do something
  // ... 20 lines ...
}
```

… should be refactored in:

```ts
export function myFunction() {
  checkSomething();
  doSomething();
}

function checkSomething() {
  // ... 20 lines ...
}

function doSomething() {
  // ... 20 lines ...
}
```

Guidelines:

- Always write the sub-function _after_ the caller function.
- Do not export a function unless it is imported from outside the source file.
- Apply the _Single Responsibility Principle_ when dividing code: one function for one concern.
- Avoid exceeding the height of one screen (~50 lines) for function implementations.
- Keep code clean and self-explanatory rather than adding explanatory comments.

### DRY - Don't Repeat Yourself

Each time you see duplicated logic, take the time to refactor it into a reusable function.

### YAGNI - You Aren't Gonna Need It

Do not keep unused code such as variables, functions, implementations, etc.

### Warning signs

- Fallbacks to empty string or zero rarely have a good reason: review every `?? ""` and `?? 0` and confirm it is intentional. Otherwise, understand the typing and find an elegant fix.
  - Note: a valid use case for `?? ""` is when the UI requires an empty string.
- Type assertions (`as SomeType`) are often a sign of misunderstood typing.
- Avoid `any` and find the proper type. When `any` is truly needed, add a comment explaining why.
- Do not use `ReturnType<T>` or `Parameters<T>` if you can import the actual type.
- Do not use `SomeType["someMemberName"]` if you can import the actual type.

### Remove Unnecessary Comments

- About comments: the fewer the better. Comments are read by skilled developers. Each comment must be sharp, concise, straight to the point. Each word must be carefully weighted and chosen.
- Remove comments that are redundant with the code itself.
- Only keep inline comments that document hacks, TODOs, or exceptional situations, or when the code's purpose isn't obvious from its structure.
- Do not use comments as annotations for justifying the task you are currently working on.

The following comment must be removed:

```ts
// Create a new task
createANewTask();
```

Other examples of inline comments that are obvious and must be removed:

```ts
// Validate that there is a file
if (!file) throw new ApiError(400);

// Validate and parse the request body according to the expected schema
const validated = UploadBodyAT.assert(body);
```

JSDoc comments should only be used when they add meaningful information. Example of a comment that must be entirely removed because everything is obvious:

```ts
/**
 * This function adds two numbers
 * @param a - The first number
 * @param b - The second number
 * @returns The sum of the two numbers
 */
function addTwoNumbers(a: number, b: number) {
  return a + b;
}
```
