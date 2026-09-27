#!/bin/sh
# Runs once, when the database is first created: the owner role (migrations) and the
# restricted app role (row-level security applies to it), each with its own password.
set -e
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<SQL
CREATE ROLE onpar_owner LOGIN PASSWORD '${ONPAR_OWNER_PASSWORD}';
CREATE ROLE onpar_app LOGIN PASSWORD '${ONPAR_APP_PASSWORD}';
CREATE DATABASE onpar OWNER onpar_owner;
SQL
