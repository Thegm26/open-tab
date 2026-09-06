# Open Tab

A simulated Open Tab hackathon MVP: checkout round-ups form a shared pool that can cover part or all of a later purchase. It does not move real money.

## Local development

```bash
npm install
cp .env.example .env.local
npm run dev
```

Node 22.12+ is required. The npm scripts use a portable `npx node@22` launcher because the development machine may have an older system Node.

Production fails closed unless `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are configured. The in-memory lifecycle adapter is available only for local development/tests with `OPEN_TAB_ALLOW_IN_MEMORY=true`. Apply migrations 0001–0003 for persistent RPCs. Production rate limiting uses a DB bucket. A per-client proxy identity is accepted only when all three `OPEN_TAB_TRUSTED_PROXY_IP_HEADER`, `OPEN_TAB_TRUSTED_PROXY_SIGNATURE_HEADER`, and `OPEN_TAB_TRUSTED_PROXY_HMAC_SECRET` (32+ bytes) are configured; the proxy must sign the exact UTF-8 payload `${operation}:${identity}` with HMAC-SHA256 hex. Unsigned/forged headers, including raw `x-real-ip`, use the conservative global bucket.

## Checks

```bash
npm test
npm run lint
npm run build
```

The domain tests cover €0.50 rounding, contributions, reservations, expiry, same-device limits, cumulative refunds, receivables, recovery debt, cancellation, and idempotency.

## Money and safety

- Monetary values are integer cents; floating point is never used for accounting.
- A reservation reduces availability but is not a ledger debit until remaining tender succeeds.
- Completed-order changes use the cumulative refund route, not cancellation.
- Raw claim/owner credentials are derived or hashed; generic state does not persist bearer values.
- Credential derivation fails closed outside `test`/`development` unless `OPEN_TAB_CREDENTIAL_SECRET` is at least 32 bytes.
- A scenario activation flag is one-way: a pool activates once it has reached its threshold and may then be spent down to zero.

## Current verification boundary

The local lifecycle suite is executed and covers the core accounting paths. Run `npm run db:smoke` against the disposable PostgreSQL 16 Docker container described in `scripts/postgres-smoke.sh`; it applies both migrations and exercises round-up, authorization, completion, enum safety, and expiry using `clock_timestamp()`. It is not a substitute for Supabase integration and concurrency/load tests before deployment.
