-- Foundry Ops Copilot — source system schemas
--
-- Four schemas modeling four real systems that do not share keys. This is the
-- point of the project: the reconciliation layer in xref.sql is what makes them
-- answerable together.
--
--   epicor.*    ERP job cost.        Keys on job_num 'J-104829', part_num '4471-BRKT'.
--   thrive.*    Melt deck & quality. Keys on heat_num 'H26-0412' and pattern_code
--                                    'PTN-0113'. Has NO knowledge of Epicor job or
--                                    part numbers.
--   ignition.*  SCADA historian.     Keys on tag_path + timestamp. Machine-centric.
--                                    Carries NO part, job, or heat identifier at all.
--   monday.*    Customer board.      Keys on numeric item_id. The job reference lives
--                                    in a free-text column typed by humans, in four
--                                    inconsistent formats, sometimes blank.
--
-- Idempotent: drops and recreates. Safe to re-run before a reseed.

DROP SCHEMA IF EXISTS epicor CASCADE;
DROP SCHEMA IF EXISTS thrive CASCADE;
DROP SCHEMA IF EXISTS ignition CASCADE;
DROP SCHEMA IF EXISTS monday CASCADE;

CREATE SCHEMA epicor;
CREATE SCHEMA thrive;
CREATE SCHEMA ignition;
CREATE SCHEMA monday;


-- ============================================================================
-- epicor — ERP job cost
-- Table and column names follow Epicor job-cost structures (job_head/job_oper/
-- labor_dtl naming, oper_seq sequencing, labor_type P/I/S) so the shape is
-- recognizable to anyone who has worked in the system.
-- ============================================================================

CREATE TABLE epicor.part (
    part_num           TEXT PRIMARY KEY,          -- '4471-BRKT'
    description        TEXT        NOT NULL,
    alloy              TEXT        NOT NULL,      -- A356, 319, 356-T6, 535
    process            TEXT        NOT NULL,      -- SAND | PERM_MOLD
    pattern_num        TEXT        NOT NULL,      -- Epicor's OWN pattern id, not Thrive's
    cavities           INTEGER     NOT NULL,
    target_wt_lbs      NUMERIC(8,2) NOT NULL,
    machining_required BOOLEAN     NOT NULL,
    customer_code      TEXT        NOT NULL,
    industry           TEXT        NOT NULL,      -- Agriculture, Heavy Truck, Marine, ...
    CONSTRAINT part_process_ck CHECK (process IN ('SAND', 'PERM_MOLD'))
);

CREATE TABLE epicor.work_center (
    wc_code        TEXT PRIMARY KEY,              -- 'MOLD-L2'
    description    TEXT         NOT NULL,
    dept           TEXT         NOT NULL,         -- MELT, MOLD, CORE, CLEAN, HEAT_TREAT, MACHINE
    shifts_per_day INTEGER      NOT NULL,
    hrs_per_shift  NUMERIC(4,2) NOT NULL,
    resources      INTEGER      NOT NULL,         -- parallel machines/cells
    queue_hrs      NUMERIC(6,2) NOT NULL
);

CREATE TABLE epicor.scrap_reason (
    reason_code TEXT PRIMARY KEY,                 -- 'GASPOR'
    description TEXT NOT NULL,
    category    TEXT NOT NULL                     -- MELT, MOLD, CORE, MECHANICAL, DIMENSIONAL
);

CREATE TABLE epicor.job_head (
    job_num         TEXT PRIMARY KEY,             -- 'J-104829'
    part_num        TEXT    NOT NULL REFERENCES epicor.part(part_num),
    qty_ordered     INTEGER NOT NULL,
    qty_completed   INTEGER NOT NULL DEFAULT 0,
    req_due_date    DATE    NOT NULL,
    job_released    BOOLEAN NOT NULL DEFAULT TRUE,
    job_closed      BOOLEAN NOT NULL DEFAULT FALSE,
    job_engineered  BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL
);

CREATE TABLE epicor.job_oper (
    job_num        TEXT    NOT NULL REFERENCES epicor.job_head(job_num),
    oper_seq       INTEGER NOT NULL,
    wc_code        TEXT    NOT NULL REFERENCES epicor.work_center(wc_code),
    est_setup_hrs  NUMERIC(7,2) NOT NULL,
    est_prod_hrs   NUMERIC(7,2) NOT NULL,
    act_setup_hrs  NUMERIC(7,2) NOT NULL DEFAULT 0,
    act_prod_hrs   NUMERIC(7,2) NOT NULL DEFAULT 0,
    qty_completed  INTEGER NOT NULL DEFAULT 0,
    scrap_qty      INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (job_num, oper_seq)
);

CREATE TABLE epicor.labor_dtl (
    labor_dtl_seq BIGSERIAL PRIMARY KEY,
    employee_num  TEXT    NOT NULL,
    job_num       TEXT    NOT NULL REFERENCES epicor.job_head(job_num),
    oper_seq      INTEGER NOT NULL,
    clock_in      TIMESTAMPTZ NOT NULL,
    clock_out     TIMESTAMPTZ NOT NULL,
    labor_hrs     NUMERIC(6,2) NOT NULL,
    labor_type    TEXT    NOT NULL,               -- P productive, I indirect, S setup
    shift         INTEGER NOT NULL,               -- 1, 2, 3
    CONSTRAINT labor_type_ck CHECK (labor_type IN ('P', 'I', 'S'))
);

CREATE TABLE epicor.scrap_dtl (
    scrap_dtl_seq BIGSERIAL PRIMARY KEY,
    job_num       TEXT    NOT NULL REFERENCES epicor.job_head(job_num),
    oper_seq      INTEGER NOT NULL,
    scrap_qty     INTEGER NOT NULL,
    reason_code   TEXT    NOT NULL REFERENCES epicor.scrap_reason(reason_code),
    logged_at     TIMESTAMPTZ NOT NULL
);

CREATE INDEX ON epicor.job_head (req_due_date);
CREATE INDEX ON epicor.job_head (part_num);
CREATE INDEX ON epicor.job_oper (wc_code);
CREATE INDEX ON epicor.labor_dtl (job_num, oper_seq);
CREATE INDEX ON epicor.labor_dtl (clock_in);
CREATE INDEX ON epicor.scrap_dtl (job_num);
CREATE INDEX ON epicor.scrap_dtl (reason_code, logged_at);


-- ============================================================================
-- thrive — melt deck and quality
-- Deliberately isolated: pattern_code is Thrive's own identifier and does NOT
-- equal epicor.part.part_num or epicor.part.pattern_num. Joining to Epicor
-- requires xref.part_pattern.
-- ============================================================================

CREATE TABLE thrive.heat (
    heat_num      TEXT PRIMARY KEY,               -- 'H26-0412'
    alloy_spec    TEXT NOT NULL,                  -- Thrive's alloy naming, close to but
                                                  -- not identical to epicor.part.alloy
    furnace_id    TEXT NOT NULL,                  -- 'FURN-3'
    poured_at     TIMESTAMPTZ NOT NULL,
    lbs_charged   NUMERIC(9,2) NOT NULL,
    lbs_poured    NUMERIC(9,2) NOT NULL,
    lbs_returns   NUMERIC(9,2) NOT NULL,
    degas_minutes NUMERIC(5,2) NOT NULL,          -- the planted signal lives here
    rpt_density   NUMERIC(5,3)                    -- reduced-pressure test; NULL when not run
);

CREATE TABLE thrive.pour_record (
    pour_seq     BIGSERIAL PRIMARY KEY,
    heat_num     TEXT NOT NULL REFERENCES thrive.heat(heat_num),
    pattern_code TEXT NOT NULL,                   -- 'PTN-0113'
    molds_poured INTEGER NOT NULL,
    poured_at    TIMESTAMPTZ NOT NULL
);

CREATE TABLE thrive.inspect_result (
    inspect_seq  BIGSERIAL PRIMARY KEY,
    pattern_code TEXT NOT NULL,
    heat_num     TEXT REFERENCES thrive.heat(heat_num),
    sample_qty   INTEGER NOT NULL,
    pass_qty     INTEGER NOT NULL,
    fail_qty     INTEGER NOT NULL,
    defect_code  TEXT,                            -- Thrive's OWN defect vocabulary,
                                                  -- overlapping but not identical to
                                                  -- epicor.scrap_reason
    inspected_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX ON thrive.heat (furnace_id, poured_at);
CREATE INDEX ON thrive.pour_record (pattern_code, poured_at);
CREATE INDEX ON thrive.inspect_result (pattern_code, inspected_at);


-- ============================================================================
-- ignition — SCADA historian (Ignition / PaperlessLog)
-- Time-series keyed on tag path. No part, job, or heat identifier exists here.
-- The only way to relate a tag to production work is work center + time window,
-- via xref.wc_tag.
-- ============================================================================

CREATE TABLE ignition.tag_history (
    tag_id      BIGSERIAL PRIMARY KEY,
    tag_path    TEXT NOT NULL,                    -- 'Molding/Line2/CycleTime'
    ts          TIMESTAMPTZ NOT NULL,
    value_float DOUBLE PRECISION,
    quality     INTEGER NOT NULL DEFAULT 192      -- Ignition convention: 192 = Good
);

CREATE TABLE ignition.downtime_event (
    event_id    BIGSERIAL PRIMARY KEY,
    tag_path    TEXT NOT NULL,
    started_at  TIMESTAMPTZ NOT NULL,
    ended_at    TIMESTAMPTZ,                      -- NULL while still down
    reason_text TEXT                              -- free text, typed inconsistently
);

CREATE INDEX ON ignition.tag_history (tag_path, ts);
CREATE INDEX ON ignition.downtime_event (tag_path, started_at);


-- ============================================================================
-- monday — customer commitments board
-- The job reference is a free-text column value, not a foreign key. Humans typed
-- it four different ways and sometimes left it blank. xref.normalize_job_ref()
-- is what makes it joinable.
-- ============================================================================

CREATE TABLE monday.board_item (
    item_id       BIGINT PRIMARY KEY,             -- monday.com numeric item id
    board_name    TEXT NOT NULL,
    item_name     TEXT NOT NULL,
    status        TEXT NOT NULL,                  -- 'Working on it', 'Stuck', 'Done', ...
    customer      TEXT,
    promised_date DATE,
    created_at    TIMESTAMPTZ NOT NULL
);

CREATE TABLE monday.column_value (
    column_value_id BIGSERIAL PRIMARY KEY,
    item_id         BIGINT NOT NULL REFERENCES monday.board_item(item_id),
    column_title    TEXT NOT NULL,                -- 'Job #', 'Notes', 'Priority', ...
    text_value      TEXT                          -- NULL or '' when a human left it blank
);

CREATE INDEX ON monday.column_value (item_id);
CREATE INDEX ON monday.column_value (column_title);
