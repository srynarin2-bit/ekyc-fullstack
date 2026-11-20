CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS kyc_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id VARCHAR(128) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'PENDING',
  risk_score NUMERIC(5, 2),
  decision_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS kyc_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES kyc_sessions(id) ON DELETE CASCADE,
  doc_type VARCHAR(32) NOT NULL,
  storage_key TEXT NOT NULL,
  full_name TEXT NOT NULL,
  doc_number VARCHAR(128) NOT NULL,
  date_of_birth DATE NOT NULL,
  expiry_date DATE NOT NULL,
  ocr_confidence NUMERIC(5, 4) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS kyc_biometric_checks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES kyc_sessions(id) ON DELETE CASCADE,
  liveness_passed BOOLEAN NOT NULL,
  liveness_score NUMERIC(5, 4) NOT NULL,
  face_match_score NUMERIC(5, 4) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS kyc_audit_logs (
  id BIGSERIAL PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES kyc_sessions(id) ON DELETE CASCADE,
  event_type VARCHAR(64) NOT NULL,
  actor VARCHAR(128) NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kyc_session_id UUID UNIQUE NOT NULL REFERENCES kyc_sessions(id),
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  full_name TEXT NOT NULL,
  doc_number VARCHAR(128) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kyc_sessions_user_id ON kyc_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_kyc_documents_session_id ON kyc_documents(session_id);
CREATE INDEX IF NOT EXISTS idx_kyc_biometrics_session_id ON kyc_biometric_checks(session_id);
CREATE INDEX IF NOT EXISTS idx_kyc_audit_logs_session_id ON kyc_audit_logs(session_id);