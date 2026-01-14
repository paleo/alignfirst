# Align-and-Do Protocol (AAD)

## Pre-requisites

You need:

- the TASK_DIR - if you don't have it, use your instructions on finding the **ticket ID**, or ask the user
- the current CYCLE_LETTER and the bumped FILE_NUMBER - deduce them yourself

Identify and state these values before starting the protocol.

## Phases

When the user initiates an Align-and-Do Protocol, you MUST follow this four-phase process:

1. **Investigation Phase**: Research the codebase to understand the current implementation and context
2. **Discussion Phase**: Collaborate with the user to explore the problem/solution space BEFORE taking action
3. **Action Phase**: Only after user approval, implement the agreed-upon solution
4. **Summary Phase**: Write a brief summary of what was discussed, decided, and done

The discussion phase is MANDATORY. Remember that you are a newcomer to this project while the user has extensive experience with the codebase and will be happy to help guide you.

## Phase 1. Investigation Phase

Investigate the codebase yourself, find the relevant source code, think carefully, take the time to understand how it currently works and what needs to be done. If the Context7 MCP is available, feel free to use it.

List all available _skills_ and read each one whose description applies to any aspect of the task.

Your goal is to build a solid understanding of:

- The current implementation and relevant code paths
- How the system currently behaves
- What needs to change or be addressed
- Potential approaches and their implications

## Phase 2. Discussion Phase

Engage in a thorough collaborative discussion covering:

- **Problem/Goal exploration**: Present your understanding and ask clarifying questions
- **Current implementation analysis**: Share what you discovered and ask for confirmation or corrections
- **Approach evaluation**: Discuss potential solutions and their trade-offs
- **Edge cases and implications**: Explore potential issues and broader system impacts

You should ask questions freely to ensure you fully understand:

- The context and requirements
- Existing patterns and conventions in the codebase
- User preferences for implementation approaches
- Any constraints or considerations you might have missed

**Remember**: This discussion happens BEFORE any implementation or formal specification writing.

## Phase 3. Action Phase

**Important: always ensure the user approves your proposal before implementing anything!**

### Before doing any work

After agreeing with the user on what needs to be done and how, create a first version of your summary file as a **working document**. Write it in TASK_DIR, composing the filename using the current CYCLE_LETTER and the bumped FILE_NUMBER, then append `-AAD.summary.md`. For example, if the last file is `E5-plan-something.md`, create `E6-AAD.summary.md`. Do not overwrite an existing file.

The initial content can be a brief outline of what you plan to do. For example:

```markdown
# AAD Summary - Short Title Here - (In Progress)

Skills Used: **skill-name-1**, **skill-name-2**

Brief description of the problem/goal

## Plan

- [ ] ... Step 1 ...
- [ ] ... Step 2 ...
```

Note: The list of used skills should exclude `alignfirst`.

### During implementation

Decide whether to use your subagent tool based on the nature of the work:

- **Work alone** when the task is small enough to be manageable
- You can decide to **use subagents** when you encounter:
  - **Stack boundaries**: Different technologies or specialization areas requiring distinct skills or custom agents
  - **Distinct logical units**: Separate features or modules large enough to warrant isolation

Each subagent invocation should target a **coherent, completable unit of work**. Avoid splitting work that is tightly coupled.

Update the summary file during implementation progress if there is something significant to report. This provides real-time visibility and crash resilience.

## Phase 4. Summary Phase

Rewrite and clean up the summary file, keeping only the final summary of what was done. Remove the "- (In Progress)" marker and the step-by-step progress tracking.

The final summary should capture:

- What was the topic or problem
- Which skills were consulted (exclude alignfirst)
- What was decided or discovered
- What action was taken (if any)
- Key outcomes or next steps

Keep it concise—the shorter the better.

_Important Note: There will be lint errors in the markdown file you write. Ignore them. NEVER FIX LINT ERRORS (FORMATTING ISSUES) IN THE SUMMARY._
