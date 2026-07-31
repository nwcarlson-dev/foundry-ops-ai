-- Usage counters for the public demo.
--
-- Deliberately in its own `app` schema and created with IF NOT EXISTS, because
-- `npm run seed` DROPs the four source schemas and xref. Putting the counters
-- anywhere else would reset the spend ceiling every time the data is
-- regenerated — which is exactly when you least want that to happen.
--
-- Counters live in Postgres rather than a KV store: the database is already
-- provisioned, and one more dependency and account for two integers is not
-- worth it.

CREATE SCHEMA IF NOT EXISTS app;

-- Per-visitor daily quota. The IP is stored only as a salted hash — enough to
-- rate-limit, not enough to identify anyone.
CREATE TABLE IF NOT EXISTS app.usage_day (
    day      DATE NOT NULL,
    ip_hash  TEXT NOT NULL,
    queries  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, ip_hash)
);

-- Hard monthly ceiling across all visitors, so an unattended public link
-- cannot run up an unbounded bill.
CREATE TABLE IF NOT EXISTS app.usage_month (
    month          TEXT PRIMARY KEY,          -- 'YYYY-MM'
    input_tokens   BIGINT NOT NULL DEFAULT 0,
    output_tokens  BIGINT NOT NULL DEFAULT 0,
    queries        INTEGER NOT NULL DEFAULT 0
);

-- Old per-IP rows serve no purpose once the day has passed.
CREATE INDEX IF NOT EXISTS usage_day_day_idx ON app.usage_day (day);

-- Model-written prose, keyed by a fingerprint of the facts it describes.
--
-- The dashboard's findings and the schedule's sequence are deterministic over a
-- fixed dataset, so a given fingerprint always describes the same numbers and
-- its sentence never goes stale. Caching this in a module-level variable was
-- the bug it replaces: on serverless every request is a fresh isolated process,
-- so that cache was empty for nearly every visitor and each one waited ~9s for
-- prose over numbers that were already computed.
--
-- Here for the same reason as the counters above: it must survive `npm run
-- seed`, and it must survive the process.
CREATE TABLE IF NOT EXISTS app.narrative_cache (
    key        TEXT PRIMARY KEY,
    payload    JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
