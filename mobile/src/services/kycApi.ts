import * as FileSystem from "expo-file-system/legacy";
import {
  AuditLogEntry,
  BankCurrency,
  BiometricsResult,
  DocType,
  ExtractedOcrResponse,
  KycSession,
  OpenedBankAccount,
  RegisteredUser,
} from "../types/kyc";

const rawApiUrl = process.env.EXPO_PUBLIC_API_URL ?? "http://192.168.1.15:4000";
export const API_BASE_URL = rawApiUrl.replace(/\/+$/, "");

async function fetchJsonWithTimeout<T>(
  path: string,
  init?: RequestInit,
  timeoutMs = 30_000
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
      signal: controller.signal,
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(typeof data?.error === "string" ? data.error : `Request failed (${response.status})`);
    }
    return data as T;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Request timed out calling ${API_BASE_URL}${path}. Check Wi-Fi/hotspot and PC IP.`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function uploadSingleFileWithTimeout<T>(
  path: string,
  fileUri: string,
  fieldName: string,
  parameters?: Record<string, string>,
  timeoutMs = 90_000
): Promise<T> {
  const uploadTask = FileSystem.createUploadTask(
    `${API_BASE_URL}${path}`,
    fileUri,
    {
      httpMethod: "POST",
      uploadType: FileSystem.FileSystemUploadType.MULTIPART,
      fieldName,
      mimeType: "image/jpeg",
      ...(parameters ? { parameters } : {}),
    }
  );

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    uploadTask.cancelAsync().catch(() => {});
  }, timeoutMs);

  try {
    const result = await uploadTask.uploadAsync();
    if (timedOut) {
      throw new Error(`Upload timed out after ${timeoutMs / 1000}s. Move closer to Wi-Fi/hotspot and retry.`);
    }
    if (!result) {
      throw new Error(`Upload canceled before reaching ${API_BASE_URL}${path}.`);
    }

    const parsed = JSON.parse(result.body || "{}");
    if (result.status < 200 || result.status >= 300) {
      throw new Error(typeof parsed?.error === "string" ? parsed.error : `Upload failed (${result.status})`);
    }
    return parsed as T;
  } finally {
    clearTimeout(timer);
  }
}

export function createKycSession(userId: string): Promise<{ session: KycSession }> {
  return fetchJsonWithTimeout("/api/kyc/sessions", {
    method: "POST",
    body: JSON.stringify({ userId }),
  });
}

export function uploadIdForOcr(
  sessionId: string,
  docType: DocType,
  imageUri: string
): Promise<ExtractedOcrResponse> {
  return uploadSingleFileWithTimeout<ExtractedOcrResponse>(
    `/api/kyc/sessions/${sessionId}/ocr-scan`,
    imageUri,
    "idImage",
    { docType },
    90_000
  );
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
): Promise<{ session: KycSession; biometrics: BiometricsResult }> {
  const neutralRes = await uploadSingleFileWithTimeout<{ storageKey: string }>(
    `/api/kyc/sessions/${sessionId}/upload-selfie`,
    neutralUri,
    "selfieImage",
    undefined,
    60_000
  );

  const challengeRes = await uploadSingleFileWithTimeout<{ storageKey: string }>(
    `/api/kyc/sessions/${sessionId}/upload-selfie`,
    challengeUri,
    "selfieImage",
    undefined,
    60_000
  );

  return fetchJsonWithTimeout<{ session: KycSession; biometrics: BiometricsResult }>(
    `/api/kyc/sessions/${sessionId}/liveness-verify-json`,
    {
      method: "POST",
      body: JSON.stringify({
        ...metadata,
        neutralStorageKey: neutralRes.storageKey,
        challengeStorageKey: challengeRes.storageKey,
      }),
    },
    45_000
  );
}

export function getKycSessionDetails(
  sessionId: string
): Promise<{ session: KycSession; auditLogs: AuditLogEntry[] }> {
  return fetchJsonWithTimeout(`/api/kyc/sessions/${sessionId}`);
}

export function registerVerifiedAccount(payload: {
  kycSessionId: string;
  email: string;
  password: string;
}): Promise<{ message: string; user: RegisteredUser }> {
  return fetchJsonWithTimeout("/api/auth/register", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function openBankAccount(payload: {
  userId: string;
  kycSessionId: string;
  currency: BankCurrency;
}): Promise<{ message: string; account: OpenedBankAccount }> {
  return fetchJsonWithTimeout("/api/bank/accounts/open", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}