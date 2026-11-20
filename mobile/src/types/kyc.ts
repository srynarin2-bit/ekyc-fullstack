export type DocType = "NATIONAL_ID" | "PASSPORT" | "DRIVER_LICENSE";
export type KycStatus = "PENDING" | "APPROVED" | "REJECTED" | "MANUAL_REVIEW";

export interface KycSession {
  id: string;
  user_id: string;
  status: KycStatus;
  risk_score: string | null;
  decision_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface ExtractedOcrResponse {
  storageKey: string;
  extracted: {
    rawText: string;
    fullName: string;
    docNumber: string;
    dateOfBirth: string;
    expiryDate: string;
    ocrConfidence: number;
  };
}

export interface AuditLogEntry {
  id: number;
  session_id: string;
  event_type: string;
  actor: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface RegisteredUser {
  id: string;
  kyc_session_id: string;
  email: string;
  full_name: string;
  doc_number: string;
  created_at: string;
}