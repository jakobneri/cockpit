-- Cockpit V3 Database Setup
-- This script prepares the PostgreSQL database for PostgREST integration.

-- 1. Create the clients registry
CREATE TABLE IF NOT EXISTS clients (
    id SERIAL PRIMARY KEY,
    hostname TEXT UNIQUE NOT NULL,
    last_seen TIMESTAMPTZ DEFAULT NOW(),
    system_info JSONB,
    latest_metrics JSONB
);

-- 2. Drop ALL old overloads of the function
DROP FUNCTION IF EXISTS report_client_metrics(jsonb);
DROP FUNCTION IF EXISTS report_client_metrics(text, jsonb, jsonb, timestamptz);
DROP FUNCTION IF EXISTS report_client_metrics(text, jsonb, jsonb);

-- 3. Create the RPC function (single JSONB parameter)
-- PostgREST will pass the entire request body as one object via Prefer: params=single-object
CREATE OR REPLACE FUNCTION report_client_metrics(payload JSONB)
RETURNS jsonb AS $$
DECLARE
    v_hostname TEXT;
    v_table_name TEXT;
    v_stats JSONB;
    v_system_info JSONB;
BEGIN
    v_hostname := payload->>'hostname';
    v_stats := payload->'stats';
    v_system_info := payload->'system_info';

    -- Sanitize hostname to use as table name
    v_table_name := 'metrics_' || regexp_replace(lower(v_hostname), '[^a-z0-9]', '_', 'g');

    -- Create the client-specific table if it doesn't exist
    EXECUTE format('CREATE TABLE IF NOT EXISTS %I (
        id SERIAL PRIMARY KEY,
        recorded_at TIMESTAMPTZ DEFAULT NOW(),
        data JSONB
    )', v_table_name);

    -- Insert the new metrics
    EXECUTE format('INSERT INTO %I (data) VALUES (%L)', v_table_name, v_stats);

    -- Update the clients registry
    INSERT INTO clients (hostname, last_seen, system_info, latest_metrics)
    VALUES (v_hostname, NOW(), v_system_info, v_stats)
    ON CONFLICT (hostname) DO UPDATE
    SET last_seen = NOW(), 
        system_info = EXCLUDED.system_info,
        latest_metrics = EXCLUDED.latest_metrics;

    RETURN jsonb_build_object('success', true, 'table', v_table_name);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 4. Compatibility Adapter for V3.3.0 Clients (Shotgun Fix)
-- This allows OLD code to work with the NEW database logic.
CREATE OR REPLACE FUNCTION report_client_metrics(
    hostname TEXT,
    stats JSONB,
    system_info JSONB,
    reported_at TIMESTAMPTZ DEFAULT NOW()
) RETURNS jsonb AS $$
BEGIN
    RETURN report_client_metrics(jsonb_build_object(
        'hostname', hostname,
        'stats', stats,
        'system_info', system_info,
        'reported_at', reported_at
    ));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 5. Create a view to list all metrics tables
CREATE OR REPLACE VIEW fleet_tables AS
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
AND table_name LIKE 'metrics_%';

-- 5. Permissions
GRANT ALL ON TABLE clients TO cockpit_user;
GRANT ALL ON FUNCTION report_client_metrics(jsonb) TO cockpit_user;
GRANT ALL ON FUNCTION report_client_metrics(text, jsonb, jsonb, timestamptz) TO cockpit_user;
GRANT ALL ON fleet_tables TO cockpit_user;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO cockpit_user;

-- 6. Force PostgREST to reload the schema cache
NOTIFY pgrst, 'reload schema';
