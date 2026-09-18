// I1: constants only, zero I/O. Shared between apps/api (routes, seed script) and
// apps/worker (capability guard) so there is exactly one definition of "the demo
// account" rather than a string literal duplicated in two packages that can drift.
//
// A fixed ID constant, not an `accounts.is_demo` column: nothing at runtime — no SQL
// injection, no bad migration, no admin mistake — can flip a real account into "the
// account the public demo reads from." That property only holds for a compile-time
// constant, never for a database value.
export const DEMO_ACCOUNT_ID = "acct_demo";
