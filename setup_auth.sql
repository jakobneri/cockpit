-- Cockpit Auth Migration — hub_users table
-- Run once against the cockpit database, same as setup_v3.sql:
--
--   psql -U cockpit_user -d cockpit -f setup_auth.sql
--
-- The hub server calls POST/PATCH/DELETE /hub_users via PostgREST.
-- Passwords are NEVER stored in plaintext:
--   client  →  SHA-256(raw_password)           (WebCrypto, never leaves browser)
--   server  →  bcrypt( sha256_hex )             (bcryptjs, cost 12)
--   stored  →  bcrypt hash in password_hash col
--
-- TOTP secrets are the standard base32 TOTP seed (RFC 6238).

CREATE TABLE IF NOT EXISTS hub_users (
  id            SERIAL PRIMARY KEY,
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,       -- bcrypt( sha256(plain) ), cost 12
  role          TEXT NOT NULL DEFAULT 'viewer'
                CHECK (role IN ('admin', 'operator', 'viewer')),
  totp_secret   TEXT,                -- NULL until 2FA is set up
  totp_enabled  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- PostgREST reads/writes hub_users on behalf of the hub server.
-- cockpit_user is the PostgREST db-uri user (see docker-compose).
GRANT ALL ON TABLE hub_users              TO cockpit_user;
GRANT USAGE, SELECT ON SEQUENCE hub_users_id_seq TO cockpit_user;

-- Reload PostgREST schema cache so it picks up the new table immediately.
NOTIFY pgrst, 'reload schema';
