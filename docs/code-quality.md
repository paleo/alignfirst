---
title: Code Quality & Refactoring
summary: Code quality principles and refactoring guidelines.
read_when:
  - refactoring or improving code quality
---

# Code Quality & Refactoring

## Code Quality Process

A developer in our team just finished an implementation. But he is a newcomer, so you need to ensure that the code is clean, maintainable, and efficient, as it may not meet our standards yet.

Read the files that were modified, if it's all good just say it's OK. Otherwise, improve the implementation, apply the following principles to ensure the code is clean, maintainable, and efficient.

### SRP - Single Responsibility Principle

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
- When there is an ArkType, declare it outside the function, just before the function.

### DRY - Don't Repeat Yourself

Each time you see duplicated logic, take the time to refactor it into a reusable function.

### YAGNI - You Aren't Gonna Need It

Do not keep unused code such as variables, functions, implementations, etc.

## Orange Flags

- Most of the time, fallbacks to empty string or zero are not there for a good reason: look for `?? ""` and `?? 0` and ensure it is a proper use. If not, take the time to understand the typing and find an elegant way to handle the compiling issue.
  - Notice: A good use case for `?? ""` is when we want an empty string value in the UI.
- Type assertions (`as SomeType`) are often a sign of misunderstood typing.
- In general, avoid using `any` and find the proper type. Sometimes we really want to use `any` so it's allowed but then we want a comment to explain why.
- Do not use `ReturnType<T>` or `Parameters<T>` if you can import the actual type.
- Do not use `SomeType["someMemberName"]` if you can import the actual type.

## Remove Unnecessary Comments

Remove inline comments that are redundant with the code itself.

Only keep inline comments that document hacks, TODOs, or exceptional situations, or when the code's purpose isn't obvious from its structure.

Never repeat the code in comments. The following comment must be removed:

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
