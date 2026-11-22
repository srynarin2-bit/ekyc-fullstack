export type DocType = "NATIONAL_ID" | "PASSPORT" | "DRIVER_LICENSE";
export type KycStatus = "PENDING" | "APPROVED" | "REJECTED" | "MANUAL_REVIEW";
export type BankCurrency = "USD" | "KHR";

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
    khmerName?: string;
    fullName: string;
    docNumber: string;
    nationality: string;
    dateOfBirth: string;
    expiryDate: string;
    mrzCheckValid: boolean;
    ocrConfidence: number;
    isValidData: boolean;
    validationIssues: string[];
  };
}

export interface BiometricsResult {
  livenessPassed: boolean;
  livenessScore: number;
  faceMatchScore: number;
  notes: string;
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

export interface OpenedBankAccount {
  id: string;
  user_id: string;
  kyc_session_id: string;
  account_number: string;
  currency: BankCurrency;
  balance: string;
  status: string;
  created_at: string;
}