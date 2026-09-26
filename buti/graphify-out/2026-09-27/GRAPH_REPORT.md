# Graph Report - beauty-preview (2026-09-26)

## Corpus Check
- cluster-only mode — file stats not available.

## Summary
- 582 nodes · 1068 edges · 27 communities.
- 24 communities are shown below; 3 thin communities are omitted.
- Extraction: 100% extracted.
- 2 edges are marked inferred, with average confidence 0.82.
- No ambiguous edges are reported.
- Token cost: 0 input · 0 output.

## Community Hubs
- db.ts
- cloudflare.ts
- app/page.tsx
- package.json
- PreviewStep.tsx
- brow-shapes.ts
- test-chain.mjs
- generate/route.ts
- dashboard/page.tsx
- stats.ts
- consult/route.ts
- options.ts
- compilerOptions
- site-images.ts
- admin-auth.ts
- analysis.ts
- mock-providers.mjs
- ConsultStep.tsx
- jev-quality.ts
- next
- upload-brow/route.ts
- [...path]/route.ts
- app/layout.tsx
- AiChatWidget.tsx
- vision.ts
- next.config.mjs
- postcss.config.mjs

## Most Connected Nodes
1. `next` - 28 edges
2. `isAuthorized()` - 21 edges
3. `unauthorizedResponse()` - 18 edges
4. `compilerOptions` - 17 edges
5. `react` - 14 edges
6. `ServiceInfo` - 13 edges
7. `getDb()` - 11 edges
8. `POST()` - 11 edges
9. `TechniqueStyleOption` - 9 edges
10. `ProviderError` - 8 edges

## Verified Connections
- `GenerateFailure` references `AttemptLog`.
  - `app/api/generate/route.ts` → `src/providers/types.ts`
- `GenerateSuccess` references `AttemptLog`.
  - `app/api/generate/route.ts` → `src/providers/types.ts`
- `GET()` calls `getTenantSettings()`.
  - `app/api/admin/tenant/route.ts` → `src/db.ts`
- `PATCH()` calls `updateTenantSettings()`.
  - `app/api/admin/tenant/route.ts` → `src/db.ts`
- `GET()` calls `isAuthorized()`.
  - `app/api/admin/stats/route.ts` → `src/admin-auth.ts`

## Import Cycles
- None detected.

## Communities
### Community 0 - "db.ts"
- Cohesion: 0.06
- Nodes: 50

### Community 1 - "cloudflare.ts"
- Cohesion: 0.07
- Nodes: 39

### Community 2 - "app/page.tsx"
- Cohesion: 0.07
- Nodes: 42

### Community 3 - "package.json"
- Cohesion: 0.05
- Nodes: 42

### Community 4 - "PreviewStep.tsx"
- Cohesion: 0.10
- Nodes: 31
- Includes MediaPipe vision and client composite symbols.

### Community 5 - "brow-shapes.ts"
- Cohesion: 0.10
- Nodes: 33

### Community 6 - "test-chain.mjs"
- Cohesion: 0.08
- Nodes: 28

### Community 7 - "generate/route.ts"
- Cohesion: 0.11
- Nodes: 26

### Community 8 - "dashboard/page.tsx"
- Cohesion: 0.12
- Nodes: 21

### Community 9 - "stats.ts"
- Cohesion: 0.13
- Nodes: 23

### Community 10 - "consult/route.ts"
- Cohesion: 0.17
- Nodes: 22

### Community 11 - "options.ts"
- Cohesion: 0.12
- Nodes: 18

### Community 12 - "compilerOptions"
- Cohesion: 0.10
- Nodes: 19

### Community 13 - "site-images.ts"
- Cohesion: 0.14
- Nodes: 15

### Community 14 - "admin-auth.ts"
- Cohesion: 0.24
- Nodes: 15

### Community 15 - "analysis.ts"
- Cohesion: 0.21
- Nodes: 12

### Community 16 - "mock-providers.mjs"
- Cohesion: 0.31
- Nodes: 9

### Community 17 - "ConsultStep.tsx"
- Cohesion: 0.20
- Nodes: 8

### Community 18 - "jev-quality.ts"
- Cohesion: 0.31
- Nodes: 8

### Community 19 - "next"
- Cohesion: 0.32
- Nodes: 5

### Community 20 - "upload-brow/route.ts"
- Cohesion: 0.38
- Nodes: 6

### Community 21 - "[...path]/route.ts"
- Cohesion: 0.40
- Nodes: 5

### Community 22 - "app/layout.tsx"
- Cohesion: 0.33
- Nodes: 4

### Community 23 - "AiChatWidget.tsx"
- Cohesion: 0.40
- Nodes: 5

## Knowledge Gaps Reported by Graph
- 231 isolated nodes are reported with ≤1 connection.
- 3 thin communities with fewer than 3 nodes are omitted from the report.
- These are graph-analysis findings only and do not by themselves prove a code defect.
