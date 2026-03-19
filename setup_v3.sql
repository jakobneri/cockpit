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
-- This function dynamically creates a table for each client and inserts the data.
CREATE OR REPLACE FUNCTION report_client_metrics(payload jsonb)
RETURNS jsonb AS $$
DECLARE
    v_hostname TEXT;
    v_table_name TEXT;
    v_stats JSONB;
    v_system_info JSONB;
BEGIN
    v_hostname := payload->>'hostname';
    v_stats := payload->'stats';
    v_system_info := payload->'systemInfo';
    
    -- Sanitize hostname to use as table name (replace non-alphanumeric with underscores)
    v_table_name := 'metrics_' || regexp_replace(lower(v_hostname), '[^a-z0-9]', '_', 'g');
    
    -- Create the client-specific table if it doesn't exist
    EXECUTE format('CREATE TABLE IF NOT EXISTS %I (
        id SERIAL PRIMARY KEY,
        timestamp TIMESTAMPTZ DEFAULT NOW(),
        data JSONB
    )', v_table_name);
    
    -- Insert the new metrics
    EXECUTE format('INSERT INTO %I (data) VALUES (%L)', v_table_name, v_stats);
    
    -- Update the clients registry
    INSERT INTO clients (hostname, last_seen, system_info) 
    VALUES (v_hostname, NOW(), v_system_info)
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
