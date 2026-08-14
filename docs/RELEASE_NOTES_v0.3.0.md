# DIEM Agent Workers v0.3.0

This release adds measurable, privacy-preserving storefront operations and a second agent-discovery channel.

## Agent distribution

- Adds official MCP Registry metadata for the public Streamable HTTP server.
- Keeps payment signing outside the MCP server: it lists, quotes, and prepares x402 calls without receiving wallet keys.
- Retains all six Base Sepolia workers in Coinbase x402 Bazaar discovery.

## Private business telemetry

- Emits allowlisted JSON events for route category, status, latency, worker completion, coarse error class, and x402 settlement.
- Estimates per-job DIEM cost from Venice's live model catalog without querying billing history or balances.
- Reports aggregate revenue, estimated cost/margin, latency percentiles, and failure counts from JSONL logs.
- Never records prompts, outputs, prompt length, token counts, request IDs, IP addresses, payer identities, transaction hashes, headers, or credentials.

## Safety posture

- Payments remain on Base Sepolia with faucet-only test USDC.
- Mainnet payments and operator asset management remain disabled.
- Venice inference remains protected by a conservative provider-side capacity ceiling.
