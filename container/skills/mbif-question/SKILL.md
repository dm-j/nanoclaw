---
name: mbif-question
description: Query the MBIF knowledge vault. Use this to look up facts about people, projects, places, or events stored in the vault. Always prefer this over relying on memory for personal or project-specific information.
---

# MBIF Vault — Question Tool

Use the `question` command to look up information from the MBIF knowledge vault. The vault's seeker agent will search the notes, cite sources, and report its confidence.

## Usage

```bash
question "When is David's birthday?"
question "Where does David teach Pound?" --bullet
question "When is my birthday?" --ask-as David
question "What is the Vector project?" --bullet
```

## Flags

- `--ask-as <name>` — Resolves first-person references ("my", "I", "me") to the named person. Use when the question contains pronouns that need a specific subject.
- `--bullet` — Returns the answer as bullet points. Useful for lists, comparisons, or multi-part answers.

## What you get back

Every answer includes:
- The answer itself
- **Sources** — which note(s) and section(s) the information came from
- **Confidence** — high / medium / low

If confidence is low or sources are thin, say so when relaying the answer. Don't present uncertain vault information as fact.

## When to use it

- Any question about a specific person, project, place, or event that might be in the vault
- Resolving ambiguous references ("my project", "the Tuesday meeting")
- Fact-checking something you're not sure about

Do not use it for general knowledge questions with no personal or project context — the vault answers from its notes, not the open web.
