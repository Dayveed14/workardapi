// ============================================================
// Changes to tables that ALREADY exist on a live database.
// schema.sql only creates missing tables (CREATE TABLE IF NOT EXISTS), so new
// columns and new ENUM values for existing tables are added here.
// npm run db:init runs this after schema.sql. Every step checks first, so it is
// safe to run again and again (MySQL 8 has no "ADD COLUMN IF NOT EXISTS").
// ============================================================

// Add a column only if the table doesn't have it yet
async function addColumn(conn, table, column, definition) {
  const [rows] = await conn.query(
    'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
    [table, column]
  );
  if (!rows.length) await conn.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
}

export async function runUpgrades(conn) {
  // Sales: customers can be marked as a lost deal
  await conn.query("ALTER TABLE customers MODIFY stage ENUM('lead','prospect','customer','lost','inactive') NOT NULL DEFAULT 'lead'");

  // Plans: new organisations start on a free trial
  await conn.query("ALTER TABLE subscriptions MODIFY status ENUM('pending_payment','trial','active') NOT NULL DEFAULT 'trial'");

  // CRM: who gave this customer to the person handling it, and when
  await addColumn(conn, 'customers', 'assigned_by', 'BIGINT UNSIGNED NULL AFTER assigned_employee_id');
  await addColumn(conn, 'customers', 'assigned_at', 'DATETIME NULL AFTER assigned_by');

  // Billing: monthly or yearly, renewed automatically by Paystack
  await addColumn(conn, 'subscriptions', 'billing_interval', "ENUM('monthly','yearly') NULL");
  await addColumn(conn, 'subscriptions', 'auto_renew', 'TINYINT(1) NOT NULL DEFAULT 1');
  await addColumn(conn, 'subscriptions', 'renewal_problem', 'VARCHAR(255) NULL');
  await addColumn(conn, 'subscriptions', 'paystack_customer_code', 'VARCHAR(64) NULL');
  await addColumn(conn, 'subscriptions', 'paystack_authorization_code', 'VARCHAR(64) NULL');
  await addColumn(conn, 'subscriptions', 'paystack_subscription_code', 'VARCHAR(64) NULL');
  await addColumn(conn, 'subscriptions', 'paystack_email_token', 'VARCHAR(64) NULL');
  await addColumn(conn, 'subscriptions', 'next_plan', "ENUM('starter','business','enterprise') NULL");
  await addColumn(conn, 'subscriptions', 'next_interval', "ENUM('monthly','yearly') NULL");
  await conn.query("UPDATE subscriptions SET billing_interval = 'yearly' WHERE status = 'active' AND is_legacy = 0 AND billing_interval IS NULL");
  await addColumn(conn, 'billing_payments', 'billing_interval', "ENUM('monthly','yearly') NULL AFTER kind");
  await conn.query("ALTER TABLE billing_payments MODIFY kind ENUM('new','renewal','upgrade','auto_renewal') NOT NULL");
  await conn.query('ALTER TABLE billing_payments MODIFY reference VARCHAR(100) NOT NULL');

  // Projects: a task can belong to a project
  await addColumn(conn, 'tasks', 'project_id', 'BIGINT UNSIGNED NULL AFTER customer_id');
  // Several people per task: everyone already assigned becomes the task's first (lead) assignee
  const [hasAssignees] = await conn.query("SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'task_assignees'");
  if (hasAssignees.length) {
    await conn.query('INSERT IGNORE INTO task_assignees (task_id, employee_id) SELECT id, assigned_employee_id FROM tasks');
  }

  // Meetings: repeat on chosen weekdays (each with its own time), every N weeks, or monthly
  const [hasMeetings] = await conn.query("SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'meetings'");
  if (hasMeetings.length) {
    await conn.query("ALTER TABLE meetings MODIFY repeat_rule ENUM('none','daily','weekdays','weekly','monthly') NOT NULL DEFAULT 'none'");
    await addColumn(conn, 'meetings', 'repeat_every', 'TINYINT UNSIGNED NOT NULL DEFAULT 1 AFTER repeat_rule');
    await addColumn(conn, 'meetings', 'repeat_days', 'VARCHAR(200) NULL AFTER repeat_every');
  }

  // Super admin: lock users, suspend companies, admin log-in codes
  await addColumn(conn, 'users', 'locked_at', 'DATETIME NULL AFTER last_login_at');
  await addColumn(conn, 'organizations', 'suspended_at', 'DATETIME NULL');
  await addColumn(conn, 'organizations', 'suspended_reason', 'VARCHAR(255) NULL');
  await conn.query("ALTER TABLE otp_codes MODIFY purpose ENUM('signup','login','reset','admin') NOT NULL");
}
