# General card search with pricing — API only

User clarified this must remain a reusable JSON web API for pokemon-tcg. The unpublished browser UI is saved locally in a stash and excluded. Existing search and price endpoints already support any valid Pokémon name/card ID; remove the misleading impression of a Pikachu-only service from documentation.

Implementation choice (stated to user): preserve search v1 by default; add opt-in `include=prices` search v2 with SGD pricing, page and limit. Default three cards, maximum six, one bounded concurrent batch. No UI or new runtime dependency. A per-card pricing status distinguishes absent prices (200 with empty quotes) from errors. Any partial failure makes the composite response non-cacheable; all-success CDN expiry is the earliest source or FX expiry. Query failures remain HTTP errors. Existing consumers remain unchanged.

1. Add failing HTTP-level regressions for arbitrary name+prices, bounded pagination, invalid parameters, partial failures, zero/missing prices, shared requests and combined cache expiry. Implement shared lookup and opt-in aggregation in src/market.ts.
2. Publish OpenAPI and generalized API documentation/homepage showing parameterized search/card routes, exact JSON shape, CORS and error semantics. Add general search/pricing smoke verification.
3. Run full tests/typecheck/audit, independent review and hosted preview verification; publish and verify production under existing service deployment authorization.

Review focus: no accidental breaking v1 change, no unbounded fan-out, no failure-as-zero conversion, no composite cache extending nested expiry, no stale FX returned after another card finishes, and explicit 500-card search truncation.
