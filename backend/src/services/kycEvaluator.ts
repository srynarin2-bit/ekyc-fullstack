export type KycStatus = "PENDING" | "APPROVED" | "REJECTED" | "MANUAL_REVIEW";

export interface EvaluationInput {
  docNumber?: string;
  fullName?: string;
  dateOfBirth?: string; // YYYY-MM-DD
  expiryDate?: string;  // YYYY-MM-DD
  ocrConfidence: number; // 0.0 to 1.0
  livenessPassed: boolean;
  livenessScore: number; // 0.0 to 1.0
  faceMatchScore: number; // 0.0 to 1.0
}

export interface EvaluationResult {
  status: KycStatus;
  riskScore: number;
  reason: string;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function evaluateKyc(input: EvaluationInput): EvaluationResult {
  const todayIso = new Date().toISOString().slice(0, 10);

  if (
    !input.docNumber ||
    input.docNumber.trim().length < 6 ||
    input.docNumber.startsWith("UNREADABLE") ||
    !input.fullName ||
    input.fullName.trim().length < 3 ||
    input.fullName.startsWith("UNREADABLE")
  ) {
    return {
      status: "REJECTED",
      riskScore: 98,
      reason: "Identity document number or holder name could not be verified",
    };
  }

  if (
    !input.dateOfBirth ||
    !ISO_DATE_RE.test(input.dateOfBirth) ||
    !input.expiryDate ||
    !ISO_DATE_RE.test(input.expiryDate)
  ) {
    return {
      status: "MANUAL_REVIEW",
      riskScore: 78,
      reason: "Date of birth or expiry date missing/unformatted; manual review required",
    };
  }

  if (input.dateOfBirth >= todayIso) {
    return {
      status: "REJECTED",
      riskScore: 96,
      reason: "Date of birth is invalid",
    };
  }

  if (input.expiryDate < todayIso) {
    return {
      status: "REJECTED",
      riskScore: 95,
      reason: `Identity document expired on ${input.expiryDate}`,
    };
  }

  if (!input.livenessPassed || input.livenessScore < 0.6) {
    return {
      status: "REJECTED",
      riskScore: 92,
      reason: "Active liveness check failed",
    };
  }

  const clamp01 = (n: number) => Math.min(Math.max(n, 0), 1);
  const ocrWeakness = 1 - clamp01(input.ocrConfidence);
  const faceWeakness = 1 - clamp01(input.faceMatchScore);
  const livenessWeakness = 1 - clamp01(input.livenessScore);

  const riskScore = Number(
    ((ocrWeakness * 0.25 + faceWeakness * 0.55 + livenessWeakness * 0.2) * 100).toFixed(2)
  );

  if (
    input.ocrConfidence >= 0.72 &&
    input.livenessScore >= 0.8 &&
    input.faceMatchScore >= 0.72
  ) {
    return {
      status: "APPROVED",
      riskScore,
      reason: "Document details, active liveness, and portrait similarity verified",
    };
  }

  return {
    status: "MANUAL_REVIEW",
    riskScore,
    reason: "OCR confidence or face match score below auto-approval threshold",
  };
}