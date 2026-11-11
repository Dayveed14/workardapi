-- ============================================================
-- Workard — Phase 1 schema
-- Every business table has organization_id: that is what keeps
-- one company's data separate from another's (multi-tenant).
-- Run: npm run db:init   (or import this file in phpMyAdmin)
-- ============================================================

CREATE DATABASE IF NOT EXISTS workard CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE workard;

-- ---------- People who can log in ----------
CREATE TABLE IF NOT EXISTS users (
  id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  full_name       VARCHAR(120) NOT NULL,
  email           VARCHAR(190) NOT NULL,
  phone           VARCHAR(30)  NULL,
  password_hash   VARCHAR(255) NOT NULL,
  email_verified  TINYINT(1)   NOT NULL DEFAULT 0,
  last_login_at   DATETIME     NULL,
  locked_at       DATETIME     NULL,       -- locked by a Workard super admin: can't log in
  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_users_email (email)
) ENGINE=InnoDB;

-- ---------- Companies using Workard ----------
CREATE TABLE IF NOT EXISTS organizations (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name        VARCHAR(160) NOT NULL,
  industry    VARCHAR(80)  NULL,
  size        VARCHAR(20)  NULL,
  currency    CHAR(3)      NOT NULL DEFAULT 'NGN',
  plan        ENUM('free','business','pro') NOT NULL DEFAULT 'free',
  notice_days       SMALLINT UNSIGNED NOT NULL DEFAULT 30, -- resignation notice period
  suspended_at      DATETIME NULL,          -- suspended by a Workard super admin (nobody can use it)
  suspended_reason  VARCHAR(255) NULL,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- permissions is JSON text: {"employees.view":"team","leave.approve":"team"}
CREATE TABLE IF NOT EXISTS roles (
  id               BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  organization_id  BIGINT UNSIGNED NOT NULL,
  name             VARCHAR(80)  NOT NULL,
  description      VARCHAR(255) NULL,
  is_system        TINYINT(1)   NOT NULL DEFAULT 0,
  is_owner         TINYINT(1)   NOT NULL DEFAULT 0,
  permissions      TEXT         NOT NULL,
  created_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_role_name (organization_id, name),
  CONSTRAINT fk_role_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- A user's seat in an organisation (one user can belong to several organisations)
CREATE TABLE IF NOT EXISTS memberships (
  id               BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id          BIGINT UNSIGNED NOT NULL,
  organization_id  BIGINT UNSIGNED NOT NULL,
  role_id          BIGINT UNSIGNED NOT NULL,
  status           ENUM('active','disabled') NOT NULL DEFAULT 'active',
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_membership (user_id, organization_id),
  CONSTRAINT fk_mem_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_mem_org  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT fk_mem_role FOREIGN KEY (role_id) REFERENCES roles(id)
) ENGINE=InnoDB;

-- ---------- Organisation structure ----------
-- clock_in_policy: how clock-ins at this branch are verified
--   none | location (GPS radius) | wifi (office IP) | either | both
CREATE TABLE IF NOT EXISTS branches (
  id               BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  organization_id  BIGINT UNSIGNED NOT NULL,
  name             VARCHAR(120)  NOT NULL,
  address          VARCHAR(255)  NULL,
  latitude         DECIMAL(10,7) NULL,
  longitude        DECIMAL(10,7) NULL,
  radius_m         INT UNSIGNED  NOT NULL DEFAULT 150,
  office_ips       VARCHAR(500)  NULL,
  clock_in_policy  ENUM('none','location','wifi','either','both') NOT NULL DEFAULT 'either',
  work_start       TIME NOT NULL DEFAULT '08:00:00',
  work_end         TIME NOT NULL DEFAULT '17:00:00',
  grace_minutes    INT UNSIGNED NOT NULL DEFAULT 15,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_branch_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS departments (
  id               BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  organization_id  BIGINT UNSIGNED NOT NULL,
  name             VARCHAR(120) NOT NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_dept_name (organization_id, name),
  CONSTRAINT fk_dept_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS teams (
  id                      BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  organization_id         BIGINT UNSIGNED NOT NULL,
  department_id           BIGINT UNSIGNED NULL,
  name                    VARCHAR(120) NOT NULL,
  supervisor_employee_id  BIGINT UNSIGNED NULL,
  created_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_team_org  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT fk_team_dept FOREIGN KEY (department_id) REFERENCES departments(id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- ---------- Employees (HR record; may or may not have a login) ----------
CREATE TABLE IF NOT EXISTS employees (
  id                       BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  organization_id          BIGINT UNSIGNED NOT NULL,
  user_id                  BIGINT UNSIGNED NULL,
  staff_id                 VARCHAR(40)  NULL,
  first_name               VARCHAR(80)  NOT NULL,
  last_name                VARCHAR(80)  NOT NULL,
  email                    VARCHAR(190) NOT NULL,
  phone                    VARCHAR(30)  NULL,
  gender                   ENUM('male','female','other') NULL,
  date_of_birth            DATE NULL,
  address                  VARCHAR(255) NULL,
  job_title                VARCHAR(120) NULL,
  employment_type          ENUM('full_time','part_time','contract','intern') NOT NULL DEFAULT 'full_time',
  branch_id                BIGINT UNSIGNED NULL,
  department_id            BIGINT UNSIGNED NULL,
  team_id                  BIGINT UNSIGNED NULL,
  manager_id               BIGINT UNSIGNED NULL,
  start_date               DATE NULL,
  status                   ENUM('active','exited') NOT NULL DEFAULT 'active',
  exit_date                DATE NULL,
  photo_url                VARCHAR(500) NULL,
  photo_public_id          VARCHAR(255) NULL,
  emergency_contact_name   VARCHAR(120) NULL,
  emergency_contact_phone  VARCHAR(30)  NULL,
  created_at               DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at               DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_emp_email (organization_id, email),
  KEY idx_emp_user (user_id),
  CONSTRAINT fk_emp_org    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT fk_emp_user   FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_emp_branch FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE SET NULL,
  CONSTRAINT fk_emp_dept   FOREIGN KEY (department_id) REFERENCES departments(id) ON DELETE SET NULL,
  CONSTRAINT fk_emp_team   FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS employee_documents (
  id               BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  organization_id  BIGINT UNSIGNED NOT NULL,
  employee_id      BIGINT UNSIGNED NOT NULL,
  title            VARCHAR(160) NOT NULL,
  category         VARCHAR(60)  NOT NULL DEFAULT 'other',
  file_url         VARCHAR(500) NOT NULL,
  public_id        VARCHAR(255) NOT NULL,
  resource_type    VARCHAR(20)  NOT NULL DEFAULT 'image',
  file_name        VARCHAR(255) NULL,
  mime_type        VARCHAR(100) NULL,
  size_bytes       INT UNSIGNED NULL,
  uploaded_by      BIGINT UNSIGNED NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_doc_emp (employee_id),
  CONSTRAINT fk_doc_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT fk_doc_emp FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Invitation for an employee to create their login
CREATE TABLE IF NOT EXISTS invites (
  id               BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  organization_id  BIGINT UNSIGNED NOT NULL,
  employee_id      BIGINT UNSIGNED NOT NULL,
  email            VARCHAR(190) NOT NULL,
  role_id          BIGINT UNSIGNED NOT NULL,
  token_hash       CHAR(64) NOT NULL,
  expires_at       DATETIME NOT NULL,
  accepted_at      DATETIME NULL,
  created_by       BIGINT UNSIGNED NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_invite_token (token_hash),
  CONSTRAINT fk_inv_org  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT fk_inv_emp  FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE,
  CONSTRAINT fk_inv_role FOREIGN KEY (role_id) REFERENCES roles(id)
) ENGINE=InnoDB;

-- ---------- Attendance (one row per employee per day) ----------
CREATE TABLE IF NOT EXISTS attendance (
  id                   BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  organization_id      BIGINT UNSIGNED NOT NULL,
  employee_id          BIGINT UNSIGNED NOT NULL,
  branch_id            BIGINT UNSIGNED NULL,
  work_date            DATE NOT NULL,
  clock_in_at          DATETIME NOT NULL,
  clock_out_at         DATETIME NULL,
  clock_in_lat         DECIMAL(10,7) NULL,
  clock_in_lng         DECIMAL(10,7) NULL,
  clock_in_ip          VARCHAR(64)   NULL,
  distance_m           INT UNSIGNED  NULL,
  location_ok          TINYINT(1)    NULL,
  wifi_ok              TINYINT(1)    NULL,
  is_late              TINYINT(1)    NOT NULL DEFAULT 0,
  minutes_worked       INT UNSIGNED  NULL,
  is_flagged           TINYINT(1)    NOT NULL DEFAULT 0,
  flag_reason          VARCHAR(255)  NULL,
  review_status        ENUM('pending','approved','rejected') NULL,
  review_note          VARCHAR(255)  NULL,
  reviewed_by          BIGINT UNSIGNED NULL,
  reviewed_at          DATETIME NULL,
  created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_att_day (employee_id, work_date),
  KEY idx_att_org_date (organization_id, work_date),
  CONSTRAINT fk_att_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT fk_att_emp FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ---------- Leave ----------
CREATE TABLE IF NOT EXISTS leave_types (
  id               BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  organization_id  BIGINT UNSIGNED NOT NULL,
  name             VARCHAR(80) NOT NULL,
  days_per_year    INT UNSIGNED NOT NULL DEFAULT 0,
  is_paid          TINYINT(1) NOT NULL DEFAULT 1,
  is_active        TINYINT(1) NOT NULL DEFAULT 1,
  UNIQUE KEY uq_leave_type (organization_id, name),
  CONSTRAINT fk_lt_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS leave_requests (
  id               BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  organization_id  BIGINT UNSIGNED NOT NULL,
  employee_id      BIGINT UNSIGNED NOT NULL,
  leave_type_id    BIGINT UNSIGNED NOT NULL,
  start_date       DATE NOT NULL,
  end_date         DATE NOT NULL,
  days             INT UNSIGNED NOT NULL,
  reason           VARCHAR(500) NULL,
  status           ENUM('pending','approved','rejected','cancelled') NOT NULL DEFAULT 'pending',
  reviewed_by      BIGINT UNSIGNED NULL,
  review_note      VARCHAR(255) NULL,
  reviewed_at      DATETIME NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_leave_emp (employee_id),
  KEY idx_leave_org_status (organization_id, status),
  CONSTRAINT fk_lr_org  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT fk_lr_emp  FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE,
  CONSTRAINT fk_lr_type FOREIGN KEY (leave_type_id) REFERENCES leave_types(id)
) ENGINE=InnoDB;

-- ---------- Auth support ----------
-- 6-digit email codes for 2FA (signup, login) and password reset. Stored hashed.
CREATE TABLE IF NOT EXISTS otp_codes (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id     BIGINT UNSIGNED NOT NULL,
  purpose     ENUM('signup','login','reset','admin') NOT NULL,
  code_hash   CHAR(64) NOT NULL,
  attempts    TINYINT UNSIGNED NOT NULL DEFAULT 0,
  expires_at  DATETIME NOT NULL,
  used_at     DATETIME NULL,
  created_at  DATETIME NOT NULL,
  KEY idx_otp_user (user_id, purpose),
  CONSTRAINT fk_otp_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Refresh tokens are stored hashed so they can be rotated and revoked
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id               BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id          BIGINT UNSIGNED NOT NULL,
  organization_id  BIGINT UNSIGNED NOT NULL,
  token_hash       CHAR(64) NOT NULL,
  user_agent       VARCHAR(255) NULL,
  ip               VARCHAR(64)  NULL,
  expires_at       DATETIME NOT NULL,
  revoked_at       DATETIME NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_token_hash (token_hash),
  KEY idx_rt_user (user_id),
  CONSTRAINT fk_rt_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ---------- Activity log ("who did what") ----------
CREATE TABLE IF NOT EXISTS audit_logs (
  id               BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  organization_id  BIGINT UNSIGNED NOT NULL,
  user_id          BIGINT UNSIGNED NULL,
  action           VARCHAR(80) NOT NULL,
  entity_type      VARCHAR(40) NULL,
  entity_id        BIGINT UNSIGNED NULL,
  details          VARCHAR(500) NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_audit_org (organization_id, created_at),
  CONSTRAINT fk_audit_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ============================================================
-- PHASE 2 — CRM, invoicing & finance
-- All money is stored in KOBO as whole numbers (BIGINT).
-- ₦1,250.50 is stored as 125050. Never use floats for money.
-- ============================================================

-- ---------- Customers (CRM) ----------
-- stage: lead → prospect → customer (or lost / inactive)
-- assigned_employee_id: the staff member who owns the account
CREATE TABLE IF NOT EXISTS customers (
  id                    BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  organization_id       BIGINT UNSIGNED NOT NULL,
  type                  ENUM('individual','business') NOT NULL DEFAULT 'individual',
  name                  VARCHAR(160) NOT NULL,
  contact_person        VARCHAR(120) NULL,
  email                 VARCHAR(190) NULL,
  phone                 VARCHAR(30)  NULL,
  address               VARCHAR(255) NULL,
  stage                 ENUM('lead','prospect','customer','lost','inactive') NOT NULL DEFAULT 'lead',
  source                VARCHAR(60)  NULL,
  assigned_employee_id  BIGINT UNSIGNED NULL,
  assigned_by           BIGINT UNSIGNED NULL,   -- the user who gave it to them
  assigned_at           DATETIME NULL,
  notes                 TEXT NULL,
  created_by            BIGINT UNSIGNED NULL,
  created_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_cust_org (organization_id, stage),
  KEY idx_cust_assigned (assigned_employee_id),
  CONSTRAINT fk_cust_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT fk_cust_emp FOREIGN KEY (assigned_employee_id) REFERENCES employees(id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- Everything that happens with a customer: notes, calls, meetings, enquiries, complaints.
-- Enquiries & complaints have a status (open → resolved).
-- Any entry can carry a follow-up date for the handling employee.
CREATE TABLE IF NOT EXISTS customer_interactions (
  id               BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  organization_id  BIGINT UNSIGNED NOT NULL,
  customer_id      BIGINT UNSIGNED NOT NULL,
  type             ENUM('note','call','meeting','email','enquiry','complaint') NOT NULL DEFAULT 'note',
  subject          VARCHAR(160) NOT NULL,
  details          TEXT NULL,
  status           ENUM('open','resolved') NULL,
  follow_up_on     DATE NULL,
  follow_up_done   TINYINT(1) NOT NULL DEFAULT 0,
  employee_id      BIGINT UNSIGNED NULL,
  created_by       BIGINT UNSIGNED NULL,
  resolved_at      DATETIME NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_int_customer (customer_id),
  KEY idx_int_followup (organization_id, follow_up_done, follow_up_on),
  CONSTRAINT fk_int_org  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT fk_int_cust FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
  CONSTRAINT fk_int_emp  FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- ---------- Invoicing ----------
-- One row per organisation: numbering + what prints on every invoice
CREATE TABLE IF NOT EXISTS invoice_settings (
  organization_id   BIGINT UNSIGNED PRIMARY KEY,
  prefix            VARCHAR(10)  NOT NULL DEFAULT 'INV-',
  next_number       INT UNSIGNED NOT NULL DEFAULT 1,
  default_due_days  INT UNSIGNED NOT NULL DEFAULT 14,
  default_tax_rate  DECIMAL(5,2) NOT NULL DEFAULT 0,
  bank_name         VARCHAR(120) NULL,
  account_name      VARCHAR(160) NULL,
  account_number    VARCHAR(20)  NULL,
  footer_note       VARCHAR(500) NULL,
  updated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_invset_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- status is what the business did. "Overdue" is worked out on the fly:
-- (sent or partially_paid) AND due_date is before today.
CREATE TABLE IF NOT EXISTS invoices (
  id                BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  organization_id   BIGINT UNSIGNED NOT NULL,
  customer_id       BIGINT UNSIGNED NOT NULL,
  invoice_number    VARCHAR(40) NOT NULL,
  status            ENUM('draft','sent','partially_paid','paid','void') NOT NULL DEFAULT 'draft',
  issue_date        DATE NOT NULL,
  due_date          DATE NOT NULL,
  subtotal_kobo     BIGINT NOT NULL DEFAULT 0,
  discount_kobo     BIGINT NOT NULL DEFAULT 0,
  tax_rate          DECIMAL(5,2) NOT NULL DEFAULT 0,
  tax_kobo          BIGINT NOT NULL DEFAULT 0,
  total_kobo        BIGINT NOT NULL DEFAULT 0,
  amount_paid_kobo  BIGINT NOT NULL DEFAULT 0,
  notes             VARCHAR(1000) NULL,
  public_token      CHAR(32) NULL,
  sent_at           DATETIME NULL,
  viewed_at         DATETIME NULL,
  voided_at         DATETIME NULL,
  created_by        BIGINT UNSIGNED NULL,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_inv_number (organization_id, invoice_number),
  UNIQUE KEY uq_inv_token (public_token),
  KEY idx_inv_org_status (organization_id, status, due_date),
  KEY idx_inv_customer (customer_id),
  CONSTRAINT fk_invoice_org  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT fk_invoice_cust FOREIGN KEY (customer_id) REFERENCES customers(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS invoice_items (
  id                BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  invoice_id        BIGINT UNSIGNED NOT NULL,
  description       VARCHAR(255) NOT NULL,
  quantity          DECIMAL(12,2) NOT NULL DEFAULT 1,
  unit_price_kobo   BIGINT NOT NULL DEFAULT 0,
  line_total_kobo   BIGINT NOT NULL DEFAULT 0,
  sort_order        INT UNSIGNED NOT NULL DEFAULT 0,
  KEY idx_item_inv (invoice_id),
  CONSTRAINT fk_item_inv FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- request_id makes "record payment" safe to retry: the same request_id is only saved once
CREATE TABLE IF NOT EXISTS invoice_payments (
  id               BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  organization_id  BIGINT UNSIGNED NOT NULL,
  invoice_id       BIGINT UNSIGNED NOT NULL,
  customer_id      BIGINT UNSIGNED NOT NULL,
  amount_kobo      BIGINT NOT NULL,
  paid_on          DATE NOT NULL,
  method           ENUM('transfer','cash','pos','card','cheque','other') NOT NULL DEFAULT 'transfer',
  reference        VARCHAR(100) NULL,
  note             VARCHAR(255) NULL,
  request_id       VARCHAR(64) NULL,
  recorded_by      BIGINT UNSIGNED NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_pay_request (organization_id, request_id),
  KEY idx_pay_inv (invoice_id),
  KEY idx_pay_org_date (organization_id, paid_on),
  CONSTRAINT fk_pay_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT fk_pay_inv FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ---------- Finance: other income & expenses ----------
CREATE TABLE IF NOT EXISTS finance_categories (
  id               BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  organization_id  BIGINT UNSIGNED NOT NULL,
  type             ENUM('income','expense') NOT NULL,
  name             VARCHAR(80) NOT NULL,
  is_active        TINYINT(1) NOT NULL DEFAULT 1,
  UNIQUE KEY uq_fin_cat (organization_id, type, name),
  CONSTRAINT fk_fincat_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Income here is money NOT from invoices (invoice payments are in invoice_payments)
CREATE TABLE IF NOT EXISTS finance_entries (
  id                 BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  organization_id    BIGINT UNSIGNED NOT NULL,
  type               ENUM('income','expense') NOT NULL,
  category_id        BIGINT UNSIGNED NOT NULL,
  amount_kobo        BIGINT NOT NULL,
  entry_date         DATE NOT NULL,
  description        VARCHAR(255) NOT NULL,
  party              VARCHAR(160) NULL,
  method             ENUM('transfer','cash','pos','card','cheque','other') NOT NULL DEFAULT 'transfer',
  reference          VARCHAR(100) NULL,
  receipt_url        VARCHAR(500) NULL,
  receipt_public_id  VARCHAR(255) NULL,
  receipt_type       VARCHAR(20)  NULL,
  request_id         VARCHAR(64) NULL,
  recorded_by        BIGINT UNSIGNED NULL,
  created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_fin_request (organization_id, request_id),
  KEY idx_fin_org_date (organization_id, type, entry_date),
  CONSTRAINT fk_fin_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT fk_fin_cat FOREIGN KEY (category_id) REFERENCES finance_categories(id)
) ENGINE=InnoDB;

-- ============================================================
-- PHASE 3 — Payroll
-- Money in KOBO (BIGINT), like Phase 2.
-- ============================================================

-- One row per organisation: statutory deductions + Paystack connection
CREATE TABLE IF NOT EXISTS payroll_settings (
  organization_id        BIGINT UNSIGNED PRIMARY KEY,
  pay_day                TINYINT UNSIGNED NOT NULL DEFAULT 25,
  paye_enabled           TINYINT(1) NOT NULL DEFAULT 1,
  pension_enabled        TINYINT(1) NOT NULL DEFAULT 1,
  pension_employee_rate  DECIMAL(5,2) NOT NULL DEFAULT 8.00,
  pension_employer_rate  DECIMAL(5,2) NOT NULL DEFAULT 10.00,
  nhf_enabled            TINYINT(1) NOT NULL DEFAULT 0,
  nhf_rate               DECIMAL(5,2) NOT NULL DEFAULT 2.50,
  -- Paystack secret key, ENCRYPTED (AES-256-GCM). Never sent to the browser.
  paystack_secret_enc    TEXT NULL,
  paystack_key_last4     CHAR(4) NULL,
  updated_at             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_payset_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Each employee's monthly pay. Basic + housing + transport are "pensionable" (Pension Reform Act).
CREATE TABLE IF NOT EXISTS employee_pay (
  employee_id              BIGINT UNSIGNED PRIMARY KEY,
  organization_id          BIGINT UNSIGNED NOT NULL,
  basic_kobo               BIGINT NOT NULL DEFAULT 0,
  housing_kobo             BIGINT NOT NULL DEFAULT 0,
  transport_kobo           BIGINT NOT NULL DEFAULT 0,
  annual_rent_kobo         BIGINT NOT NULL DEFAULT 0,  -- declared rent, for rent relief
  nhf_opt_in               TINYINT(1) NOT NULL DEFAULT 0,
  bank_name                VARCHAR(120) NULL,
  bank_code                VARCHAR(10)  NULL,
  account_number           VARCHAR(10)  NULL,
  account_name             VARCHAR(160) NULL,
  paystack_recipient_code  VARCHAR(40)  NULL,  -- cleared whenever bank details change
  pfa_name                 VARCHAR(120) NULL,
  pension_pin              VARCHAR(30)  NULL,
  tax_id                   VARCHAR(30)  NULL,
  updated_at               DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_pay_org (organization_id),
  CONSTRAINT fk_epay_emp FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE,
  CONSTRAINT fk_epay_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Extra monthly allowances (e.g. "Phone allowance") and deductions (e.g. "Staff loan")
CREATE TABLE IF NOT EXISTS employee_pay_items (
  id               BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  organization_id  BIGINT UNSIGNED NOT NULL,
  employee_id      BIGINT UNSIGNED NOT NULL,
  type             ENUM('allowance','deduction') NOT NULL,
  name             VARCHAR(80) NOT NULL,
  amount_kobo      BIGINT NOT NULL,
  KEY idx_payitem_emp (employee_id),
  CONSTRAINT fk_payitem_emp FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE,
  CONSTRAINT fk_payitem_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- One payroll run per month: draft → approved → (processing) → paid
CREATE TABLE IF NOT EXISTS payroll_runs (
  id                     BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  organization_id        BIGINT UNSIGNED NOT NULL,
  period                 CHAR(7) NOT NULL,              -- "2026-11"
  status                 ENUM('draft','approved','processing','paid','cancelled') NOT NULL DEFAULT 'draft',
  employee_count         INT UNSIGNED NOT NULL DEFAULT 0,
  gross_kobo             BIGINT NOT NULL DEFAULT 0,
  paye_kobo              BIGINT NOT NULL DEFAULT 0,
  pension_employee_kobo  BIGINT NOT NULL DEFAULT 0,
  pension_employer_kobo  BIGINT NOT NULL DEFAULT 0,
  nhf_kobo               BIGINT NOT NULL DEFAULT 0,
  other_deductions_kobo  BIGINT NOT NULL DEFAULT 0,
  net_kobo               BIGINT NOT NULL DEFAULT 0,
  payment_method         ENUM('bank_upload','paystack','cash','other') NULL,
  prepared_by            BIGINT UNSIGNED NULL,
  approved_by            BIGINT UNSIGNED NULL,
  approved_at            DATETIME NULL,
  paid_at                DATETIME NULL,
  expenses_recorded      TINYINT(1) NOT NULL DEFAULT 0,
  created_at             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_run_org (organization_id, period),
  CONSTRAINT fk_run_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- One line per employee per run = their payslip
CREATE TABLE IF NOT EXISTS payroll_items (
  id                     BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  organization_id        BIGINT UNSIGNED NOT NULL,
  run_id                 BIGINT UNSIGNED NOT NULL,
  employee_id            BIGINT UNSIGNED NOT NULL,
  basic_kobo             BIGINT NOT NULL DEFAULT 0,
  housing_kobo           BIGINT NOT NULL DEFAULT 0,
  transport_kobo         BIGINT NOT NULL DEFAULT 0,
  allowances_kobo        BIGINT NOT NULL DEFAULT 0,
  bonus_kobo             BIGINT NOT NULL DEFAULT 0,     -- one-off, this month only
  proration_kobo         BIGINT NOT NULL DEFAULT 0,     -- taken off for joining mid-month / unpaid leave
  gross_kobo             BIGINT NOT NULL DEFAULT 0,
  pension_employee_kobo  BIGINT NOT NULL DEFAULT 0,
  pension_employer_kobo  BIGINT NOT NULL DEFAULT 0,
  nhf_kobo               BIGINT NOT NULL DEFAULT 0,
  paye_kobo              BIGINT NOT NULL DEFAULT 0,
  other_deductions_kobo  BIGINT NOT NULL DEFAULT 0,
  one_off_deduction_kobo BIGINT NOT NULL DEFAULT 0,     -- this month only
  net_kobo               BIGINT NOT NULL DEFAULT 0,
  days_payable           INT UNSIGNED NOT NULL DEFAULT 0,
  days_in_period         INT UNSIGNED NOT NULL DEFAULT 0,
  unpaid_leave_days      INT UNSIGNED NOT NULL DEFAULT 0,
  breakdown              TEXT NULL,                     -- JSON lines shown on the payslip
  -- bank details copied at approval time, so later edits don't change a run
  bank_name              VARCHAR(120) NULL,
  bank_code              VARCHAR(10)  NULL,
  account_number         VARCHAR(10)  NULL,
  account_name           VARCHAR(160) NULL,
  payment_status         ENUM('pending','processing','paid','failed') NOT NULL DEFAULT 'pending',
  transfer_reference     VARCHAR(64) NULL,
  transfer_code          VARCHAR(64) NULL,
  failure_reason         VARCHAR(255) NULL,
  paid_at                DATETIME NULL,
  UNIQUE KEY uq_item_run_emp (run_id, employee_id),
  UNIQUE KEY uq_item_reference (transfer_reference),
  KEY idx_item_emp (employee_id),
  CONSTRAINT fk_item_run FOREIGN KEY (run_id) REFERENCES payroll_runs(id) ON DELETE CASCADE,
  CONSTRAINT fk_item_emp2 FOREIGN KEY (employee_id) REFERENCES employees(id),
  CONSTRAINT fk_item_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ============================================================
-- PHASE 3B — TASKS & PERFORMANCE REVIEWS
-- ============================================================

-- A task assigned to one employee. Optional link to a customer.
CREATE TABLE IF NOT EXISTS tasks (
  id                     BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  organization_id        BIGINT UNSIGNED NOT NULL,
  title                  VARCHAR(200) NOT NULL,
  description            TEXT NULL,
  assigned_employee_id   BIGINT UNSIGNED NOT NULL,
  created_by             BIGINT UNSIGNED NULL,          -- user id
  due_date               DATE NULL,
  priority               ENUM('low','normal','high','urgent') NOT NULL DEFAULT 'normal',
  status                 ENUM('todo','in_progress','done','cancelled') NOT NULL DEFAULT 'todo',
  completed_at           DATETIME NULL,
  customer_id            BIGINT UNSIGNED NULL,
  project_id             BIGINT UNSIGNED NULL,          -- part of a project (optional)
  recurring_task_id      BIGINT UNSIGNED NULL,          -- made automatically from a repeating task
  created_at             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  -- a repeating task makes at most ONE task per due date (safe if the job runs twice)
  UNIQUE KEY uq_task_recurring_day (recurring_task_id, due_date),
  KEY idx_task_assignee (assigned_employee_id, status),
  KEY idx_task_org_due (organization_id, due_date),
  KEY idx_task_customer (customer_id),
  CONSTRAINT fk_task_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT fk_task_emp FOREIGN KEY (assigned_employee_id) REFERENCES employees(id) ON DELETE CASCADE,
  CONSTRAINT fk_task_cust FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS task_checklist_items (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  task_id     BIGINT UNSIGNED NOT NULL,
  text        VARCHAR(255) NOT NULL,
  is_done     TINYINT(1) NOT NULL DEFAULT 0,
  sort_order  INT NOT NULL DEFAULT 0,
  CONSTRAINT fk_check_task FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS task_comments (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  task_id     BIGINT UNSIGNED NOT NULL,
  user_id     BIGINT UNSIGNED NULL,
  body        TEXT NOT NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_comment_task FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- People tagged in a comment (@Name). Only they are notified about that comment.
CREATE TABLE IF NOT EXISTS task_comment_mentions (
  comment_id  BIGINT UNSIGNED NOT NULL,
  user_id     BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (comment_id, user_id),
  CONSTRAINT fk_mention_comment FOREIGN KEY (comment_id) REFERENCES task_comments(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS task_attachments (
  id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  task_id        BIGINT UNSIGNED NOT NULL,
  file_name      VARCHAR(255) NOT NULL,
  file_url       VARCHAR(500) NOT NULL,
  public_id      VARCHAR(255) NOT NULL,
  resource_type  VARCHAR(20)  NOT NULL DEFAULT 'image',
  uploaded_by    BIGINT UNSIGNED NULL,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_attach_task FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- A task that repeats: every working day, weekly on a weekday, or monthly on a date
CREATE TABLE IF NOT EXISTS recurring_tasks (
  id                     BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  organization_id        BIGINT UNSIGNED NOT NULL,
  title                  VARCHAR(200) NOT NULL,
  description            TEXT NULL,
  assigned_employee_id   BIGINT UNSIGNED NOT NULL,
  priority               ENUM('low','normal','high','urgent') NOT NULL DEFAULT 'normal',
  frequency              ENUM('daily','weekly','monthly') NOT NULL,
  weekday                TINYINT UNSIGNED NULL,   -- weekly: 1 = Monday … 7 = Sunday
  month_day              TINYINT UNSIGNED NULL,   -- monthly: 1–31 (31 = last day of short months)
  next_run_on            DATE NOT NULL,           -- the next date a task will be made for
  is_active              TINYINT(1) NOT NULL DEFAULT 1,
  created_by             BIGINT UNSIGNED NULL,
  created_at             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_rec_next (is_active, next_run_on),
  CONSTRAINT fk_rec_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT fk_rec_emp FOREIGN KEY (assigned_employee_id) REFERENCES employees(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Remembers that a daily job already ran for a date, so it never runs twice
CREATE TABLE IF NOT EXISTS job_runs (
  job_name   VARCHAR(60) NOT NULL,
  run_date   DATE NOT NULL,
  ran_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (job_name, run_date)
) ENGINE=InnoDB;

-- ---------- Performance reviews ----------
CREATE TABLE IF NOT EXISTS review_settings (
  organization_id  BIGINT UNSIGNED PRIMARY KEY,
  frequency        ENUM('monthly','quarterly') NOT NULL DEFAULT 'monthly',
  self_review      TINYINT(1) NOT NULL DEFAULT 1,   -- employee rates themselves first
  CONSTRAINT fk_revset_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- What staff are rated on, and how much each part counts (weights add up to 100)
CREATE TABLE IF NOT EXISTS review_criteria (
  id               BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  organization_id  BIGINT UNSIGNED NOT NULL,
  name             VARCHAR(120) NOT NULL,
  description      VARCHAR(255) NULL,
  weight           TINYINT UNSIGNED NOT NULL,
  sort_order       INT NOT NULL DEFAULT 0,
  is_active        TINYINT(1) NOT NULL DEFAULT 1,
  CONSTRAINT fk_crit_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- One review per employee per period ("2026-11" or "2026-Q4")
CREATE TABLE IF NOT EXISTS reviews (
  id                   BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  organization_id      BIGINT UNSIGNED NOT NULL,
  employee_id          BIGINT UNSIGNED NOT NULL,
  period               VARCHAR(7) NOT NULL,
  period_start         DATE NOT NULL,
  period_end           DATE NOT NULL,
  status               ENUM('self_review','manager_review','acknowledgement','completed','cancelled') NOT NULL,
  reviewer_user_id     BIGINT UNSIGNED NULL,
  overall_score        DECIMAL(4,2) NULL,             -- weighted, out of 5
  self_summary         TEXT NULL,
  manager_summary      TEXT NULL,
  goals                TEXT NULL,                     -- agreed goals for next period
  employee_comment     TEXT NULL,
  facts                TEXT NULL,                     -- JSON: attendance & task numbers frozen at submission
  created_by           BIGINT UNSIGNED NULL,
  self_submitted_at    DATETIME NULL,
  manager_submitted_at DATETIME NULL,
  acknowledged_at      DATETIME NULL,
  created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- `active_key` is the period while the review is live, NULL once cancelled,
  -- so a cancelled review doesn't block starting a new one for the same period
  active_key           VARCHAR(7) NULL,
  UNIQUE KEY uq_review_emp_period (employee_id, active_key),
  KEY idx_review_org_period (organization_id, period),
  CONSTRAINT fk_review_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT fk_review_emp FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- A rating per criterion (name & weight copied, so editing criteria later doesn't change old reviews)
CREATE TABLE IF NOT EXISTS review_scores (
  id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  review_id       BIGINT UNSIGNED NOT NULL,
  criterion_id    BIGINT UNSIGNED NULL,
  name            VARCHAR(120) NOT NULL,
  weight          TINYINT UNSIGNED NOT NULL,
  sort_order      INT NOT NULL DEFAULT 0,
  self_rating     TINYINT UNSIGNED NULL,     -- 1–5
  manager_rating  TINYINT UNSIGNED NULL,     -- 1–5
  comment         VARCHAR(500) NULL,
  CONSTRAINT fk_score_review FOREIGN KEY (review_id) REFERENCES reviews(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ============================================================
-- PLANS & BILLING — yearly subscription per organisation
-- ============================================================

-- One row per organisation. Organisations created before plans existed are
-- "legacy": full access, no end date (npm run db:sync adds their row).
CREATE TABLE IF NOT EXISTS subscriptions (
  organization_id       BIGINT UNSIGNED PRIMARY KEY,
  plan                  ENUM('starter','business','enterprise') NOT NULL,
  status                ENUM('pending_payment','trial','active') NOT NULL DEFAULT 'trial',
  current_period_start  DATE NULL,
  current_period_end    DATE NULL,      -- last day of the paid month / year (or of the free trial)
  is_legacy             TINYINT(1) NOT NULL DEFAULT 0,
  billing_interval      ENUM('monthly','yearly') NULL,
  -- Paystack automatic renewal (the card is charged again at the end of each period)
  auto_renew            TINYINT(1) NOT NULL DEFAULT 1,
  renewal_problem       VARCHAR(255) NULL,        -- e.g. "The card was declined" (shown on Billing)
  paystack_customer_code      VARCHAR(64) NULL,
  paystack_authorization_code VARCHAR(64) NULL,
  paystack_subscription_code  VARCHAR(64) NULL,
  paystack_email_token        VARCHAR(64) NULL,
  next_plan             ENUM('starter','business','enterprise') NULL,  -- a change waiting for the next period
  next_interval         ENUM('monthly','yearly') NULL,
  created_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_sub_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Every payment attempt to Workard (through WORKARD's own Paystack account)
CREATE TABLE IF NOT EXISTS billing_payments (
  id                BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  organization_id   BIGINT UNSIGNED NOT NULL,
  reference         VARCHAR(100) NOT NULL,         -- one payment = one reference (ours: wkbill_…, renewals: Paystack's)
  plan              ENUM('starter','business','enterprise') NOT NULL,
  kind              ENUM('new','renewal','upgrade','auto_renewal') NOT NULL,
  billing_interval  ENUM('monthly','yearly') NULL,
  amount_kobo       BIGINT NOT NULL,
  status            ENUM('initiated','paid','failed') NOT NULL DEFAULT 'initiated',
  authorization_url VARCHAR(500) NULL,
  period_start      DATE NULL,                     -- filled in when paid
  period_end        DATE NULL,
  paid_at           DATETIME NULL,
  created_by        BIGINT UNSIGNED NULL,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_billing_reference (reference),
  KEY idx_billing_org (organization_id, created_at),
  CONSTRAINT fk_billing_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Paystack "plans" Workard has created (one per plan + interval + price).
-- Paystack charges subscribers on these automatically every month / year.
CREATE TABLE IF NOT EXISTS billing_plan_codes (
  plan              ENUM('starter','business','enterprise') NOT NULL,
  billing_interval  ENUM('monthly','yearly') NOT NULL,
  amount_kobo       BIGINT NOT NULL,
  plan_code         VARCHAR(64) NOT NULL,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (plan, billing_interval, amount_kobo),
  UNIQUE KEY uq_plan_code (plan_code)
) ENGINE=InnoDB;

-- ============================================================
-- ONBOARDING — checklists for new joiners (and for HR)
-- ============================================================

-- A reusable checklist, e.g. "New employee" or "New manager"
CREATE TABLE IF NOT EXISTS onboarding_templates (
  id               BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  organization_id  BIGINT UNSIGNED NOT NULL,
  name             VARCHAR(120) NOT NULL,
  description      VARCHAR(255) NULL,
  kind             ENUM('onboarding','offboarding') NOT NULL DEFAULT 'onboarding',
  suits            ENUM('everyone','staff','managers','resignation','termination') NOT NULL DEFAULT 'everyone',
  is_active        TINYINT(1) NOT NULL DEFAULT 1,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_obt_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- An item on a template. `owner` = who does it: the new joiner, or HR / the owner.
CREATE TABLE IF NOT EXISTS onboarding_template_items (
  id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  template_id  BIGINT UNSIGNED NOT NULL,
  title        VARCHAR(200) NOT NULL,
  description  VARCHAR(500) NULL,
  owner        ENUM('new_joiner','hr') NOT NULL,
  due_day      SMALLINT NOT NULL DEFAULT 0,       -- days after the start date (0 = first day)
  asks_for_note TINYINT(1) NOT NULL DEFAULT 0,    -- offboarding: the leaver writes something (e.g. a handover note)
  sort_order   INT NOT NULL DEFAULT 0,
  CONSTRAINT fk_obti_template FOREIGN KEY (template_id) REFERENCES onboarding_templates(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- One onboarding for one new joiner
CREATE TABLE IF NOT EXISTS onboardings (
  id               BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  organization_id  BIGINT UNSIGNED NOT NULL,
  employee_id      BIGINT UNSIGNED NOT NULL,
  template_name    VARCHAR(120) NOT NULL,         -- copied, so renaming a template doesn't change history
  start_date       DATE NOT NULL,
  status           ENUM('in_progress','completed','cancelled') NOT NULL DEFAULT 'in_progress',
  started_by       BIGINT UNSIGNED NULL,          -- user id (HR / owner)
  completed_at     DATETIME NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- one live onboarding per person (NULL once finished or cancelled)
  active_key       TINYINT NULL DEFAULT 1,
  UNIQUE KEY uq_onboarding_active (employee_id, active_key),
  KEY idx_onboarding_org (organization_id, status),
  CONSTRAINT fk_ob_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT fk_ob_emp FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- The items copied from the template (plus any added for this person)
CREATE TABLE IF NOT EXISTS onboarding_items (
  id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  onboarding_id   BIGINT UNSIGNED NOT NULL,
  title           VARCHAR(200) NOT NULL,
  description     VARCHAR(500) NULL,
  owner           ENUM('new_joiner','hr') NOT NULL,
  due_date        DATE NULL,
  sort_order      INT NOT NULL DEFAULT 0,
  done_at         DATETIME NULL,
  done_by         BIGINT UNSIGNED NULL,           -- user id
  CONSTRAINT fk_obi_onboarding FOREIGN KEY (onboarding_id) REFERENCES onboardings(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ============================================================
-- OFFBOARDING — someone leaving
--   resignation: the employee resigns (Requests → Resign) → the notice period starts
--                (organizations.notice_days, default 30) → HR sends a checklist
--   termination: HR exits someone with a checklist due within 24 hours
--   They stop being able to log in at ends_at (automatically) or when HR clicks "Exit now".
-- Checklists come from onboarding_templates with kind = 'offboarding'.
-- ============================================================
CREATE TABLE IF NOT EXISTS offboardings (
  id                  BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  organization_id     BIGINT UNSIGNED NOT NULL,
  employee_id         BIGINT UNSIGNED NOT NULL,
  exit_type           ENUM('resignation','termination') NOT NULL,
  reason              VARCHAR(1000) NULL,
  started_by          BIGINT UNSIGNED NULL,          -- user id (the employee who resigned, or HR)
  by_employee         TINYINT(1) NOT NULL DEFAULT 0, -- 1 = they resigned themselves
  notice_start        DATETIME NOT NULL,
  last_day            DATE NOT NULL,
  ends_at             DATETIME NOT NULL,             -- when their access ends
  template_name       VARCHAR(120) NULL,             -- NULL until HR sends a checklist
  checklist_sent_at   DATETIME NULL,
  checklist_done_at   DATETIME NULL,
  status              ENUM('notice','in_progress','exited','withdrawn','cancelled') NOT NULL DEFAULT 'notice',
  exited_at           DATETIME NULL,
  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  active_key          TINYINT NULL DEFAULT 1,        -- one live offboarding per person
  UNIQUE KEY uq_offboarding_active (employee_id, active_key),
  KEY idx_offboarding_org (organization_id, status),
  KEY idx_offboarding_end (status, ends_at),
  CONSTRAINT fk_off_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT fk_off_emp FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS offboarding_items (
  id                BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  offboarding_id    BIGINT UNSIGNED NOT NULL,
  title             VARCHAR(200) NOT NULL,
  description       VARCHAR(500) NULL,
  owner             ENUM('employee','hr') NOT NULL,
  due_at            DATETIME NULL,
  asks_for_note     TINYINT(1) NOT NULL DEFAULT 0,
  note              TEXT NULL,                       -- e.g. the handover note, or "returned laptop to Tunde"
  sort_order        INT NOT NULL DEFAULT 0,
  done_at           DATETIME NULL,
  done_by           BIGINT UNSIGNED NULL,
  CONSTRAINT fk_offi_off FOREIGN KEY (offboarding_id) REFERENCES offboardings(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ============================================================
-- PUBLIC HOLIDAYS — days nobody is expected at work (not counted as absent)
-- ============================================================
CREATE TABLE IF NOT EXISTS holidays (
  id               BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  organization_id  BIGINT UNSIGNED NOT NULL,
  holiday_date     DATE NOT NULL,
  name             VARCHAR(120) NOT NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_holiday_day (organization_id, holiday_date),
  CONSTRAINT fk_holiday_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ============================================================
-- FLAGGED / LATE CLOCK-INS — the employee's side of the story
-- A flagged clock-in waits 24 hours for the employee to accept or dispute it
-- (with a reason). Then it goes to managers. 'no_response' is added when the
-- 24 hours run out without an answer. Late (but not flagged) days can also get a reason.
-- ============================================================
CREATE TABLE IF NOT EXISTS attendance_explanations (
  attendance_id      BIGINT UNSIGNED PRIMARY KEY,
  organization_id    BIGINT UNSIGNED NOT NULL,
  response           ENUM('accept','dispute','no_response') NOT NULL,
  reason             VARCHAR(1000) NULL,
  responded_by       BIGINT UNSIGNED NULL,   -- user id (NULL for no_response)
  responded_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_attx_att FOREIGN KEY (attendance_id) REFERENCES attendance(id) ON DELETE CASCADE,
  CONSTRAINT fk_attx_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ---------- Sales pipeline history ----------
-- One row every time a customer moves stage (lead → prospect → customer / lost).
-- from_stage is NULL for the row written when the customer was added.
-- The sales dashboard counts conversions and lost deals from this table.
CREATE TABLE IF NOT EXISTS customer_stage_changes (
  id               BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  organization_id  BIGINT UNSIGNED NOT NULL,
  customer_id      BIGINT UNSIGNED NOT NULL,
  from_stage       VARCHAR(20) NULL,
  to_stage         VARCHAR(20) NOT NULL,
  changed_by       BIGINT UNSIGNED NULL,
  changed_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_csc_org (organization_id, to_stage, changed_at),
  KEY idx_csc_customer (customer_id),
  CONSTRAINT fk_csc_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT fk_csc_customer FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ---------- Invoice branding ----------
-- Logo, brand colour and the business's signature on every invoice.
-- logo_url / signature_url: a Cloudinary link (or, in development without
-- Cloudinary, the image itself as a data: URL — hence MEDIUMTEXT).
CREATE TABLE IF NOT EXISTS invoice_branding (
  organization_id      BIGINT UNSIGNED PRIMARY KEY,
  logo_url             MEDIUMTEXT NULL,
  logo_public_id       VARCHAR(255) NULL,
  brand_color          CHAR(7) NULL,          -- e.g. #1d4ed8
  signature_url        MEDIUMTEXT NULL,
  signature_public_id  VARCHAR(255) NULL,
  signatory_name       VARCHAR(120) NULL,
  signatory_title      VARCHAR(120) NULL,
  updated_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_brand_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- The customer accepting an invoice on the public link: their name, drawn signature, a note.
-- One per invoice. signature_data is a small PNG as a data: URL (customers can't upload files).
CREATE TABLE IF NOT EXISTS invoice_acceptances (
  invoice_id       BIGINT UNSIGNED PRIMARY KEY,
  organization_id  BIGINT UNSIGNED NOT NULL,
  signer_name      VARCHAR(120) NOT NULL,
  signature_data   MEDIUMTEXT NOT NULL,
  note             VARCHAR(1000) NULL,
  ip_address       VARCHAR(64) NULL,
  accepted_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_acc_invoice FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE,
  CONSTRAINT fk_acc_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ---------- Notifications (the bell) ----------
-- One row per person per event. The app checks for new ones every ~30 seconds
-- (no websockets needed). link = where clicking it goes, e.g. /customers/12
CREATE TABLE IF NOT EXISTS notifications (
  id               BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  organization_id  BIGINT UNSIGNED NOT NULL,
  user_id          BIGINT UNSIGNED NOT NULL,
  type             VARCHAR(40) NOT NULL,
  title            VARCHAR(200) NOT NULL,
  body             VARCHAR(500) NULL,
  link             VARCHAR(255) NULL,
  actor_user_id    BIGINT UNSIGNED NULL,
  read_at          DATETIME NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_notif_user (user_id, organization_id, read_at, id),
  CONSTRAINT fk_notif_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT fk_notif_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ============================================================
-- ANNOUNCEMENTS — a feed like Google Classroom: posts to a group, with comments
-- audience_type / audience_id: who it's for (see utils/audience.js)
-- ============================================================
CREATE TABLE IF NOT EXISTS announcements (
  id                  BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  organization_id     BIGINT UNSIGNED NOT NULL,
  author_user_id      BIGINT UNSIGNED NOT NULL,
  audience_type       ENUM('company','branch','department','team') NOT NULL DEFAULT 'company',
  audience_id         BIGINT UNSIGNED NULL,
  title               VARCHAR(200) NOT NULL,
  body                TEXT NOT NULL,
  is_pinned           TINYINT(1) NOT NULL DEFAULT 0,
  needs_ack           TINYINT(1) NOT NULL DEFAULT 0,   -- staff tap "I've read this"
  attachment_url      MEDIUMTEXT NULL,
  attachment_name     VARCHAR(255) NULL,
  attachment_public_id VARCHAR(255) NULL,
  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_ann_org (organization_id, is_pinned, created_at),
  CONSTRAINT fk_ann_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT fk_ann_author FOREIGN KEY (author_user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS announcement_comments (
  id               BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  announcement_id  BIGINT UNSIGNED NOT NULL,
  user_id          BIGINT UNSIGNED NOT NULL,
  body             VARCHAR(2000) NOT NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_annc_post (announcement_id, created_at),
  CONSTRAINT fk_annc_post FOREIGN KEY (announcement_id) REFERENCES announcements(id) ON DELETE CASCADE,
  CONSTRAINT fk_annc_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Who has seen each post (and who tapped "I've read this")
CREATE TABLE IF NOT EXISTS announcement_reads (
  announcement_id  BIGINT UNSIGNED NOT NULL,
  user_id          BIGINT UNSIGNED NOT NULL,
  seen_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  acknowledged_at  DATETIME NULL,
  PRIMARY KEY (announcement_id, user_id),
  CONSTRAINT fk_annr_post FOREIGN KEY (announcement_id) REFERENCES announcements(id) ON DELETE CASCADE,
  CONSTRAINT fk_annr_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ============================================================
-- STAFF REQUESTS — salary advances & loans, repaid through payroll
--   pending → approved (line manager) → paid_out (payroll paid the money) → repaid
--   (or rejected / cancelled)
-- Amounts in kobo. A loan's interest is flat: total = amount × (1 + rate).
-- ============================================================
CREATE TABLE IF NOT EXISTS staff_requests (
  id                      BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  organization_id         BIGINT UNSIGNED NOT NULL,
  employee_id             BIGINT UNSIGNED NOT NULL,
  type                    ENUM('advance','loan') NOT NULL,
  amount_kobo             BIGINT NOT NULL,              -- what the employee receives
  interest_rate_bp        INT UNSIGNED NOT NULL DEFAULT 0,  -- 500 = 5%
  total_repayable_kobo    BIGINT NOT NULL,              -- amount + interest
  months                  TINYINT UNSIGNED NOT NULL,    -- copied from the company's rules when asked
  monthly_deduction_kobo  BIGINT NOT NULL,
  repaid_kobo             BIGINT NOT NULL DEFAULT 0,
  reason                  VARCHAR(1000) NULL,
  status                  ENUM('pending','approved','rejected','cancelled','paid_out','repaid') NOT NULL DEFAULT 'pending',
  decided_by              BIGINT UNSIGNED NULL,
  decided_at              DATETIME NULL,
  decision_note           VARCHAR(500) NULL,
  paid_out_by             BIGINT UNSIGNED NULL,
  paid_out_at             DATETIME NULL,
  created_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_req_org (organization_id, status),
  KEY idx_req_emp (employee_id, status),
  CONSTRAINT fk_req_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT fk_req_emp FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Each company's own loan & advance rules (Settings → Loans & advances).
-- No row = the defaults in config/requestRules.js (100% of yearly basic, 12 months, 5% flat).
CREATE TABLE IF NOT EXISTS staff_request_settings (
  organization_id      BIGINT UNSIGNED PRIMARY KEY,
  loans_enabled        TINYINT(1) NOT NULL DEFAULT 1,
  loan_max_percent     SMALLINT UNSIGNED NOT NULL DEFAULT 100,   -- % of a YEAR's basic pay
  loan_max_kobo        BIGINT NULL,                              -- optional fixed ceiling
  loan_months          TINYINT UNSIGNED NOT NULL DEFAULT 12,
  loan_interest_bp     INT UNSIGNED NOT NULL DEFAULT 500,        -- 500 = 5% flat
  advances_enabled     TINYINT(1) NOT NULL DEFAULT 1,
  advance_max_percent  SMALLINT UNSIGNED NOT NULL DEFAULT 100,   -- % of a MONTH's basic pay
  advance_months       TINYINT UNSIGNED NOT NULL DEFAULT 1,
  advance_interest_bp  INT UNSIGNED NOT NULL DEFAULT 0,
  updated_by           BIGINT UNSIGNED NULL,
  updated_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_reqset_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- One row per request per paid payroll: the repayment taken from that month's salary.
-- UNIQUE(request, run) means a payroll can never count a repayment twice.
CREATE TABLE IF NOT EXISTS staff_request_repayments (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  request_id    BIGINT UNSIGNED NOT NULL,
  run_id        BIGINT UNSIGNED NOT NULL,
  amount_kobo   BIGINT NOT NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_repay_run (request_id, run_id),
  CONSTRAINT fk_repay_req FOREIGN KEY (request_id) REFERENCES staff_requests(id) ON DELETE CASCADE,
  CONSTRAINT fk_repay_run FOREIGN KEY (run_id) REFERENCES payroll_runs(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ---------- Staff feedback: about my job, complaints, suggestions ----------
-- Anonymous feedback stores NO employee or user — the sender follows it with a
-- private link (only a hash of its token is stored, like a password).
CREATE TABLE IF NOT EXISTS staff_feedback (
  id               BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  organization_id  BIGINT UNSIGNED NOT NULL,
  category         ENUM('job','complaint','suggestion') NOT NULL,
  subject          VARCHAR(200) NOT NULL,
  body             TEXT NOT NULL,
  is_anonymous     TINYINT(1) NOT NULL DEFAULT 0,
  employee_id      BIGINT UNSIGNED NULL,          -- NULL when anonymous
  user_id          BIGINT UNSIGNED NULL,          -- NULL when anonymous
  token_hash       CHAR(64) NULL,                 -- anonymous sender's private link
  status           ENUM('received','in_review','resolved') NOT NULL DEFAULT 'received',
  created_at       DATE NOT NULL,                 -- the day only (an exact time could identify the sender)
  updated_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_fb_org (organization_id, status),
  UNIQUE KEY uq_fb_token (token_hash),
  CONSTRAINT fk_fb_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS staff_feedback_replies (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  feedback_id   BIGINT UNSIGNED NOT NULL,
  from_sender   TINYINT(1) NOT NULL DEFAULT 0,   -- 1 = the person who sent the feedback
  user_id       BIGINT UNSIGNED NULL,            -- who replied (NULL for an anonymous sender)
  body          TEXT NOT NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_fbr (feedback_id),
  CONSTRAINT fk_fbr_fb FOREIGN KEY (feedback_id) REFERENCES staff_feedback(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ============================================================
-- TEAM RESOURCES — materials for a group (SOPs, sales scripts, brochures, price lists)
--   kind 'document' → written in Workard, editable (body = cleaned HTML)
--   kind 'file'     → an uploaded PDF / Word / Excel / image; not editable here —
--                     upload a new version instead
-- Every edit / new upload keeps the old one in resource_versions.
-- ============================================================
CREATE TABLE IF NOT EXISTS resources (
  id                BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  organization_id   BIGINT UNSIGNED NOT NULL,
  audience_type     ENUM('company','branch','department','team') NOT NULL DEFAULT 'team',
  audience_id       BIGINT UNSIGNED NULL,
  kind              ENUM('document','file') NOT NULL,
  title             VARCHAR(200) NOT NULL,
  description       VARCHAR(500) NULL,
  body              MEDIUMTEXT NULL,                -- document
  file_url          MEDIUMTEXT NULL,                -- file
  file_name         VARCHAR(255) NULL,
  file_type         VARCHAR(120) NULL,
  file_size         INT UNSIGNED NULL,
  file_public_id    VARCHAR(255) NULL,
  version           INT UNSIGNED NOT NULL DEFAULT 1,
  created_by        BIGINT UNSIGNED NOT NULL,
  updated_by        BIGINT UNSIGNED NULL,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_res_org (organization_id, audience_type, audience_id),
  CONSTRAINT fk_res_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS resource_versions (
  id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  resource_id     BIGINT UNSIGNED NOT NULL,
  version         INT UNSIGNED NOT NULL,
  title           VARCHAR(200) NOT NULL,
  body            MEDIUMTEXT NULL,
  file_url        MEDIUMTEXT NULL,
  file_name       VARCHAR(255) NULL,
  file_public_id  VARCHAR(255) NULL,
  saved_by        BIGINT UNSIGNED NULL,
  saved_at        DATETIME NOT NULL,
  UNIQUE KEY uq_res_version (resource_id, version),
  CONSTRAINT fk_resv_res FOREIGN KEY (resource_id) REFERENCES resources(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ============================================================
-- PROJECTS & SHARED TASKS
-- A project belongs to a group (team / department / branch / company) and groups tasks.
-- A task can have several people on it: tasks.assigned_employee_id is the LEAD,
-- task_assignees lists everyone on it (the lead included).
-- ============================================================
CREATE TABLE IF NOT EXISTS projects (
  id               BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  organization_id  BIGINT UNSIGNED NOT NULL,
  name             VARCHAR(150) NOT NULL,
  description      VARCHAR(1000) NULL,
  audience_type    ENUM('company','branch','department','team') NOT NULL DEFAULT 'team',
  audience_id      BIGINT UNSIGNED NULL,
  color            CHAR(7) NOT NULL DEFAULT '#2a78d6',
  status           ENUM('active','completed','archived') NOT NULL DEFAULT 'active',
  due_date         DATE NULL,
  created_by       BIGINT UNSIGNED NOT NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_proj_org (organization_id, status),
  CONSTRAINT fk_proj_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS task_assignees (
  task_id      BIGINT UNSIGNED NOT NULL,
  employee_id  BIGINT UNSIGNED NOT NULL,
  added_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (task_id, employee_id),
  KEY idx_ta_emp (employee_id),
  CONSTRAINT fk_ta_task FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  CONSTRAINT fk_ta_emp FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ============================================================
-- MEETINGS (video by LiveKit) — for chosen people, a team, a department, a branch or everyone
--   audience_type 'people' = only the people in meeting_invitees
--   repeat: a daily stand-up is ONE meeting row that repeats (each day is an "occurrence")
--   is_standup: the meeting room shows each person's tasks (done / doing / overdue)
-- ============================================================
CREATE TABLE IF NOT EXISTS meetings (
  id                BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  organization_id   BIGINT UNSIGNED NOT NULL,
  title             VARCHAR(200) NOT NULL,
  description       VARCHAR(1000) NULL,
  audience_type     ENUM('people','company','branch','department','team') NOT NULL DEFAULT 'people',
  audience_id       BIGINT UNSIGNED NULL,
  project_id        BIGINT UNSIGNED NULL,
  starts_at         DATETIME NOT NULL,          -- the first (or only) time
  duration_minutes  SMALLINT UNSIGNED NOT NULL DEFAULT 30,
  repeat_rule       ENUM('none','daily','weekdays','weekly','monthly') NOT NULL DEFAULT 'none',
  repeat_every      TINYINT UNSIGNED NOT NULL DEFAULT 1,  -- every N days / weeks / months
  repeat_days       VARCHAR(200) NULL,           -- weekly: [{"day":3,"time":"10:00"},{"day":5,"time":"14:30"}] (0 = Sunday)
  repeat_until      DATE NULL,
  is_standup        TINYINT(1) NOT NULL DEFAULT 0,
  created_by        BIGINT UNSIGNED NOT NULL,
  cancelled_at      DATETIME NULL,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_meet_org (organization_id, starts_at),
  CONSTRAINT fk_meet_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Extra people invited (all of them, when audience_type = 'people')
CREATE TABLE IF NOT EXISTS meeting_invitees (
  meeting_id   BIGINT UNSIGNED NOT NULL,
  employee_id  BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (meeting_id, employee_id),
  KEY idx_mi_emp (employee_id),
  CONSTRAINT fk_mi_meet FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE,
  CONSTRAINT fk_mi_emp FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Single dates of a repeating meeting the organiser cancelled ("just this Friday")
CREATE TABLE IF NOT EXISTS meeting_skips (
  meeting_id  BIGINT UNSIGNED NOT NULL,
  skip_date   DATE NOT NULL,
  PRIMARY KEY (meeting_id, skip_date),
  CONSTRAINT fk_mskip_meet FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Who joined which day's meeting (first join only)
CREATE TABLE IF NOT EXISTS meeting_attendance (
  meeting_id       BIGINT UNSIGNED NOT NULL,
  occurrence_date  DATE NOT NULL,
  user_id          BIGINT UNSIGNED NOT NULL,
  joined_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (meeting_id, occurrence_date, user_id),
  CONSTRAINT fk_ma_meet FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ============================================================
-- PLATFORM (Workard itself) — super admins, settings, blog, support access
-- These are not part of any company. See STRUCTURE.md "Super admin".
-- ============================================================

-- Workard staff who run the platform. All super admins have the same rights.
-- A new admin sets their password through a one-time link (setup_token_hash).
CREATE TABLE IF NOT EXISTS platform_admins (
  user_id            BIGINT UNSIGNED PRIMARY KEY,
  added_by           BIGINT UNSIGNED NULL,
  setup_token_hash   CHAR(64) NULL,
  setup_expires_at   DATETIME NULL,
  created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_padmin_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Everything a super admin does (who, what, to which company / user / post)
CREATE TABLE IF NOT EXISTS admin_audit (
  id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  admin_user_id  BIGINT UNSIGNED NOT NULL,
  action         VARCHAR(60) NOT NULL,
  target_type    VARCHAR(30) NULL,
  target_id      BIGINT UNSIGNED NULL,
  details        VARCHAR(500) NULL,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_aa_time (created_at)
) ENGINE=InnoDB;

-- Settings the super admin can change without a deploy: plan prices, trial length.
-- value is JSON text, e.g. key 'prices' → {"starter":{"monthly":1500000,"yearly":15598800},…}
CREATE TABLE IF NOT EXISTS platform_settings (
  setting_key  VARCHAR(60) PRIMARY KEY,
  value        TEXT NOT NULL,
  updated_by   BIGINT UNSIGNED NULL,
  updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- The company owner lets Workard support look around (read-only) for a few hours
CREATE TABLE IF NOT EXISTS support_grants (
  id               BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  organization_id  BIGINT UNSIGNED NOT NULL,
  granted_by       BIGINT UNSIGNED NOT NULL,
  reason           VARCHAR(255) NULL,
  expires_at       DATETIME NOT NULL,
  revoked_at       DATETIME NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_sg_org (organization_id, expires_at),
  CONSTRAINT fk_sg_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- "Book a demo" requests from the website
CREATE TABLE IF NOT EXISTS demo_requests (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  full_name     VARCHAR(120) NOT NULL,
  email         VARCHAR(190) NOT NULL,
  phone         VARCHAR(30)  NULL,
  company       VARCHAR(160) NULL,
  company_size  VARCHAR(20)  NULL,
  message       VARCHAR(1000) NULL,
  status        ENUM('new','contacted','closed') NOT NULL DEFAULT 'new',
  note          VARCHAR(500) NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_demo_status (status, created_at)
) ENGINE=InnoDB;

-- Messages from Workard to company owners (bell + optional email)
CREATE TABLE IF NOT EXISTS platform_announcements (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  title         VARCHAR(200) NOT NULL,
  body          VARCHAR(2000) NOT NULL,
  audience      ENUM('all','trial','paying') NOT NULL DEFAULT 'all',
  emailed       TINYINT(1) NOT NULL DEFAULT 0,
  sent_to       INT UNSIGNED NOT NULL DEFAULT 0,
  created_by    BIGINT UNSIGNED NOT NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- The blog on the website. published_at in the future = scheduled.
CREATE TABLE IF NOT EXISTS blog_posts (
  id               BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  slug             VARCHAR(160) NOT NULL,
  title            VARCHAR(200) NOT NULL,
  excerpt          VARCHAR(400) NULL,
  body_html        MEDIUMTEXT NOT NULL,
  cover_url        VARCHAR(500) NULL,
  category         VARCHAR(60) NULL,
  seo_title        VARCHAR(200) NULL,
  seo_description  VARCHAR(300) NULL,
  status           ENUM('draft','published') NOT NULL DEFAULT 'draft',
  published_at     DATETIME NULL,
  author_user_id   BIGINT UNSIGNED NOT NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_blog_slug (slug),
  KEY idx_blog_pub (status, published_at)
) ENGINE=InnoDB;

-- ============================================================
-- MAIL — people send email from their own Gmail / Outlook inside Workard
-- (V1: connect a mailbox, send + keep a record, read the inbox live where allowed).
-- Received email is NEVER stored here; the inbox is fetched live from Google/Microsoft.
-- ============================================================

-- A person's connected mailbox (one per person per company). Tokens are encrypted (ENCRYPTION_KEY).
CREATE TABLE IF NOT EXISTS mail_accounts (
  id                 BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  organization_id    BIGINT UNSIGNED NOT NULL,
  user_id            BIGINT UNSIGNED NOT NULL,
  provider           ENUM('google','microsoft') NOT NULL,
  email              VARCHAR(190) NOT NULL,
  display_name       VARCHAR(150) NULL,
  refresh_token_enc  TEXT NOT NULL,
  access_token_enc   TEXT NULL,
  access_expires_at  DATETIME NULL,
  scopes             VARCHAR(600) NULL,
  is_workspace       TINYINT(1) NOT NULL DEFAULT 0,   -- Google Workspace (company) account, not @gmail.com
  can_read           TINYINT(1) NOT NULL DEFAULT 0,   -- read permission was granted (inbox)
  signature_html     TEXT NULL,
  status             ENUM('active','needs_reconnect') NOT NULL DEFAULT 'active',
  last_error         VARCHAR(255) NULL,
  connected_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_mail_account (organization_id, user_id),
  CONSTRAINT fk_mailacc_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT fk_mailacc_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- The one-time "Connect" slip: proves the person coming back from Google/Microsoft
-- is the one who clicked Connect (state + PKCE). Lives 10 minutes, used once.
CREATE TABLE IF NOT EXISTS mail_oauth_states (
  id               BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  state_hash       CHAR(64) NOT NULL,
  organization_id  BIGINT UNSIGNED NOT NULL,
  user_id          BIGINT UNSIGNED NOT NULL,
  provider         ENUM('google','microsoft') NOT NULL,
  code_verifier    VARCHAR(128) NOT NULL,
  with_inbox       TINYINT(1) NOT NULL DEFAULT 0,
  expires_at       DATETIME NOT NULL,
  used_at          DATETIME NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_mail_state (state_hash),
  CONSTRAINT fk_mailstate_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Every email sent from Workard (the record). Linked to a customer / employee / invoice if any.
-- Seen ONLY by the sender and by Workard users it was sent to (to, cc, or their own bcc).
CREATE TABLE IF NOT EXISTS sent_emails (
  id                   BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  organization_id      BIGINT UNSIGNED NOT NULL,
  sender_user_id       BIGINT UNSIGNED NOT NULL,
  mail_account_id      BIGINT UNSIGNED NULL,
  provider             ENUM('google','microsoft') NOT NULL,
  from_email           VARCHAR(190) NOT NULL,
  from_name            VARCHAR(150) NULL,
  subject              VARCHAR(300) NOT NULL,
  body_html            MEDIUMTEXT NOT NULL,
  body_text            TEXT NULL,
  customer_id          BIGINT UNSIGNED NULL,
  employee_id          BIGINT UNSIGNED NULL,
  invoice_id           BIGINT UNSIGNED NULL,
  kind                 ENUM('new','reply','reply_all','forward') NOT NULL DEFAULT 'new',
  provider_message_id  VARCHAR(255) NULL,
  provider_thread_id   VARCHAR(255) NULL,
  status               ENUM('sending','sent','failed') NOT NULL DEFAULT 'sending',
  error                VARCHAR(500) NULL,
  request_id           VARCHAR(64) NULL,
  created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sent_at              DATETIME NULL,
  UNIQUE KEY uq_sent_email_request (organization_id, request_id),
  KEY idx_sent_sender (organization_id, sender_user_id, created_at),
  KEY idx_sent_customer (organization_id, customer_id),
  KEY idx_sent_employee (organization_id, employee_id),
  KEY idx_sent_invoice (organization_id, invoice_id),
  CONSTRAINT fk_sent_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT fk_sent_account FOREIGN KEY (mail_account_id) REFERENCES mail_accounts(id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- Who an email went to. user_id = a Workard user in that company (decides who can see it).
CREATE TABLE IF NOT EXISTS sent_email_recipients (
  id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  email_id     BIGINT UNSIGNED NOT NULL,
  kind         ENUM('to','cc','bcc') NOT NULL,
  email        VARCHAR(190) NOT NULL,
  name         VARCHAR(150) NULL,
  user_id      BIGINT UNSIGNED NULL,
  customer_id  BIGINT UNSIGNED NULL,
  employee_id  BIGINT UNSIGNED NULL,
  KEY idx_rcpt_email (email_id),
  KEY idx_rcpt_user (user_id),
  KEY idx_rcpt_customer (customer_id),
  KEY idx_rcpt_employee (employee_id),
  CONSTRAINT fk_rcpt_email FOREIGN KEY (email_id) REFERENCES sent_emails(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Files sent with an email (max 3 MB per email); a copy is kept so the record can show them.
CREATE TABLE IF NOT EXISTS sent_email_attachments (
  id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  email_id     BIGINT UNSIGNED NOT NULL,
  file_name    VARCHAR(255) NOT NULL,
  mime_type    VARCHAR(120) NULL,
  size_bytes   INT UNSIGNED NOT NULL,
  file_url     MEDIUMTEXT NULL,
  public_id    VARCHAR(255) NULL,
  CONSTRAINT fk_att_email FOREIGN KEY (email_id) REFERENCES sent_emails(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Saved emails ("Payment reminder") with gaps like {customer name}. Personal or shared.
CREATE TABLE IF NOT EXISTS email_templates (
  id               BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  organization_id  BIGINT UNSIGNED NOT NULL,
  created_by       BIGINT UNSIGNED NOT NULL,
  name             VARCHAR(120) NOT NULL,
  subject          VARCHAR(300) NOT NULL,
  body_html        MEDIUMTEXT NOT NULL,
  is_shared        TINYINT(1) NOT NULL DEFAULT 0,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_tpl_org (organization_id),
  CONSTRAINT fk_tpl_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
) ENGINE=InnoDB;
