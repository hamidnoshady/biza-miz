# Issue #812 — AI subsystem rebuild — implementation plan

Working branch: `arena/01a10aea-biza-miz`

Baseline (verified before any change):
- `npx tsc --noEmit` → clean
- `npm test` → 570 files / 7502 tests green

## Phase 1 — security/runtime correctness
- [ ] §14 `stockCount` executor reads canonical `stock_movements` on-hand
- [ ] §16 provider cost from partial/failed/cancelled multi-round calls is not lost
- [ ] §15 tenant currency preference (Rial/Toman) flows through the AI runtime
- [ ] §13 unattended writes recheck current authority immediately before execution
- [ ] §17 conversation loading / stream finalizer races are generation-guarded
- [ ] §18 no forced autoscroll while reading older content
- [ ] §19 partial/cancelled replies are visibly marked

## Phase 2 — remove duplicated local infrastructure
- [ ] §1 application-owned semantic answer cache removed
- [ ] §2 application-owned pgvector RAG/reindex stack removed
- [ ] tenant-isolated managed knowledge integration (LiteLLM/AI infrastructure)

## Phase 3 — Superadmin control plane
- [ ] §7 Auto / Instant / Deep Research runtime modes resolve configurable LiteLLM aliases
- [ ] §8 one live prompt resolver (base → mode → agent → business type → app → memory → task → tools)
- [ ] §5 system-wide Agent builder + versioning
- [ ] §6 Superadmin assigns agents to tenants through suggestion cards

## Phase 4 — tenant-side cleanup
- [ ] §4 tenant Agent Builder / picker / API removed
- [ ] §11 tenant AI management exposes only product-level controls
- [ ] §22 legacy scheduled-agent concepts migrated or removed
- [ ] §23 dead `platform` AgentMode removed

## Phase 5 — Deep Research
- [ ] readiness, explicit cost approval, isolated run/environment, spend cap, TTL, sources, settlement

## Phase 6 — attribution, tests, docs, dead-code sweep
- [ ] §20 per-turn attribution
- [ ] §21 App Focus narrows the live tool catalogue
- [ ] §12 explicit AI API permission matrix
- [ ] §29 tests
- [ ] §31 documentation
