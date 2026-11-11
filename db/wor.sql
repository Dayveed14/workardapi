-- ============================================================
-- WORKARD: OFFBOARDING + TASK @MENTIONS
-- MySQL 8 / Aiven
-- Safe to rerun: skips existing columns, tables and records.
-- ============================================================

-- 1. ADD MISSING COLUMNS

SET @sql = IF(
    (SELECT COUNT(*) FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'onboarding_templates'
     AND COLUMN_NAME = 'kind') = 0,
    'ALTER TABLE onboarding_templates ADD COLUMN kind ENUM(''onboarding'',''offboarding'') NOT NULL DEFAULT ''onboarding'' AFTER description',
    'SELECT 1'
);
PREPARE st FROM @sql;
EXECUTE st;
DEALLOCATE PREPARE st;


SET @sql = IF(
    (SELECT COUNT(*) FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'onboarding_template_items'
     AND COLUMN_NAME = 'asks_for_note') = 0,
    'ALTER TABLE onboarding_template_items ADD COLUMN asks_for_note TINYINT(1) NOT NULL DEFAULT 0 AFTER due_day',
    'SELECT 1'
);
PREPARE st FROM @sql;
EXECUTE st;
DEALLOCATE PREPARE st;


SET @sql = IF(
    (SELECT COUNT(*) FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'organizations'
     AND COLUMN_NAME = 'notice_days') = 0,
    'ALTER TABLE organizations ADD COLUMN notice_days SMALLINT UNSIGNED NOT NULL DEFAULT 30',
    'SELECT 1'
);
PREPARE st FROM @sql;
EXECUTE st;
DEALLOCATE PREPARE st;


-- 2. UPDATE CHECKLIST OPTIONS

ALTER TABLE onboarding_templates
MODIFY suits ENUM(
    'everyone',
    'staff',
    'managers',
    'resignation',
    'termination'
) NOT NULL DEFAULT 'everyone';


-- 3. CREATE TASK COMMENT MENTIONS TABLE

CREATE TABLE IF NOT EXISTS task_comment_mentions (
    comment_id BIGINT UNSIGNED NOT NULL,
    user_id BIGINT UNSIGNED NOT NULL,
    PRIMARY KEY (comment_id, user_id),
    CONSTRAINT fk_mention_comment
        FOREIGN KEY (comment_id)
        REFERENCES task_comments(id)
        ON DELETE CASCADE
) ENGINE=InnoDB;


-- 4. CREATE OFFBOARDINGS TABLE

CREATE TABLE IF NOT EXISTS offboardings (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    organization_id BIGINT UNSIGNED NOT NULL,
    employee_id BIGINT UNSIGNED NOT NULL,
    exit_type ENUM('resignation','termination') NOT NULL,
    reason VARCHAR(1000) NULL,
    started_by BIGINT UNSIGNED NULL,
    by_employee TINYINT(1) NOT NULL DEFAULT 0,
    notice_start DATETIME NOT NULL,
    last_day DATE NOT NULL,
    ends_at DATETIME NOT NULL,
    template_name VARCHAR(120) NULL,
    checklist_sent_at DATETIME NULL,
    checklist_done_at DATETIME NULL,
    status ENUM(
        'notice',
        'in_progress',
        'exited',
        'withdrawn',
        'cancelled'
    ) NOT NULL DEFAULT 'notice',
    exited_at DATETIME NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    active_key TINYINT NULL DEFAULT 1,

    UNIQUE KEY uq_offboarding_active (employee_id, active_key),
    KEY idx_offboarding_org (organization_id, status),
    KEY idx_offboarding_end (status, ends_at),

    CONSTRAINT fk_off_org
        FOREIGN KEY (organization_id)
        REFERENCES organizations(id)
        ON DELETE CASCADE,

    CONSTRAINT fk_off_emp
        FOREIGN KEY (employee_id)
        REFERENCES employees(id)
        ON DELETE CASCADE
) ENGINE=InnoDB;


-- 5. CREATE OFFBOARDING ITEMS TABLE

CREATE TABLE IF NOT EXISTS offboarding_items (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    offboarding_id BIGINT UNSIGNED NOT NULL,
    title VARCHAR(200) NOT NULL,
    description VARCHAR(500) NULL,
    owner ENUM('employee','hr') NOT NULL,
    due_at DATETIME NULL,
    asks_for_note TINYINT(1) NOT NULL DEFAULT 0,
    note TEXT NULL,
    sort_order INT NOT NULL DEFAULT 0,
    done_at DATETIME NULL,
    done_by BIGINT UNSIGNED NULL,

    CONSTRAINT fk_offi_off
        FOREIGN KEY (offboarding_id)
        REFERENCES offboardings(id)
        ON DELETE CASCADE
) ENGINE=InnoDB;


-- 6. CREATE TEMPORARY ORGANIZATION LIST
-- Explicit primary key required by Aiven.

DROP TEMPORARY TABLE IF EXISTS tmp_new_off_orgs;

CREATE TEMPORARY TABLE tmp_new_off_orgs (
    id BIGINT UNSIGNED NOT NULL PRIMARY KEY
) ENGINE=InnoDB;

INSERT INTO tmp_new_off_orgs (id)
SELECT o.id
FROM organizations o
WHERE NOT EXISTS (
    SELECT 1
    FROM onboarding_templates t
    WHERE t.organization_id = o.id
      AND t.kind = 'offboarding'
);


-- 7. CREATE DEFAULT RESIGNATION TEMPLATES

INSERT INTO onboarding_templates
(organization_id, name, description, kind, suits)

SELECT
    n.id,
    'Resignation (notice period)',
    'For someone serving their notice',
    'offboarding',
    'resignation'
FROM tmp_new_off_orgs n;


-- 8. CREATE DEFAULT TERMINATION TEMPLATES

INSERT INTO onboarding_templates
(organization_id, name, description, kind, suits)

SELECT
    n.id,
    'Exit within 24 hours',
    'When the company ends someone’s employment',
    'offboarding',
    'termination'
FROM tmp_new_off_orgs n;


-- 9. RESIGNATION CHECKLIST ITEMS
-- Only insert missing items.

INSERT INTO onboarding_template_items
(template_id, title, description, owner, due_day, asks_for_note, sort_order)

SELECT
    t.id,
    s.title,
    s.description,
    s.owner,
    s.due_day,
    s.asks_for_note,
    s.sort_order

FROM onboarding_templates t

JOIN (
    SELECT 'Write a handover note' AS title,
           'What you work on, where things are, who to call, what’s unfinished.' AS description,
           'new_joiner' AS owner, 14 AS due_day, 1 AS asks_for_note, 1 AS sort_order

    UNION ALL SELECT 'Hand over your current work and tasks to your manager', NULL, 'new_joiner', 21, 0, 2
    UNION ALL SELECT 'Return company documents in your possession', 'List what you returned and to whom.', 'new_joiner', 25, 1, 3
    UNION ALL SELECT 'Return company assets (laptop, phone, ID card, keys)', 'List each item and who received it.', 'new_joiner', 28, 1, 4
    UNION ALL SELECT 'Hold an exit interview', NULL, 'hr', 25, 0, 5
    UNION ALL SELECT 'Collect company assets and ID card', NULL, 'hr', 28, 0, 6
    UNION ALL SELECT 'Remove access to company accounts and email', NULL, 'hr', 30, 0, 7
    UNION ALL SELECT 'Work out final pay and unused leave', NULL, 'hr', 30, 0, 8
    UNION ALL SELECT 'Issue a clearance / service letter', NULL, 'hr', 30, 0, 9
) s

WHERE t.kind = 'offboarding'
AND t.name = 'Resignation (notice period)'
AND NOT EXISTS (
    SELECT 1
    FROM onboarding_template_items existing
    WHERE existing.template_id = t.id
      AND existing.title = s.title
);


-- 10. TERMINATION CHECKLIST ITEMS

INSERT INTO onboarding_template_items
(template_id, title, description, owner, due_day, asks_for_note, sort_order)

SELECT
    t.id,
    s.title,
    s.description,
    s.owner,
    s.due_day,
    s.asks_for_note,
    s.sort_order

FROM onboarding_templates t

JOIN (
    SELECT 'Return company assets (laptop, phone, ID card, keys)' AS title,
           'List each item and who received it.' AS description,
           'new_joiner' AS owner, 0 AS due_day, 1 AS asks_for_note, 1 AS sort_order

    UNION ALL SELECT 'Return company documents in your possession', NULL, 'new_joiner', 0, 1, 2
    UNION ALL SELECT 'Write a short handover note', NULL, 'new_joiner', 0, 1, 3
    UNION ALL SELECT 'Collect company assets and ID card', NULL, 'hr', 0, 0, 4
    UNION ALL SELECT 'Remove access to company accounts and email', NULL, 'hr', 0, 0, 5
    UNION ALL SELECT 'Work out final pay', NULL, 'hr', 0, 0, 6
) s

WHERE t.kind = 'offboarding'
AND t.name = 'Exit within 24 hours'
AND NOT EXISTS (
    SELECT 1
    FROM onboarding_template_items existing
    WHERE existing.template_id = t.id
      AND existing.title = s.title
);


-- 11. CLEANUP

DROP TEMPORARY TABLE IF EXISTS tmp_new_off_orgs;


-- 12. VERIFICATION

SELECT
    'MIGRATION COMPLETED' AS result,
    (SELECT COUNT(*) FROM offboardings) AS offboardings,
    (SELECT COUNT(*) FROM offboarding_items) AS offboarding_items,
    (SELECT COUNT(*) FROM task_comment_mentions) AS comment_mentions,
    (SELECT COUNT(*) FROM onboarding_templates WHERE kind = 'offboarding') AS offboarding_checklists,
    (SELECT COUNT(*) FROM organizations) AS organizations;


SELECT
    organization_id,
    name,
    kind,
    suits
FROM onboarding_templates
WHERE kind = 'offboarding'
ORDER BY organization_id, name;


SELECT
    t.name AS checklist,
    COUNT(i.id) AS total_steps
FROM onboarding_templates t
LEFT JOIN onboarding_template_items i
    ON i.template_id = t.id
WHERE t.kind = 'offboarding'
GROUP BY t.id, t.name
ORDER BY t.name;