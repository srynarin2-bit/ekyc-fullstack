import { AuditLogEntry, KycSession, SubmitKycPayload } from "../types/kyc";

const rawApiUrl = process.env.EXPO_PUBLIC_API_URL ?? "http://192.168.1.42:4000";
export const API_BASE_URL = rawApiUrl.replace(/\/+$/, "");

async function requestWithTimeout<T>(path: string, init?: RequestInit, timeoutMs = 15_000): Promise<T> {
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
      const message = typeof data?.error === "string" ? data.error : `HTTP ${response.status}`;
      throw new Error(message);
    }
    return data as T;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Request timed out calling ${API_BASE_URL}${path}. Check Wi-Fi and PC firewall.`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export function checkHealth(): Promise<{ status: string; database: string }> {
  return requestWithTimeout("/health");
}

export function createKycSession(userId: string): Promise<{ session: KycSession }> {
  return requestWithTimeout("/api/kyc/sessions", {
    method: "POST",
    body: JSON.stringify({ userId }),
  });
}

export function submitKycVerification(
  sessionId: string,
  payload: SubmitKycPayload
): Promise<{ session: KycSession }> {
  return requestWithTimeout(`/api/kyc/sessions/${sessionId}/submit`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function getKycSessionDetails(
  sessionId: string
): Promise<{ session: KycSession; auditLogs: AuditLogEntry[] }> {
  return requestWithTimeout(`/api/kyc/sessions/${sessionId}`);
}