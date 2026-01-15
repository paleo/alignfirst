# How to Write a Technical Specification

## Pre-requisites

You need:

- the TASK_DIR - if you don't have it, use your instructions for finding the **ticket ID**, or ask the user
- the current CYCLE_LETTER and the next FILE_NUMBER - deduce them yourself - by default, start with a new cycle (bump the CYCLE_LETTER, reset the FILE_NUMBER to 1)

Identify and state these values before starting the protocol.

## Phases

When the user asks you for a SPEC (technical specification), you MUST follow this process:

1. **Investigation Phase**: Research the codebase to understand the current implementation and identify the problem
2. **Discussion Phase**: Collaborate with the user to explore the problem space and potential solutions BEFORE writing the specification file
3. **Specification Phase**: Only after user approval, write the final specification file

The discussion phase is MANDATORY. Remember that you are a newcomer to this project while the user has extensive experience with the codebase and will be happy to help guide you.

## Phase 1. Investigation Phase

Investigate the codebase yourself, find the relevant source code, think carefully, take the time to understand how it currently works and what has to be done. If the Context7 MCP is available, feel free to use it.

## Phase 2. Discussion Phase

Engage in a thorough collaborative discussion covering:

- **Problem exploration**: Present your understanding of the problem and ask clarifying questions
- **Current implementation analysis**: Share what you discovered and ask for confirmation or corrections
- **Multiple solution approaches**: Present several viable alternatives when they exist, explaining trade-offs
- **Sub-subject identification**: Break down the problem into all relevant sub-components and ensure each is addressed
- **Design decisions**: Ask for user input on key architectural choices
- **Edge cases and implications**: Explore potential issues and broader system impacts

You should ask questions freely to ensure you fully understand:

- The problem context and requirements
- Existing patterns and conventions in the codebase
- User preferences for implementation approaches
- Any constraints or considerations you might have missed

## Phase 3. Specification Phase

After the user approves your proposal, write the specification in a markdown file in TASK_DIR. Compose the filename with the current CYCLE_LETTER and the next FILE_NUMBER, e.g. `A1-spec.md`. Do not overwrite an existing file.

- List the skills required for implementing the specification (e.g., "Required skills: code-style, testing")
- Usually a specification is around 40~60 lines
- **Do not add backward compatibility** unless explicitly requested. Prefer clean code. Unused code must be removed.
- A specification is not always immediately executed, and you have to assume that the code can change before it is executed. You can mention a function by name, but NEVER mention specific line numbers as they will become obsolete
- Do not include any detailed code in the specification. Instead, refer to the relevant source files by their paths or function names
- Do not include sections like "Benefits", "Code Style Compliance" or anything that adds no new information. Focus on the problem and the solution

_Important Note: There will be lint errors in the markdown file you write. Ignore them. NEVER FIX LINT ERRORS (FORMATTING ISSUES) IN THE SPEC._
