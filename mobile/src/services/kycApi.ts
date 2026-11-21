import * as FileSystem from "expo-file-system/legacy";
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

export async function uploadIdForOcr(
  sessionId: string,
  docType: DocType,
  imageUri: string
): Promise<ExtractedOcrResponse> {
  const result = await FileSystem.uploadAsync(
    `${API_BASE_URL}/api/kyc/sessions/${sessionId}/ocr-scan`,
    imageUri,
    {
      httpMethod: "POST",
      uploadType: FileSystem.FileSystemUploadType.MULTIPART,
      fieldName: "idImage",
      mimeType: "image/jpeg",
      parameters: { docType },
    }
  );

  const data = JSON.parse(result.body || "{}");
  if (result.status < 200 || result.status >= 300) {
    throw new Error(typeof data?.error === "string" ? data.error : `Upload failed (${result.status})`);
  }
  return data as ExtractedOcrResponse;
}

export async function verifyLivenessAndSubmit(
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
  // Upload Frame 1 (neutral selfie) using native multipart upload
  const neutralUpload = await FileSystem.uploadAsync(
    `${API_BASE_URL}/api/kyc/sessions/${sessionId}/upload-selfie`,
    neutralUri,
    {
      httpMethod: "POST",
      uploadType: FileSystem.FileSystemUploadType.MULTIPART,
      fieldName: "selfieImage",
      mimeType: "image/jpeg",
    }
  );
  const neutralData = JSON.parse(neutralUpload.body || "{}");
  if (neutralUpload.status < 200 || neutralUpload.status >= 300) {
    throw new Error(neutralData?.error || "Failed to upload neutral selfie");
  }

  // Upload Frame 2 (challenge selfie) using native multipart upload
  const challengeUpload = await FileSystem.uploadAsync(
    `${API_BASE_URL}/api/kyc/sessions/${sessionId}/upload-selfie`,
    challengeUri,
    {
      httpMethod: "POST",
      uploadType: FileSystem.FileSystemUploadType.MULTIPART,
      fieldName: "selfieImage",
      mimeType: "image/jpeg",
    }
  );
  const challengeData = JSON.parse(challengeUpload.body || "{}");
  if (challengeUpload.status < 200 || challengeUpload.status >= 300) {
    throw new Error(challengeData?.error || "Failed to upload challenge selfie");
  }

  // Submit JSON paths + metadata to run liveness & save to PostgreSQL
  return fetchWithTimeout(`/api/kyc/sessions/${sessionId}/liveness-verify-json`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...metadata,
      neutralStorageKey: neutralData.storageKey,
      challengeStorageKey: challengeData.storageKey,
    }),
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