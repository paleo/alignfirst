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

- Order code: (1) exported and internal vars, (2) type definitions (public first, then private), (3) exported/public functions, (4) internal/helper functions
- Follow function order: Calling functions first, helper functions after
- Type definition ordering: types shared by several functions go at the top of the file (after imports and module-level constants), public types first, then private types. Apply the "usage comes first" principle recursively within each group (a type used as a member of another type comes after it).
- Types attached to a single function (or class, or other declaration) — i.e. used only in that one signature, like a `MyComponentProps` interface used only by `MyComponent` — must be placed immediately before that declaration, not in the top type block.

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
