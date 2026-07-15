---
name: sharp-writing
description: Conventions for writing sharp, concise prose and Markdown, for human readers and AI agents. Read before writing documentation, READMEs, instructions, agent skills, or any prose text.
license: CC0 1.0
metadata:
  author: Paleo
  version: "0.2.0"
  repository: https://github.com/paleo/skills
---

# Sharp Writing

Write sharp text: every word counts. These rules cover all prose and Markdown. Most hold for both human readers and AI agents; only the em-dash style differs.

## Principles

- Sharp, precise, concise. Straight to the point. The less, the better.
- Don't pad. No bloated orders, no filler.
- Respect the reader. No insistent or authoritarian tone; don't treat them like a child. Make what is important more obvious instead.
- No emoticons. No informal language.

## Structure text like code

Good text is like good code:

- Avoid repeating or duplicating.
- Refactor text as you refactor code, so every idea is well-organized and clear.

One idea, one sentence. One concern, one paragraph. When a concern needs several paragraphs, give it a section title; split a complex idea into sub-ideas the same way. Never pack several ideas into one sentence, or several concerns into one paragraph.

Show the direct path, not your detours. Writing is like climbing an uncharted mountain: you wander and backtrack to find the way, then from the summit you see the straight route. Write that route. Readers want the direct path, not the search that found it.

## Prefer positive phrasing

Say what is, not what is not. A negation forces the reader to invert; a double negation forces two inversions.

## Markdown

Don't wrap text to 80 characters. Let lines run freely.

## Em-dash: the one audience difference

The em-dash (`—`) is the main style difference between the two audiences.

- **For humans**: use the em-dash only as a visual separator.
- **For AI agents**: the em-dash is also fine inside prose.

Valid for both, as a visual separator:

> - `key1` — description 1
> - `key2` — description 2

Valid only for AI agents, inside a sentence:

> State the main idea — then add a caveat after the dash.
