export type KycStatus = "PENDING" | "APPROVED" | "REJECTED" | "MANUAL_REVIEW";

export interface EvaluationInput {
  expiryDate: string; // YYYY-MM-DD
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

export function evaluateKyc(input: EvaluationInput): EvaluationResult {
  const todayIso = new Date().toISOString().slice(0, 10);

  if (input.expiryDate < todayIso) {
    return {
      status: "REJECTED",
      riskScore: 95,
      reason: "Document expiry date has passed",
    };
  }

  if (!input.livenessPassed || input.livenessScore < 0.5) {
    return {
      status: "REJECTED",
      riskScore: 90,
      reason: "Liveness check failed",
    };
  }

  const clamp01 = (n: number) => Math.min(Math.max(n, 0), 1);
  const ocrWeakness = 1 - clamp01(input.ocrConfidence);
  const faceWeakness = 1 - clamp01(input.faceMatchScore);
  const liveWeakness = 1 - clamp01(input.livenessScore);

  const riskScore = Number(
    ((ocrWeakness * 0.35 + faceWeakness * 0.45 + liveWeakness * 0.2) * 100).toFixed(2)
  );

  if (
    input.ocrConfidence >= 0.85 &&
    input.livenessScore >= 0.8 &&
    input.faceMatchScore >= 0.85
  ) {
    return {
      status: "APPROVED",
      riskScore,
      reason: "All document and biometric thresholds satisfied",
    };
  }

  return {
    status: "MANUAL_REVIEW",
    riskScore,
    reason: "Scores require secondary/manual review",
  };
}