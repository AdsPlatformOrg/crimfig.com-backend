-- CrimFig PostgreSQL init script
-- Creates additional databases for future microservices

-- Auth DB is the default (created by POSTGRES_DB env var)
-- Future: separate DBs per service for isolation
SELECT 'CrimFig PostgreSQL initialized' AS status;
