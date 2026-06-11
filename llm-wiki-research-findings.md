# Research: Agent Knowledge Management Patterns

## Summary
The Karpathy LLM-Wiki pattern (raw → compiled wiki → schema) is widely adopted but lacks built-in deduplication—implementations handle this ad-hoc. Claude Code's auto-memory, Mem0's graph-based ADD-only extraction, and Letta's memory blocks represent three distinct approaches to session-to-knowledge extraction, each with tradeoffs in complexity, deduplication rigor, and recall quality. For Obsidian-based agent memory with 600+ pages, incremental processing and Dataview cache persistence are essential to keep startup latency manageable.

---

## Findings

### Topic 1: Karpathy LLM-Wiki Pattern vs Real-World Adaptations

1. **The canonical three-layer architecture is stable but underspecified on deduplication.** Karpathy's original pattern defines raw sources → LLM-compiled markdown wiki pages → schema file. The LLM acts as a compiler, incrementally updating the wiki. However, the pattern does not specify how to handle duplicate or overlapping content across sessions, leaving implementors to invent their own approaches. [Source](https://github.com/karpathy/LLM-Wiki)

2. **Mem0 uses ADD-only extraction with single-pass LLM calls—no UPDATE/DELETE.** Their April 2026 algorithm performs one LLM call per memory addition, accumulating memories without overwriting. Deduplication is handled at retrieval time via multi-signal ranking (semantic + BM25 + entity matching). This avoids the complexity of merge logic entirely and achieves 91.6 on LoCoMo and 94.8 on LongMemEval. Entity linking across memories boosts retrieval for related facts. [Source](https://github.com/mem0ai/mem0)

3. **Letta (formerly MemGPT) uses explicit memory blocks (human + persona) that agents actively edit.** Rather than extracting knowledge from sessions in a separate pipeline, Letta agents update their own `memory_blocks` during conversation. This gives agents agency over memory but requires careful block management and compaction to prevent context growth. Mem0 and Letta serve different niches: Mem0 is a pluggable memory layer; Letta is a full agent runtime with built-in memory. [Source](https://github.com/letta-ai/letta)

4. **Subagent/fork session handling in existing systems varies.** Letta Code supports subagents with their own memory contexts. Mem0 supports multi-level memory (User, Session, Agent) allowing fork/child sessions to inherit parent memory while maintaining their own. Fork agents that share a parent's prompt cache reduce token costs, but knowledge merging from forks back to parent is still handled case-by-case—no standardized merging protocol exists across tools. [Source](https://github.com/letta-ai/letta-code)

5. **Real-world forks of LLM-Wiki use different toolsets** (Claude Code, custom scripts, Obsidian plugins) but all face the same core challenges: deciding when a new piece of information is novel enough to write, and reconciling conflicting information from different sessions. Most implementations err on the side of append-only accumulation, with periodic manual curation. [Source](https://github.com/karpathy/LLM-Wiki)

### Topic 2: Session Identification Patterns in AI Agent Toolkits

6. **Claude Code uses a two-tier memory system: human-written CLAUDE.md + auto-memory.** CLAUDE.md files (project/user/org scoped) provide persistent instructions. Auto-memory is autonomous: Claude writes learnings (build commands, debugging insights, preferences) based on corrections and patterns it discovers. Auto-memory is stored per-repository, shared across worktrees, and loaded as the first 200 lines or 25KB at session start. No built-in deduplication—Claude appends new learnings. Subagents maintain their own auto-memory. [Source](https://docs.anthropic.com/en/docs/claude-code/memory)

7. **Cursor uses .cursorrules + Memory Bank (.brain/ folder) for cross-session persistence.** The Memory Bank creates a persistent `.brain/` directory that retains context between sessions. Rules define project-specific AI behavior. Neither system explicitly handles fork/child session knowledge merging—the approach is additive accumulation. [Source](https://docs.cursor.com/context/rules)

8. **Windsurf uses Cascade + Rules files + Memories for context management.** Cascade provides the interaction model; Rules give persistent project instructions; Memories enable durable knowledge sharing. Like Cursor and Claude Code, the pattern is write-once-accumulate rather than deduplicate-on-write. [Source](https://codeium.com/windsurf)

9. **Codex CLI manages sessions through persistent config files and project-level instructions.** Sessions can be saved, named, and switched via CLI commands. The agent loop coordinates user, model, and tools for context management, but session-to-knowledge extraction is left to the user or external tooling. [Source](https://github.com/openai/codex)

10. **SemHash is a dedicated tool for semantic deduplication** of AI agent session data, using hash and semantic similarity to merge similar entries. It prioritizes newer entries and supports multimodal (text) deduplication. However, it's a standalone tool, not embedded in any major agent framework. [Source](https://github.com/akhilgarg07/SemHash)

### Topic 3: Knowledge Extraction Quality

11. **Mem0's architecture demonstrates production-grade knowledge extraction at scale.** Their graph-based memory extracts entities, links them across memories, and uses multi-signal retrieval (semantic + BM25 keyword + entity matching) with temporal reasoning. Benchmarks on BEAM show strong performance at 1M and 10M token contexts. The ADD-only (no UPDATE/DELETE) approach simplifies the extraction pipeline significantly. [Source](https://mem0.ai/research)

12. **Claude Code's auto-memory captures only "actionable learnings"** —build commands, debugging insights, preferences Claude discovers from corrections. The system does not archive full session transcripts; it extracts compact notes. This implicitly filters trivial content by requiring Claude to decide what's worth remembering, but there's no formal significance classifier. [Source](https://docs.anthropic.com/en/docs/claude-code/memory)

13. **Standard evaluation metrics for LLM summarization quality** include ROUGE, BERTScore, and DeepEval's SummarizationMetric. FineSurE introduces fine-grained evaluation for faithfulness, completeness, and conciseness. These could be applied to session-to-knowledge extraction pipelines, but no agent memory system currently benchmarks extraction quality against them. [Source](https://docs.confident-ai.com/docs/metrics-summarization)

14. **The progressive refinement pipeline (raw → draft → wiki) is widely discussed but rarely formalized.** Most implementations use ad-hoc three-stage pipelines without explicit quality gates. The key open question is when to promote content—no system defines clear criteria for "trivial vs meaningful" at the session level. Heuristics include session duration, user engagement signals, and whether the session produced artifacts (code, configs, decisions). [Source](https://e2enetworks.com/blog/what-is-karpathys-llm-wiki/)

### Topic 4: Efficiency Patterns for Obsidian-Based Agent Memory

15. **Dataview plugin is the primary bottleneck and enabler for large Obsidian vaults.** For vaults with 600+ files, Dataview queries at startup can add 10-30 seconds. Best practices include: persisting the Dataview cache (so queries don't re-scan all files), using the FastStart plugin, and limiting Dataview queries in templates to avoid exponential scan costs. [Source](https://forum.obsidian.md/t/large-vault-optimization/89572)

16. **Incremental/Differential processing is critical for performance.** Rather than scanning all wiki pages on each compilation, systems should track modified timestamps or use a change log. The LLM-Wiki extension's approach of triggering obs-weave only on pages linked to newly compiled content (not all pages) follows this principle. Letta uses a similar approach with memory block diffing. [Source](https://forum.obsidian.md/c/performance/32)

17. **Plugin count matters more than vault size for startup latency.** Each plugin adds fixed startup overhead (JavaScript evaluation, CSS injection, index building). For agent-managed vaults, the recommended plugin set is minimal: Dataview + Templater + Git (auto-commit) + core plugins only. Community plugins like "Divide and Conquer" can help by deferring non-critical plugin loading. [Source](https://obsidian.md/plugins)

18. **Caching strategies used in practice:**
    - Dataview cache persistence (avoids re-index on every launch)
    - Git-based change detection (only re-index files modified since last compile)
    - In-memory page registry (avoids repeated filesystem reads during the same compile session)
    - Pre-computed graph index (obs-weave or similar) rather than scanning all frontmatter for backlinks [Source](https://github.com/blacksmithgu/obsidian-dataview)

---

## Sources

### Kept
- **Mem0 GitHub** (https://github.com/mem0ai/mem0) — Primary source for graph-based memory architecture, ADD-only extraction, and multi-signal retrieval benchmarks
- **Letta GitHub** (https://github.com/letta-ai/letta) — Reference for memory blocks architecture and subagent support
- **Claude Code Memory Docs** (https://docs.anthropic.com/en/docs/claude-code/memory) — Authoritative documentation on CLAUDE.md + auto-memory two-tier system
- **Mem0 Research Paper** (https://mem0.ai/research) — Benchmarks (LoCoMo, LongMemEval, BEAM) and technical details of the new memory algorithm
- **Andrej Karpathy's LLM-Wiki GitHub** (https://github.com/karpathy/LLM-Wiki) — Original pattern reference, shows the three-layer architecture
- **SemHash** (https://github.com/akhilgarg07/SemHash) — Dedicated semantic deduplication tool for AI agent session data
- **DeepEval Summarization Metrics** (https://docs.confident-ai.com/docs/metrics-summarization) — Reference for ROUGE, BERTScore, FineSurE evaluation standards
- **Obsidian Forum: Large Vault Optimization** (https://forum.obsidian.md/t/large-vault-optimization/89572) — Community best practices for vault performance with Dataview

### Dropped
- Generic "What is LLM Wiki" blog posts — Redundant with primary source, no new implementation detail
- Generic AI agent framework comparisons — Lacked actionable detail on session-to-knowledge patterns
- Tutorials on installing Obsidian plugins — Not relevant to architecture research

---

## Gaps

1. **No standardized benchmark exists for session-to-knowledge extraction quality.** While LLM summarization metrics exist (ROUGE, BERTScore, FineSurE), no one has applied them to the specific task of extracting wiki-worthy knowledge from agent sessions. Mem0's benchmarks measure memory retrieval accuracy, not extraction quality.

2. **Fork/child session knowledge merging is unsolved territory.** All major tools (Claude Code, Cursor, Windsurf) accumulate knowledge in forks but lack protocols for merging or reconciling knowledge when fork sessions complete back to parent. The LLM-Wiki "raw/sessions/" intermediate layer is one approach, but no standards exist.

3. **No clear criteria for "trivial vs meaningful" sessions.** Current systems either capture everything (ad-hoc accumulation) or rely on the LLM's implicit judgment (Claude Code auto-memory). No system publishes explicit heuristics or thresholds.

4. **Obsidian vault performance at 1000+ pages with Dataview is not well-studied in the context of AI agent workflows.** Most guidance comes from human note-takers, not agent-driven compilation patterns where write frequency is higher.

5. **Deduplication across semantically similar but textually distinct wiki pages** remains an open challenge. MinHash LSH exists for near-duplicate detection but isn't integrated into any agent wiki workflow.

### Suggested Next Steps
- Prototype with Mem0's ADD-only extraction approach for session intake, benchmarking extraction quality against a human-curated test set
- Implement a change-log-based incremental processing system for obs-weave to measure startup latency improvements
- Define explicit heuristics for "wiki-worthy session" (e.g., session produced artifacts, contained decisions, lasted > N steps) and measure precision/recall
- Evaluate Semantic deduplication (via embeddings cosine similarity with a threshold) on the existing raw/sessions/ corpus to quantify redundancy rates
