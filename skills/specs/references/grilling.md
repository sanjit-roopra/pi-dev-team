# Grilling: resolve open decisions in rounds

Loaded by Step C of [`../SKILL.md`](../SKILL.md). pi port addition, adapted from
Matt Pocock's `grilling` and `domain-modeling` skills
(https://github.com/mattpocock/skills, MIT, Copyright (c) 2026 Matt Pocock).

Interview the user until you share one understanding of the change. A single
batch of questions misses the questions that depend on its answers, so work in
rounds.

## Rounds

1. Map the open decisions as a tree: each decision has the decisions that hang
   off it.
2. The **frontier** is every open decision whose prerequisites are settled.
   Ask the whole frontier in one round, with one `ask_user` call and one
   question per decision. A question that depends on another question in this
   round waits for a later round.
3. Each question follows "Questions (ask_user)" from the system
   prompt: a short header, a `why` line, and your recommended answer first,
   marked (recommended), so "yes" accepts it.
4. Log every question and answer in the spec's `## Decision Log` (round,
   question, answer, source: `user`, `assumed (timeout)` or
   `assumed (no human)`).
5. Recompute the frontier from the answers and ask the next round.
6. Stop when the frontier is empty. Then ask once: "Did I get it right?" with
   a 3-line summary. Finalize the criteria only after a yes (or a timeout).

## Facts are yours, decisions are theirs

Never ask the user for a fact you can look up. Read the code, or dispatch an
`Explore` agent. Only the decisions that depend on that fact wait for it; ask
the rest of the frontier now.

## Sharpen the language

- Check every term against `.plans/domain/` (format: the `ubiquitous-language`
  skill). Call out a conflict: "Your glossary says X, you seem to mean Y."
- Propose a precise term for a vague one: "account: Customer or User?"
- Test the model with a concrete edge case.
- Check the user's claims against the code, and say when they disagree.
- When a term is settled, write it to `.plans/domain/<Concept>.md` at once
  (create the folder on first use). No implementation details there.
- Offer an ADR (`adr-tools` skill) only when the decision is hard to reverse,
  surprising without context, and the result of a real trade-off.

## When nobody answers

`ask_user` reports a timeout, or that no human is attached. Then:

- Take that round's recommended answers and log them `assumed (timeout)` or
  `assumed (no human)`.
- Stop grilling. Do not build later rounds on guesses.
- Put the open branches at the top of the spec as `## Decide these`, and at
  the top of the PR (the `/pr` note).
- "continue grilling" from the user resumes at the open frontier.

## Skip grilling

A tiny change (one sentence, a few files, no open decisions) needs no rounds
and no `.plans/domain/` writes.
