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

export interface AuditLogEntry {
  id: number;
  session_id: string;
  event_type: string;
  actor: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface SubmitKycPayload {
  docType: DocType;
  storageKey: string;
  document: {
    fullName: string;
    docNumber: string;
    dateOfBirth: string;
    expiryDate: string;
    ocrConfidence: number;
  };
  biometrics: {
    livenessPassed: boolean;
    livenessScore: number;
    faceMatchScore: number;
  };
}