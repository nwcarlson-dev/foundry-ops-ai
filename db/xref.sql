-- Foundry Ops Copilot — reconciliation layer
--
-- The four source schemas share no keys. This file is what makes them
-- answerable together, and it is the substance of the project.
--
-- Three bridges:
--   part_num  <-> pattern_code   via xref.part_pattern   (Epicor  <-> Thrive)
--   wc_code   <-> tag_path       via xref.wc_tag         (Epicor  <-> Ignition)
--   job_num   <-> free text      via normalize_job_ref() (Epicor  <-> monday.com)
--
-- The bridges are deliberately imperfect, because real ones are. Unmapped parts,
-- one pattern serving two part numbers, blank and malformed job references. The
-- xref.unmatched view surfaces every failure rather than hiding it: a
-- reconciliation layer that claims a 100% match rate is one nobody in a plant
-- would believe.

DROP SCHEMA IF EXISTS xref CASCADE;
CREATE SCHEMA xref;


-- ============================================================================
-- Bridge 1: Epicor part_num <-> Thrive pattern_code
--
-- Not a foreign key in either direction. A pattern can serve more than one part
-- number (same tooling, two customer part numbers), and some parts have never
-- been mapped at all.
-- ============================================================================

CREATE TABLE xref.part_pattern (
    part_num     TEXT NOT NULL,
    pattern_code TEXT NOT NULL,
    mapped_by    TEXT NOT NULL,   -- who/what established the mapping
    mapped_at    DATE NOT NULL,
    PRIMARY KEY (part_num, pattern_code)
);


-- ============================================================================
-- Bridge 2: Epicor work center <-> Ignition tag path
--
-- Ignition tags are machine-centric and carry no production identifiers, so the
-- only join available is work center + time window. tag_prefix matches the
-- leading segments of ignition.tag_history.tag_path.
-- ============================================================================

CREATE TABLE xref.wc_tag (
    wc_code    TEXT NOT NULL,
    tag_prefix TEXT NOT NULL,     -- 'Molding/Line2' matches 'Molding/Line2/CycleTime'
    signal_role TEXT NOT NULL,    -- CYCLE | TEMP | DEGAS | COUNT | STATE
    PRIMARY KEY (wc_code, tag_prefix)
);


-- ============================================================================
-- Bridge 3: Epicor job_num <-> monday.com free-text column
--
-- The 'Job #' column on the monday board is typed by humans. Four formats are
-- present in the data plus blanks and junk:
--
--   'J-104829'    canonical
--   'J104829'     missing separator
--   '104829'      bare digits
--   'Job 104829'  prose
--   '' / NULL     never filled in
--   'TBD'         placeholder that was never replaced
--
-- Returns canonical 'J-######', or NULL when no job number can be recovered.
-- IMMUTABLE so it can be used in indexes and inlined by the planner.
-- ============================================================================

CREATE OR REPLACE FUNCTION xref.normalize_job_ref(raw TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT CASE
        WHEN raw IS NULL OR btrim(raw) = '' THEN NULL
        ELSE (
            SELECT 'J-' || m[1]
            FROM regexp_match(
                     upper(btrim(raw)),
                     '(?:^|[^0-9])([0-9]{6})(?:[^0-9]|$)'
                 ) AS m
        )
    END;
$$;


-- ============================================================================
-- Resolved views — the joins the tool layer actually calls
-- ============================================================================

-- A job's active window on the floor, derived from its labor records. Used to
-- bound time-based joins into Thrive and Ignition, neither of which knows what
-- a job is.
CREATE VIEW xref.job_window AS
SELECT
    jh.job_num,
    COALESCE(MIN(ld.clock_in),  jh.created_at)                          AS started_at,
    COALESCE(MAX(ld.clock_out), jh.created_at + INTERVAL '14 days')     AS ended_at
FROM epicor.job_head jh
LEFT JOIN epicor.labor_dtl ld ON ld.job_num = jh.job_num
GROUP BY jh.job_num, jh.created_at;

-- Epicor job -> Thrive pattern. pattern_code is NULL for unmapped parts; that is
-- deliberate and callers must handle it.
CREATE VIEW xref.job_pattern AS
SELECT
    jh.job_num,
    jh.part_num,
    pp.pattern_code
FROM epicor.job_head jh
LEFT JOIN xref.part_pattern pp ON pp.part_num = jh.part_num;

-- Epicor job -> Thrive heats. Requires both the pattern bridge and the time
-- window: a heat belongs to a job if it poured that job's pattern while the job
-- was open.
CREATE VIEW xref.job_heat AS
SELECT DISTINCT
    jp.job_num,
    jp.part_num,
    pr.pattern_code,
    pr.heat_num,
    pr.poured_at
FROM xref.job_pattern jp
JOIN xref.job_window  jw ON jw.job_num = jp.job_num
JOIN thrive.pour_record pr
       ON pr.pattern_code = jp.pattern_code
      AND pr.poured_at >= jw.started_at
      AND pr.poured_at <= jw.ended_at
WHERE jp.pattern_code IS NOT NULL;

-- Epicor job -> monday.com items, via the normalized free-text column.
-- resolved_job_num is NULL when the human left the field blank or typed junk.
CREATE VIEW xref.job_monday_item AS
SELECT
    xref.normalize_job_ref(cv.text_value) AS resolved_job_num,
    cv.text_value                         AS raw_job_ref,
    bi.item_id,
    bi.board_name,
    bi.item_name,
    bi.status,
    bi.customer,
    bi.promised_date,
    bi.created_at
FROM monday.column_value cv
JOIN monday.board_item   bi ON bi.item_id = cv.item_id
WHERE cv.column_title = 'Job #';

-- Epicor work center -> Ignition tag paths.
CREATE VIEW xref.wc_tag_resolved AS
SELECT
    wt.wc_code,
    wt.signal_role,
    th.tag_path,
    th.ts,
    th.value_float,
    th.quality
FROM xref.wc_tag wt
JOIN ignition.tag_history th ON th.tag_path LIKE wt.tag_prefix || '/%';


-- ============================================================================
-- Reconciliation health — what matched, and what did not
-- ============================================================================

-- Per source-pair match rates. Backs the dashboard's reconciliation card and the
-- reconciliation_report tool.
CREATE VIEW xref.match_rate AS
-- Epicor parts that have a Thrive pattern mapping
SELECT
    'epicor.part -> thrive.pattern_code'::TEXT AS source_pair,
    COUNT(*) FILTER (WHERE pp.pattern_code IS NOT NULL)::BIGINT AS matched,
    COUNT(*)::BIGINT                                            AS total
FROM epicor.part p
LEFT JOIN xref.part_pattern pp ON pp.part_num = p.part_num

UNION ALL

-- monday board items whose Job # resolves to a real Epicor job
SELECT
    'monday.board_item -> epicor.job_head',
    COUNT(*) FILTER (
        WHERE jmi.resolved_job_num IS NOT NULL
          AND EXISTS (SELECT 1 FROM epicor.job_head jh
                       WHERE jh.job_num = jmi.resolved_job_num)
    )::BIGINT,
    COUNT(*)::BIGINT
FROM xref.job_monday_item jmi

UNION ALL

-- Distinct Ignition tag paths covered by a work-center mapping
SELECT
    'ignition.tag_path -> epicor.work_center',
    COUNT(*) FILTER (
        WHERE EXISTS (SELECT 1 FROM xref.wc_tag wt
                       WHERE t.tag_path LIKE wt.tag_prefix || '/%')
    )::BIGINT,
    COUNT(*)::BIGINT
FROM (SELECT DISTINCT tag_path FROM ignition.tag_history) t

UNION ALL

-- Open Epicor jobs that resolve to at least one Thrive heat
SELECT
    'epicor.job_head -> thrive.heat',
    COUNT(*) FILTER (
        WHERE EXISTS (SELECT 1 FROM xref.job_heat jhe WHERE jhe.job_num = jh.job_num)
    )::BIGINT,
    COUNT(*)::BIGINT
FROM epicor.job_head jh;

-- Every row that failed to reconcile, with the reason. Ship this. The copilot
-- is instructed to cite it, so an answer can say "3 monday items could not be
-- matched to a job" instead of silently under-reporting.
CREATE VIEW xref.unmatched AS
SELECT
    'epicor.part -> thrive.pattern_code'::TEXT AS source_pair,
    p.part_num                                 AS identifier,
    'part has no pattern mapping in xref.part_pattern'::TEXT AS reason
FROM epicor.part p
WHERE NOT EXISTS (SELECT 1 FROM xref.part_pattern pp WHERE pp.part_num = p.part_num)

UNION ALL

SELECT
    'thrive.pattern_code -> epicor.part',
    pc.pattern_code,
    'pattern poured in Thrive has no Epicor part mapping'
FROM (SELECT DISTINCT pattern_code FROM thrive.pour_record) pc
WHERE NOT EXISTS (SELECT 1 FROM xref.part_pattern pp WHERE pp.pattern_code = pc.pattern_code)

UNION ALL

SELECT
    'monday.board_item -> epicor.job_head',
    jmi.item_id::TEXT,
    CASE
        WHEN jmi.raw_job_ref IS NULL OR btrim(jmi.raw_job_ref) = ''
            THEN 'Job # column is blank'
        ELSE 'Job # value ' || quote_literal(jmi.raw_job_ref) || ' could not be parsed'
    END
FROM xref.job_monday_item jmi
WHERE jmi.resolved_job_num IS NULL

UNION ALL

SELECT
    'monday.board_item -> epicor.job_head',
    jmi.item_id::TEXT,
    'Job # parsed to ' || jmi.resolved_job_num || ' but no such job exists in Epicor'
FROM xref.job_monday_item jmi
WHERE jmi.resolved_job_num IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM epicor.job_head jh WHERE jh.job_num = jmi.resolved_job_num)

UNION ALL

SELECT
    'ignition.tag_path -> epicor.work_center',
    t.tag_path,
    'tag path is not mapped to any work center in xref.wc_tag'
FROM (SELECT DISTINCT tag_path FROM ignition.tag_history) t
WHERE NOT EXISTS (SELECT 1 FROM xref.wc_tag wt WHERE t.tag_path LIKE wt.tag_prefix || '/%');
