export type KycStatus = "PENDING" | "APPROVED" | "REJECTED" | "MANUAL_REVIEW";

export interface EvaluationInput {
  expiryDate: string; // YYYY-MM-DD
  ocrConfidence: number; // 0.0 to 1.0
  livenessPassed: boolean;
  livenessScore: number; // 0.0 to 1.0
  faceMatchScore: number; // 0.0 to 1.0
  docNumber?: string;
  fullName?: string;
}

export interface EvaluationResult {
  status: KycStatus;
  riskScore: number;
  reason: string;
}

export function evaluateKyc(input: EvaluationInput): EvaluationResult {
  const todayIso = new Date().toISOString().slice(0, 10);

  if (
    !input.docNumber ||
    input.docNumber.startsWith("UNREADABLE") ||
    !input.fullName ||
    input.fullName.startsWith("UNREADABLE")
  ) {
    return {
      status: "REJECTED",
      riskScore: 98,
      reason: "National ID / Passport details could not be verified from OCR",
    };
  }

  if (input.expiryDate < todayIso) {
    return {
      status: "REJECTED",
      riskScore: 95,
      reason: "Identity document is expired",
    };
  }

  if (!input.livenessPassed || input.livenessScore < 0.6) {
    return {
      status: "REJECTED",
      riskScore: 92,
      reason: "Liveness check failed",
    };
  }

  const clamp01 = (n: number) => Math.min(Math.max(n, 0), 1);
  const ocrWeakness = 1 - clamp01(input.ocrConfidence);
  const faceWeakness = 1 - clamp01(input.faceMatchScore);
  const livenessWeakness = 1 - clamp01(input.livenessScore);

  const riskScore = Number(
    ((ocrWeakness * 0.3 + faceWeakness * 0.5 + livenessWeakness * 0.2) * 100).toFixed(2)
  );

  // Strict match threshold: both OCR confidence and face match must clear 0.85
  if (
    input.ocrConfidence >= 0.85 &&
    input.livenessScore >= 0.8 &&
    input.faceMatchScore >= 0.85
  ) {
    return {
      status: "APPROVED",
      riskScore,
      reason: "Document data and face match verified",
    };
  }

  return {
    status: "MANUAL_REVIEW",
    riskScore,
    reason: "ID data or face match score below approval threshold; registration blocked",
  };
}