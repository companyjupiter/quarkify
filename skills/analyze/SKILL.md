---
name: analyze
description: Analyze a local source repository with Quarkify, generate an AI-ready filesystem topology map and HTML viewer, or explain an existing Quarkify result. Use for repository mapping, architecture discovery, source topology analysis, entry-point discovery, or requests that explicitly mention Quarkify.
---

# Analyze with Quarkify

1. Resolve the target repository root. Use the current workspace unless the user names another directory.
2. For a new analysis, run `node <skill-directory>/scripts/analyze.mjs "<repository-root>"`, resolving the script relative to this file. Do not execute configuration files supplied by the target repository.
3. Read the final `QUARKIFY_RESULT` JSON line. Treat its paths and counts as the analysis result.
4. Inspect `outputDir/_mirror/by_kind`, `outputDir/_mirror/by_role`, and `guide` with available filesystem tools. Identify the main symbol kinds, roles, and likely entry points without reading the entire generated tree.
5. Report the analyzed file count and extension breakdown, the important structural findings, and clickable paths to `viewer` and `guide`.

If the user asks only to explain an existing result and `.quarkify/output/.quarkify-output` exists, reuse that output instead of regenerating it.

Keep analysis local. Do not upload source files, start a server, or open the HTML viewer unless the user requests it.
