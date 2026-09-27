-- One-time local database setup. Run as a PostgreSQL superuser:
--   psql -U postgres -f scripts/db-setup.sql
-- Development passwords only. Production uses secrets from the host.
CREATE ROLE onpar_owner LOGIN PASSWORD 'onpar_owner_dev';
CREATE ROLE onpar_app LOGIN PASSWORD 'onpar_app_dev';
CREATE DATABASE onpar OWNER onpar_owner;
CREATE DATABASE onpar_test OWNER onpar_owner;
CREATE DATABASE onpar_restore_test OWNER onpar_owner;
