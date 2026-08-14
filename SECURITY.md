# Security policy

## Secrets

Never commit `.env`, Venice keys, CDP secrets, 0x keys, wallet private keys, or seed phrases. Use a dedicated treasury wallet with narrowly bounded funds. Local wallet setup stores its key in macOS Keychain; production deployments should inject secrets from a managed secret store.

## Treasury invariants

The treasury may only sell Base USDC for the hard-coded Venice DIEM token through the hard-coded 0x AllowanceHolder on Base. Live mode requires a matching key, an exact acknowledgement, a gas reserve, a size cap, and a slippage cap.

Do not make the buy token, chain, transaction target, or acknowledgement configurable. Review any change to these constants as a security-critical change.

## Input handling

Source text is untrusted data. It is bounded, placed inside explicit delimiters, and sent with web search, scraping, X search, and tool use disabled. Media inputs are bounded; transcription accepts only locally parsed PCM WAV data of at most 60 seconds. The service does not intentionally persist request bodies. Avoid logging bodies, payment identities, or provider error bodies.

## Payment boundary

Every paid route parses and validates its request before x402 middleware. When payments are enabled, the route also verifies current Venice epoch access and that the exact configured model is online, private, and capability-compatible before returning payment instructions. Successful readiness is cached for at most 15 seconds and concurrent refreshes are coalesced.

That preflight materially reduces paid provider failures but cannot eliminate a race between readiness, settlement, and inference. Base mainnet must remain disabled until the service has durable capacity reservations plus a buyer-credit or refund policy for a paid call that fails after settlement. Base Sepolia assets have no monetary value.

The MCP server never requests or receives buyer private keys. A2A and MCP inputs are subject to the same worker parsers as direct calls.

## Reporting

Until a public security contact is selected, open a GitHub security advisory rather than a public issue. Do not include live secrets or exploitable wallet details in reports.
