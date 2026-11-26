---
name: sharp-testing
description: Rules for unit and integration tests. Read before implementing a feature, fixing a bug, refactoring, or writing and changing these tests. E2E test design is outside this skill's scope.
license: CC0 1.0
metadata:
  author: Paleo
  version: "0.4.1"
  repository: https://github.com/paleo/paleo-skills
---

# Sharp Testing

A test earns its place by detecting a plausible mistake that no other check detects. The default for a change is no new test.

## When a test is justified

A permanent test answers: which plausible mistake would it catch, which existing check would miss it, and why would the mistake matter. Name the incorrect behavior and its consequence; that the code could change is no answer. Inspect the relevant tests first, and extend one when it can cover the missing case.

New functions, branches, files, and uncovered lines call for no test by themselves. Coverage locates gaps; it never justifies a test. Getters, pass-through code, constructors, type-level guarantees, and framework behavior need no test. A change with no new test is valid when existing protection suffices.

## Expected values

Expected values come from the requirement: the domain rule, the specification, the compatibility obligation. The implementation shows what the code does, never what it should do.

An expectation generated with the code under test, or copied from its output into a snapshot, fails only when the code changes. That is a change detector, not a guard. Validate a captured output against the requirement before adopting it as a fixture or a snapshot.

## What to assert

Assert behavior: computed results, selected data, state changes, emitted events, access controls. Leave incidental fields, helper calls and internal ordering unconstrained. A behavior-preserving refactor leaves assertions intact.

Exact representations require an executable or machine-readable contract. Name its consumer or compatibility obligation. Public visibility alone establishes neither.

An interaction is asserted only when the interaction is the contract, such as sending a notification exactly once.

A rejection test exercises the intended guard. Failing earlier for an unrelated reason proves nothing.

One behavior per test, named after the behavior.

## Presentation belongs to the product

Code and templates own wording and presentation. Never assert authored copy: labels, help, diagnostics, documentation.

UI components, rendering and event wiring need no unit tests. Test algorithms and domain rules directly, including frontend logic. Critical user interactions belong to E2E tests.

Assert output data without fixing the surrounding prose. Test text processing through extraction, preservation, escaping or redaction of supplied input.

## Real code, substituted boundaries

The production logic responsible for the claimed behavior runs for real. Substitute only what lies outside it: network, external services, clock, randomness, queues.

A mock shows that a call was requested, never its effect: a mocked write proves nothing about persistence. A mock that implements the asserted behavior proves the mock.

An export, flag, wrapper, or hook whose only caller is a test is a design smell. Test through a real boundary instead.

## Choosing the boundary

- Pure logic (calculations, algorithms, state transitions, edge cases): a focused unit test.
- Wiring, persistence, lifecycle: one test exercising real collaboration at the boundary, with hermetic dependencies, instead of a mocked unit test per layer.

Each contract has one owner. A second layer must exercise a risk the owner cannot reach: transport, persistence, concurrency, lifecycle, authorization. Business-rule cases are proved once, at their owner.

## Choosing cases

Pick representative cases, meaningful boundaries, and relevant failure paths: one case per distinct defect, not per input variation. When a general invariant expresses the requirement, one property test replaces many examples. Near-duplicates become one table-driven test, unless they protect different boundaries. Setup stays readable; helper chains hide the evidence.

## Bug fixes

One regression test, at the owning boundary. It fails on the defective code for the bug's reason and passes after the fix. When the baseline cannot be run, say so.

## Hygiene

Small fixtures, isolated state, controlled time and randomness, completion signals instead of sleeps.
