-- Cockpit V3 Database Setup
-- This script prepares the PostgreSQL database for PostgREST integration.

-- 1. Create the clients registry
CREATE TABLE IF NOT EXISTS clients (
    id SERIAL PRIMARY KEY,
    hostname TEXT UNIQUE NOT NULL,
    last_seen TIMESTAMPTZ DEFAULT NOW(),
    system_info JSONB
);

-- 2. Create the RPC function for reporting metrics
CREATE OR REPLACE FUNCTION report_client_metrics(
    hostname TEXT,
    stats JSONB,
    systemInfo JSONB,
    reported_at TIMESTAMPTZ DEFAULT NOW()
)
RETURNS jsonb AS $$
DECLARE
    v_table_name TEXT;
BEGIN
    -- Sanitize hostname to use as table name
    v_table_name := 'metrics_' || regexp_replace(lower(hostname), '[^a-z0-9]', '_', 'g');
    
    -- Create the client-specific table if it doesn't exist
    EXECUTE format('CREATE TABLE IF NOT EXISTS %I (
        id SERIAL PRIMARY KEY,
        timestamp TIMESTAMPTZ DEFAULT NOW(),
        data JSONB
    )', v_table_name);
    
    -- Insert the new metrics
    EXECUTE format('INSERT INTO %I (data, timestamp) VALUES (%L, %L)', v_table_name, stats, reported_at);
    
    -- Update the clients registry
    INSERT INTO clients (hostname, last_seen, system_info) 
    VALUES (hostname, NOW(), systemInfo)
    ON CONFLICT (hostname) DO UPDATE 
    SET last_seen = NOW(), system_info = EXCLUDED.system_info;
    
    RETURN jsonb_build_object('success', true, 'table', v_table_name);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 3. Create a view to list all metrics tables (useful for the Hub)
CREATE OR REPLACE VIEW fleet_tables AS
SELECT table_name 
FROM information_schema.tables 
WHERE table_schema = 'public' 
AND table_name LIKE 'metrics_%';

-- 4. Set up permissions for the PostgREST role
GRANT ALL ON TABLE clients TO cockpit_user;
GRANT ALL ON FUNCTION report_client_metrics(jsonb) TO cockpit_user;
GRANT ALL ON fleet_tables TO cockpit_user;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO cockpit_user;

-- 5. Force PostgREST to reload the schema cache
NOTIFY pgrst, 'reload schema';
