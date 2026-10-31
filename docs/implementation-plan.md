# Standalone Pokémon Price API Implementation Plan

> Execute natively with Superpowers, test first, followed by one independent review.

Goal: A separate GitHub/Vercel service usable by pokemon-tracker while the Mac is off.
Architecture: TypeScript Node Vercel Functions; reuse validated TCGdex normalization and partial search. No database, paid service or additional price provider. Keep compatible v1 native-currency responses by default; `?currency=SGD` returns a clearly versioned v2 converted response and dated FX provenance. Public read-only data; no collection/customer data, credentials, transactions or pricing predictions. Source boundaries stay fixed and bounded.

Approaches: adapting Vite middleware alone would not deploy a backend; extracting the existing service into native Vercel routes gives a standalone API without migrating React. A new framework/database is unnecessary.

Scope: health, partial-name search, card-price lookup, FX rates; CORS GET/OPTIONS, CDN successful-response caching with expiry bounds, best-effort bounded per-instance deduplication/cache/provider cooldown, no artificial30/min cap. Real429 responses preserve retry metadata. Public browser access needs no API key. There is no globally enforced cooldown across replicas; a shared store would be a separate addition if traffic requires it.

- [ ] Copy normalization/schema and regression tests with attribution; add tests for more than30 unique lookups, CORS/preflight, routing, cache TTL and provider failure caching. Observe failure then implement extraction.
- [ ] Test SGD conversion, original-currency contract, FX freshness/mismatch/overflow/failure, fixed upstream URLs and timeout/body limits. Implement conversion/rates routes without silently substituting amounts.
- [ ] Run full tests/typecheck, local HTTP/live smoke and independent review; fix important findings using regressions.
- [ ] Create the new GitHub repository and push only this service after repository/access preference resolves; deploy a preview and verify actual route/caching/CORS behavior before production promotion.
- [ ] Verify production health/search/prices from the hosted URL, record integration instructions and any external blockers. Do not modify pokemon-tracker during extraction.

Review focus: currency correctness, stale data and cache expiry stacking, dynamic Vercel routing, CORS/custom-header compatibility, malicious IDs and unexpected provider payloads, per-instance limitations.
