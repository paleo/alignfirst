---
name: sharp-writing
description: Conventions for writing sharp, concise prose and Markdown, for human readers and AI agents. Read before writing documentation, READMEs, instructions, agent skills, or any prose text.
license: CC0 1.0
metadata:
  author: Paleo
  version: "0.6.0"
  repository: https://github.com/paleo/skills
---

# Sharp Writing

Write sharp text: every word counts. These rules cover all prose and Markdown. Most hold for both human readers and AI agents; only the em-dash style differs.

## Find the essence first

Before writing anything, find the essence of the idea. State the essence. State it well.

## Principles

- Sharp, precise, concise. Straight to the point. The less, the better.
- Easy language. Keep sentences short and clear.
- Don't pad. No bloated orders, no filler.
- Respect the reader. No insistent or authoritarian tone; don't treat them like a child. Make what is important more obvious instead.
- Keep a formal register.

## Keep a formal register

Stay professional, without stiffness. Write complete sentences; don't clip the opening. Use proper vocabulary: the precise word, even an elaborate one. Technical terms are fine when exact; slang and casual jargon are not. No emoticons.

## Structure text like code

Good text is like good code:

- Avoid repeating or duplicating.
- Refactor text as you refactor code, so every idea is well-organized and clear.

One idea, one sentence. One concern, one paragraph. When a concern needs several paragraphs, give it a section title; split a complex idea into sub-ideas the same way. Never pack several ideas into one sentence, or several concerns into one paragraph. A sentence that chains clauses with colons and dashes is packing — split it.

Show the direct path, not your detours. Writing is like climbing an uncharted mountain: you wander and backtrack to find the way, then from the summit you see the straight route. Write that route. Readers want the direct path, not the search that found it.

## Prefer positive phrasing

Say what is, not what is not. A negation forces the reader to invert; a double negation forces two inversions.

## Cut the negated echo

A common reflex: affirm, then restate the same idea negated — "X is A, not B", where B is merely the absence of A. Cut the negated half.

## Stop at the last fact

End when the information ends. Don't close with a sentence that restates the point, draws a moral, or justifies what you just wrote. Before keeping a final sentence, check it carries a new fact or instruction. If it only emphasizes, concludes, or reassures, cut it.

## Add an example only when needed

Add an example only when the rule is hard to grasp without one. Prose that stands on its own needs none.

When you add one, invent a neutral case.

## Markdown

Don't wrap text to 80 characters. Let lines run freely.

## Em-dash: the one audience difference

The em-dash (`—`) is the main style difference between the two audiences.

- **For humans**: use the em-dash only as a visual separator.
- **For AI agents**: the em-dash is also fine inside prose. Except that a precise, to-the-point sentence rarely needs one.

Valid for both, as a visual separator:

> - `key1` — description 1
> - `key2` — description 2

Valid only for AI agents, inside a sentence:

> State the main idea — then add a caveat after the dash.
