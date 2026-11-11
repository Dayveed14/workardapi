import { pool } from '../config/db.js';
import { DEFAULT_ONBOARDING_TEMPLATES, DEFAULT_OFFBOARDING_TEMPLATES } from '../config/permissions.js';

// ---------- Templates (reusable checklists) ----------
// kind: 'onboarding' (someone joining) or 'offboarding' (someone leaving) — same tables.
// Adds the starter checklists of each kind the organisation has none of yet
export async function ensureDefaults(orgId, db = pool) {
  for (const [kind, defaults] of [['onboarding', DEFAULT_ONBOARDING_TEMPLATES], ['offboarding', DEFAULT_OFFBOARDING_TEMPLATES]]) {
    const [rows] = await db.query('SELECT COUNT(*) AS n FROM onboarding_templates WHERE organization_id = ? AND kind = ?', [orgId, kind]);
    if (Number(rows[0].n) > 0) continue;
    for (const t of defaults) {
      const id = await createTemplate(orgId, { ...t, kind }, db);
      await replaceTemplateItems(id, t.items.map((i) => ({ ...i, dueDay: i.day })), db);
    }
  }
}

export async function listTemplates(orgId, kind = 'onboarding', db = pool) {
  const [rows] = await db.query(
    `SELECT t.*,
            (SELECT COUNT(*) FROM onboarding_template_items i WHERE i.template_id = t.id AND i.owner = 'new_joiner') AS joiner_items,
            (SELECT COUNT(*) FROM onboarding_template_items i WHERE i.template_id = t.id AND i.owner = 'hr') AS hr_items
       FROM onboarding_templates t
      WHERE t.organization_id = ? AND t.kind = ? AND t.is_active = 1
      ORDER BY t.name`,
    [orgId, kind]
  );
  return rows;
}

export async function findTemplate(orgId, id, db = pool) {
  const [rows] = await db.query('SELECT * FROM onboarding_templates WHERE organization_id = ? AND id = ? AND is_active = 1', [orgId, id]);
  return rows[0] || null;
}

export async function listTemplateItems(templateId, db = pool) {
  const [rows] = await db.query('SELECT * FROM onboarding_template_items WHERE template_id = ? ORDER BY sort_order, id', [templateId]);
  return rows;
}

export async function createTemplate(orgId, { name, description, suits, kind = 'onboarding' }, db = pool) {
  const [result] = await db.query(
    'INSERT INTO onboarding_templates (organization_id, name, description, kind, suits) VALUES (?, ?, ?, ?, ?)',
    [orgId, name, description || null, kind, suits || 'everyone']
  );
  return result.insertId;
}

export async function updateTemplate(orgId, id, { name, description, suits }, db = pool) {
  await db.query('UPDATE onboarding_templates SET name = ?, description = ?, suits = ? WHERE organization_id = ? AND id = ?', [
    name,
    description || null,
    suits,
    orgId,
    id,
  ]);
}

// Onboardings already started keep their own copy of the items, so this never changes them
export async function replaceTemplateItems(templateId, items, db = pool) {
  await db.query('DELETE FROM onboarding_template_items WHERE template_id = ?', [templateId]);
  let order = 0;
  for (const item of items) {
    order += 1;
    await db.query(
      'INSERT INTO onboarding_template_items (template_id, title, description, owner, due_day, asks_for_note, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [templateId, item.title, item.description || null, item.owner, item.dueDay || 0, item.asksForNote ? 1 : 0, order]
    );
  }
}

export async function archiveTemplate(orgId, id, db = pool) {
  await db.query('UPDATE onboarding_templates SET is_active = 0 WHERE organization_id = ? AND id = ?', [orgId, id]);
}

// ---------- Onboardings ----------
const SELECT_ONBOARDING = `
  SELECT o.*, e.first_name, e.last_name, e.job_title, e.photo_url, e.user_id AS employee_user_id, e.start_date AS employee_start_date,
         d.name AS department_name, u.full_name AS started_by_name,
         (SELECT COUNT(*) FROM onboarding_items i WHERE i.onboarding_id = o.id) AS total_items,
         (SELECT COUNT(*) FROM onboarding_items i WHERE i.onboarding_id = o.id AND i.done_at IS NOT NULL) AS done_items,
         (SELECT COUNT(*) FROM onboarding_items i WHERE i.onboarding_id = o.id AND i.done_at IS NULL AND i.due_date < CURDATE()) AS overdue_items
    FROM onboardings o
    JOIN employees e ON e.id = o.employee_id
    LEFT JOIN departments d ON d.id = e.department_id
    LEFT JOIN users u ON u.id = o.started_by`;

// Throws ER_DUP_ENTRY if the person already has an onboarding in progress
export async function create(orgId, { employeeId, templateName, startDate, startedBy }, db = pool) {
  const [result] = await db.query(
    'INSERT INTO onboardings (organization_id, employee_id, template_name, start_date, started_by) VALUES (?, ?, ?, ?, ?)',
    [orgId, employeeId, templateName, startDate, startedBy]
  );
  return result.insertId;
}

export async function addItem(onboardingId, { title, description, owner, dueDate, sortOrder }, db = pool) {
  const [result] = await db.query(
    `INSERT INTO onboarding_items (onboarding_id, title, description, owner, due_date, sort_order)
     VALUES (?, ?, ?, ?, ?, COALESCE(?, (SELECT COALESCE(MAX(x.sort_order), 0) + 1 FROM onboarding_items x WHERE x.onboarding_id = ?)))`,
    [onboardingId, title, description || null, owner, dueDate || null, sortOrder ?? null, onboardingId]
  );
  return result.insertId;
}

export async function findById(orgId, id, db = pool) {
  const [rows] = await db.query(`${SELECT_ONBOARDING} WHERE o.organization_id = ? AND o.id = ?`, [orgId, id]);
  return rows[0] || null;
}

export async function lock(orgId, id, db) {
  const [rows] = await db.query('SELECT * FROM onboardings WHERE organization_id = ? AND id = ? FOR UPDATE', [orgId, id]);
  return rows[0] || null;
}

export async function list(orgId, { status }, db = pool) {
  const where = ['o.organization_id = ?'];
  const params = [orgId];
  if (status) {
    where.push('o.status = ?');
    params.push(status);
  }
  const [rows] = await db.query(`${SELECT_ONBOARDING} WHERE ${where.join(' AND ')} ORDER BY o.status = 'in_progress' DESC, o.start_date DESC LIMIT 200`, params);
  return rows;
}

// The newest onboarding for this person (in progress first)
export async function findLatestForEmployee(orgId, employeeId, db = pool) {
  const [rows] = await db.query(
    `${SELECT_ONBOARDING} WHERE o.organization_id = ? AND o.employee_id = ? AND o.status <> 'cancelled'
      ORDER BY o.status = 'in_progress' DESC, o.created_at DESC LIMIT 1`,
    [orgId, employeeId]
  );
  return rows[0] || null;
}

export async function setStatus(id, status, db = pool) {
  await db.query(
    `UPDATE onboardings SET status = ?, active_key = NULL, completed_at = ${status === 'completed' ? 'NOW()' : 'NULL'} WHERE id = ?`,
    [status, id]
  );
}

// ---------- Items ----------
export async function listItems(onboardingId, db = pool) {
  const [rows] = await db.query(
    `SELECT i.*, u.full_name AS done_by_name FROM onboarding_items i LEFT JOIN users u ON u.id = i.done_by
      WHERE i.onboarding_id = ? ORDER BY i.owner, i.sort_order, i.id`,
    [onboardingId]
  );
  return rows;
}

export async function findItem(itemId, db = pool) {
  const [rows] = await db.query('SELECT * FROM onboarding_items WHERE id = ?', [itemId]);
  return rows[0] || null;
}

export async function setItemDone(itemId, userId, done, db = pool) {
  await db.query('UPDATE onboarding_items SET done_at = ?, done_by = ? WHERE id = ?', [done ? new Date() : null, done ? userId : null, itemId]);
}

export async function removeItem(itemId, db = pool) {
  await db.query('DELETE FROM onboarding_items WHERE id = ?', [itemId]);
}

export async function countOpenItems(onboardingId, db = pool) {
  const [rows] = await db.query('SELECT COUNT(*) AS n FROM onboarding_items WHERE onboarding_id = ? AND done_at IS NULL', [onboardingId]);
  return Number(rows[0].n);
}

// Active employees with no onboarding in progress, newest first (for "Start onboarding")
export async function listCandidates(orgId, db = pool) {
  const [rows] = await db.query(
    `SELECT e.id, e.first_name, e.last_name, e.job_title, e.start_date, e.user_id, r.name AS role_name,
            (SELECT COUNT(*) FROM employees rep WHERE rep.manager_id = e.id AND rep.status = 'active') AS direct_reports,
            (SELECT COUNT(*) FROM onboardings ob WHERE ob.employee_id = e.id AND ob.status = 'completed') AS completed_before
       FROM employees e
       LEFT JOIN memberships m ON m.user_id = e.user_id AND m.organization_id = e.organization_id
       LEFT JOIN roles r ON r.id = m.role_id
      WHERE e.organization_id = ? AND e.status = 'active'
        AND NOT EXISTS (SELECT 1 FROM onboardings o WHERE o.employee_id = e.id AND o.status = 'in_progress')
      ORDER BY e.start_date IS NULL, e.start_date DESC, e.id DESC`,
    [orgId]
  );
  return rows;
}
