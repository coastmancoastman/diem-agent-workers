# DIEM Agent Workers v0.4.0

## Durable paid-delivery protection

- Adds an atomic Upstash Redis state machine for idempotent paid jobs.
- Requires an unpredictable `Idempotency-Key` on signed paid attempts when protection is enforced.
- Binds every retry to the same verified payment authorization, worker, and canonical request using domain-separated HMAC-SHA-256 fingerprints.
- Allows one matching retry when delivery is interrupted after settlement.
- Rejects concurrent, conflicting, or already-consumed idempotency keys before another settlement.
- Fails closed with HTTP 503 when durable protection cannot be checked.
- Persists no request body, provider response, payer address, payment header, transaction hash, or raw idempotency key.
- Refuses `PAYMENTS_MODE=production` unless delivery protection and its independent secret/storage credentials are configured.

## Launch posture

- Payments and acceptance testing remain on Base Sepolia.
- Operator asset management remains disabled.
- The Venice compute ceiling remains conservatively bounded.
