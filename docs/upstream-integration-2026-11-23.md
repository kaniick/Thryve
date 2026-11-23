---
type: "Implementation plan"
title: "Selective upstream integration — assessment and execution plan"
description: "Four-phase implementation plan for safe selective Seedypod integration into Thryve."
status: "draft"
generated: {"by": "ChatGPT", "at": "2026-11-23T00:00:00+00:00"}
sources: [{"resource": "https://github.com/seedypod/core", "title": "Seedypod upstream"}, {"resource": "https://github.com/kaniick/Thryve", "title": "Thryve fork"}]
---

# Selective upstream integration — assessment and execution plan

Date: 2026-11-23
Branch: feat/upstream-selective-integration-20261123
Upstream: seedypod/core dev
Base: kaniick/Thryve dev

## Non-negotiable constraints
- Do not merge upstream dev wholesale, overwrite Thryve configuration, or modify dev/main directly.
- Preserve Thryve branding, existing pump duty-cycle behavior, guard configuration, calibration, Home Assistant MQTT discovery, MCP access, iOS API contracts, plant/pod data and historical records.
- Validate changes in simulation and tests before hardware deployment. Pump safety logic requires explicit review and physical validation before enabling on a live tower.
- Prefer extensions of existing modules over duplicate systems. All schema changes require additive migrations and rollback/backup notes.

## Source inspection findings
- `src/care/chores.ts` already implements thin, trim_roots, top_off, refresh, feed, clean, with quality/freshness checks and citations. Extend the existing recommendations with species-specific thinning counts and care quantities; never invent measurements.
- `src/care/engine.ts` already reacts to sensor and schedule events and deduplicates care alerts. Preserve the alert lifecycle when adding outbound notification details.
- `src/components/Water/WaterPage.tsx` already has pump runs, tank reserve, and a dry-guard summary. Do not transplant upstream guard UI without checking API parity.
- `src/components/Plan/PlanPage.tsx` defaults `allowLightMismatch: true` and differentiates higher/lower placements. Preserve user-selectable placements and advisory warnings.

## Phase 1 — sensor reliability and pump safety
1. Compare upstream `hal/crates/hal-core/src/safety.rs`, `hal/crates/hald/src/engine.rs`, `src/components/Water/DryGuardCard.tsx`, and upstream tank-alert commits against Thryve's HAL, guard, and existing tank alerts.
2. Add regression tests for camera-induced missing ranger samples, sporadic suspect pings, prolonged unreadable tank, low-water interlock, and sensor-fault vs water-low classification.
3. Implement only missing debounce / quality improvements; preserve all existing pump safety limits and default configuration.
4. Require simulation tests and operator approval before hardware rollout.

## Phase 2 — plant-specific care
1. Compare upstream plant catalog metadata and `src/care/chores.ts` with Thryve's `src/plants/catalog` and `src/care/knowledge.ts`.
2. Add sourced, optional per-species thinning targets, timing, and instructions. Unknown species must fall back to existing generic guidance.
3. Enrich notifications with actionable amounts only where source data, tank volume and current readings justify a quantity. No fabricated dose recommendations.
4. Test Rosemary and multiple other species, unknown metadata, and missing/suspect tank readings.

## Phase 3 — pod management
1. Compare upstream `src/components/Plan/PodPanel.tsx`, `SuggestedMoves.tsx`, `src/components/Grow/PlantCare.tsx`, `SwapBanner.tsx`, and 3D scene changes.
2. Implement contextual pod panel and thinning targets while preserving Thryve's light-zone overrides and existing UI patterns.
3. Keep moves explicit and reversible; never silently rewrite planted pod assignments.
4. Add interaction and accessibility tests.

## Phase 4 — analysis and learning
1. Compare upstream `src/components/Analysis/MethodsTab.tsx`, `PodsTab.tsx`, `TeachQueue.tsx` and associated APIs.
2. Add explainability and labeling/teaching functionality only after confirming compatibility with existing camera pipeline and model metadata.
3. Keep inference off the critical pump/light control path and cap resource use on Pi Zero hardware.
4. Add tests for absent captures, stale results, bad model output, and safe fallback.

## Delivery gates
- Each phase gets its own focused commits/PR and passing tests, lint, TypeScript, and Rust checks as applicable.
- Record exact upstream source commits and differences before copying code.
- No deployment, branch merge, schema migration on production, or hardware actuation without separate review.
- The present commit is an assessment and implementation plan, not a claim that runtime features are already installed.
