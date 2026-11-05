-- ============================================================
-- Changes to tables that ALREADY exist on a live database.
-- schema.sql only creates missing tables (CREATE TABLE IF NOT EXISTS), so a new
-- value in an existing ENUM has to be added here. npm run db:init runs this
-- file after schema.sql. Every statement is safe to run again and again.
-- ============================================================

-- Sales: customers can be marked as a lost deal
ALTER TABLE customers MODIFY stage ENUM('lead','prospect','customer','lost','inactive') NOT NULL DEFAULT 'lead';

-- Plans: new organisations start on a free trial
ALTER TABLE subscriptions MODIFY status ENUM('pending_payment','trial','active') NOT NULL DEFAULT 'trial';
