---
description: Asked who holds which files, the agent reads the claims table with the scoped CLI instead of guessing.
tags: [cli, status]
runs: 3
max_turns: 8
timeout_seconds: 180
allowed_tools: [Bash, Read, Skill]
expected_outcome: Runs `scoped status` (or `scoped check`) and reports what it printed, including "no active claims".
---

Another Claude Code session may be working in this repo too. Before I start editing,
which files are claimed by other sessions right now?
