# Contributing

Open an issue before adding a worker or changing payment, provider, wallet, or treasury behavior. New workers must have a narrow outcome, strict input bounds, a fixed maximum provider cost, machine-readable schemas and examples, pre-payment validation, Bazaar metadata, and focused tests.

Keep local payments off and treasury execution disabled. Never put real credentials, wallet keys, seed phrases, request bodies, provider bodies, or payment identities in issues, fixtures, logs, commits, or pull requests.

Before proposing a change, run:

```bash
pnpm check
pnpm test
pnpm build
pnpm generate:openapi
pnpm audit --audit-level=high
```

Security-sensitive reports belong in a private GitHub security advisory. See `SECURITY.md` and `AGENTS.md` for the repository invariants.
