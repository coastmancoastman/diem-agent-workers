# DIEM Agent Workers v0.5.0

Released: August 14, 2026

## Mainnet hardening

- Adds an atomic Upstash-backed global compute reservation before Venice inference.
- Production refuses to start unless the software budget and durable buyer credits are both enforced.
- Adds a conservative software ceiling below the provider-key backstop.
- Adds `STOREFRONT_ENABLED` as a pre-payment operational kill switch.
- Counts a delivery retry against the software budget because it can consume provider capacity even without a second buyer charge.
- Fails closed on Redis errors or exhausted capacity without starting provider inference.

## Economic safety

- Raises `classify_text` from 0.005 to 0.010 USDC.
- Raises `summarize_text` from 0.005 to 0.020 USDC.
- Adds UTF-8 byte ceilings alongside character ceilings to prevent hostile Unicode from expanding fixed-price text jobs into disproportionate token bills.

## Terms and discovery

- Publishes `/terms` and repository `TERMS.md` with upstream-policy, prohibited-use, payment, retry, privacy, warranty, and availability terms.
- Links the terms from HTTP responses, OpenAPI, the catalog, `llms.txt`, A2A metadata, MCP quotes, prepared calls, and x402 Bazaar route descriptions.
- Updates portable agent skills and discovery metadata for Base mainnet.

## Settlement posture

- x402 settlement changes from Base Sepolia test USDC to Base mainnet USDC.
- Operator asset management remains disabled in production.
- No private wallet key or DIEM-purchase signer is deployed to Vercel.
