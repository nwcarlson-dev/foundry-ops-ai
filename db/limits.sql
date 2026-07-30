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
