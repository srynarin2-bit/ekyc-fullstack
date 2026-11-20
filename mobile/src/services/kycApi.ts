import {
  AuditLogEntry,
  DocType,
  ExtractedOcrResponse,
  KycSession,
  RegisteredUser,
} from "../types/kyc";

const rawApiUrl = process.env.EXPO_PUBLIC_API_URL ?? "http://10.154.242.124:4000";
export const API_BASE_URL = rawApiUrl.replace(/\/+$/, "");

async function fetchWithTimeout<T>(path: string, init?: RequestInit, timeoutMs = 30_000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      signal: controller.signal,
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(typeof data?.error === "string" ? data.error : `HTTP ${response.status}`);
    }
    return data as T;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Network timeout calling ${API_BASE_URL}${path}. Check Wi-Fi connection.`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export function createKycSession(userId: string): Promise<{ session: KycSession }> {
  return fetchWithTimeout("/api/kyc/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId }),
  });
}

export function uploadIdForOcr(
  sessionId: string,
  docType: DocType,
  imageUri: string
): Promise<ExtractedOcrResponse> {
  const formData = new FormData();
  formData.append("docType", docType);
  formData.append("idImage", {
    uri: imageUri,
    name: "id-document.jpg",
    type: "image/jpeg",
  } as any);

  return fetchWithTimeout(`/api/kyc/sessions/${sessionId}/ocr-scan`, {
    method: "POST",
    body: formData,
  });
}

export function verifyLivenessAndSubmit(
  sessionId: string,
  neutralUri: string,
  challengeUri: string,
  metadata: {
    docType: DocType;
    storageKey: string;
    fullName: string;
    docNumber: string;
    dateOfBirth: string;
    expiryDate: string;
    ocrConfidence: number;
  }
): Promise<{
  session: KycSession;
  biometrics: { livenessPassed: boolean; livenessScore: number; faceMatchScore: number; notes: string };
}> {
  const formData = new FormData();
  formData.append("neutralSelfie", {
    uri: neutralUri,
    name: "neutral-selfie.jpg",
    type: "image/jpeg",
  } as any);
  formData.append("challengeSelfie", {
    uri: challengeUri,
    name: "challenge-selfie.jpg",
    type: "image/jpeg",
  } as any);

  formData.append("docType", metadata.docType);
  formData.append("storageKey", metadata.storageKey);
  formData.append("fullName", metadata.fullName);
  formData.append("docNumber", metadata.docNumber);
  formData.append("dateOfBirth", metadata.dateOfBirth);
  formData.append("expiryDate", metadata.expiryDate);
  formData.append("ocrConfidence", String(metadata.ocrConfidence));

  return fetchWithTimeout(`/api/kyc/sessions/${sessionId}/liveness-verify`, {
    method: "POST",
    body: formData,
  });
}

export function getKycSessionDetails(
  sessionId: string
): Promise<{ session: KycSession; auditLogs: AuditLogEntry[] }> {
  return fetchWithTimeout(`/api/kyc/sessions/${sessionId}`);
}

export function registerVerifiedAccount(payload: {
  kycSessionId: string;
  email: string;
  password: string;
}): Promise<{ message: string; user: RegisteredUser }> {
  return fetchWithTimeout("/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}