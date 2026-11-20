import React, { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import {
  API_BASE_URL,
  checkHealth,
  createKycSession,
  getKycSessionDetails,
  submitKycVerification,
} from "../services/kycApi";
import { AuditLogEntry, DocType, KycSession } from "../types/kyc";

const DOC_TYPES: DocType[] = ["NATIONAL_ID", "PASSPORT", "DRIVER_LICENSE"];

export function KycScreen() {
  const [userId, setUserId] = useState("usr_mobile_001");
  const [docType, setDocType] = useState<DocType>("PASSPORT");
  const [fullName, setFullName] = useState("Sothea Chan");
  const [docNumber, setDocNumber] = useState("N0987654");
  const [dateOfBirth, setDateOfBirth] = useState("1996-05-18");
  const [expiryDate, setExpiryDate] = useState("2031-12-31");
  const [storageKey, setStorageKey] = useState("kyc-uploads/usr_mobile_001/id-and-selfie.jpg");

  const [ocrConfidence, setOcrConfidence] = useState("0.94");
  const [livenessPassed, setLivenessPassed] = useState(true);
  const [livenessScore, setLivenessScore] = useState("0.92");
  const [faceMatchScore, setFaceMatchScore] = useState("0.90");

  const [session, setSession] = useState<KycSession | null>(null);
  const [auditLogs, setAuditLogs] = useState<AuditLogEntry[]>([]);
  const [loading, setLoading] = useState(false);

  const handleTestConnection = async () => {
    setLoading(true);
    try {
      const health = await checkHealth();
      Alert.alert("Backend Reachable", `Status: ${health.status} | DB: ${health.database}`);
    } catch (err) {
      Alert.alert("Connection Failed", err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  };

  const handleCreateAndSubmit = async () => {
    const parsedOcr = Number(ocrConfidence);
    const parsedLiveness = Number(livenessScore);
    const parsedFaceMatch = Number(faceMatchScore);

    if (
      Number.isNaN(parsedOcr) ||
      Number.isNaN(parsedLiveness) ||
      Number.isNaN(parsedFaceMatch)
    ) {
      Alert.alert("Invalid Scores", "OCR, liveness, and face match scores must be numbers between 0 and 1.");
      return;
    }

    setLoading(true);
    try {
      const created = await createKycSession(userId.trim());
      const activeSessionId = created.session.id;

      const submitted = await submitKycVerification(activeSessionId, {
        docType,
        storageKey: storageKey.trim(),
        document: {
          fullName: fullName.trim(),
          docNumber: docNumber.trim(),
          dateOfBirth: dateOfBirth.trim(),
          expiryDate: expiryDate.trim(),
          ocrConfidence: parsedOcr,
        },
        biometrics: {
          livenessPassed,
          livenessScore: parsedLiveness,
          faceMatchScore: parsedFaceMatch,
        },
      });

      const details = await getKycSessionDetails(activeSessionId);
      setSession(submitted.session);
      setAuditLogs(details.auditLogs);
    } catch (err) {
      Alert.alert("eKYC Error", err instanceof Error ? err.message : "Failed to submit eKYC");
    } finally {
      setLoading(false);
    }
  };

  const handleRefresh = async () => {
    if (!session) return;
    setLoading(true);
    try {
      const details = await getKycSessionDetails(session.id);
      setSession(details.session);
      setAuditLogs(details.auditLogs);
    } catch (err) {
      Alert.alert("Refresh Error", err instanceof Error ? err.message : "Failed to refresh");
    } finally {
      setLoading(false);
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>Full-Stack eKYC (Expo + Postgres)</Text>
      <Text style={styles.apiBanner}>Target API: {API_BASE_URL}</Text>

      <TouchableOpacity style={styles.secondaryBtn} onPress={handleTestConnection} disabled={loading}>
        <Text style={styles.secondaryBtnText}>Test Backend & DB Connection</Text>
      </TouchableOpacity>

      <Text style={styles.label}>User ID</Text>
      <TextInput style={styles.input} value={userId} onChangeText={setUserId} autoCapitalize="none" />

      <Text style={styles.label}>Document Type</Text>
      <View style={styles.row}>
        {DOC_TYPES.map((item) => {
          const active = docType === item;
          return (
            <TouchableOpacity
              key={item}
              style={[styles.chip, active && styles.chipActive]}
              onPress={() => setDocType(item)}
            >
              <Text style={[styles.chipText, active && styles.chipTextActive]}>{item}</Text>
            </TouchableOpacity>
          );
        })}
      </View>

      <Text style={styles.label}>Full Name</Text>
      <TextInput style={styles.input} value={fullName} onChangeText={setFullName} />

      <Text style={styles.label}>Document Number</Text>
      <TextInput style={styles.input} value={docNumber} onChangeText={setDocNumber} />

      <Text style={styles.label}>Date of Birth (YYYY-MM-DD)</Text>
      <TextInput style={styles.input} value={dateOfBirth} onChangeText={setDateOfBirth} />

      <Text style={styles.label}>Expiry Date (YYYY-MM-DD)</Text>
      <TextInput style={styles.input} value={expiryDate} onChangeText={setExpiryDate} />

      <Text style={styles.label}>Storage Reference Key</Text>
      <TextInput
        style={styles.input}
        value={storageKey}
        onChangeText={setStorageKey}
        autoCapitalize="none"
      />

      <Text style={styles.label}>OCR Confidence (0.0 - 1.0)</Text>
      <TextInput
        style={styles.input}
        value={ocrConfidence}
        onChangeText={setOcrConfidence}
        keyboardType="decimal-pad"
      />

      <View style={styles.switchRow}>
        <Text style={styles.label}>Liveness Passed</Text>
        <Switch value={livenessPassed} onValueChange={setLivenessPassed} />
      </View>

      <Text style={styles.label}>Liveness Score (0.0 - 1.0)</Text>
      <TextInput
        style={styles.input}
        value={livenessScore}
        onChangeText={setLivenessScore}
        keyboardType="decimal-pad"
      />

      <Text style={styles.label}>Face Match Score (0.0 - 1.0)</Text>
      <TextInput
        style={styles.input}
        value={faceMatchScore}
        onChangeText={setFaceMatchScore}
        keyboardType="decimal-pad"
      />

      <TouchableOpacity style={styles.primaryBtn} onPress={handleCreateAndSubmit} disabled={loading}>
        {loading ? (
          <ActivityIndicator color="#ffffff" />
        ) : (
          <Text style={styles.primaryBtnText}>Create Session & Submit eKYC</Text>
        )}
      </TouchableOpacity>

      {session && (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>PostgreSQL Session Result</Text>
          <Text style={styles.meta}>Session ID: {session.id}</Text>
          <Text style={styles.status}>Status: {session.status}</Text>
          <Text style={styles.meta}>Risk Score: {session.risk_score ?? "N/A"}</Text>
          <Text style={styles.meta}>Reason: {session.decision_reason ?? "N/A"}</Text>

          <TouchableOpacity style={styles.secondaryBtn} onPress={handleRefresh} disabled={loading}>
            <Text style={styles.secondaryBtnText}>Refresh Status & Audit Logs</Text>
          </TouchableOpacity>

          <Text style={styles.subHeading}>Audit Trail ({auditLogs.length})</Text>
          {auditLogs.map((log) => (
            <Text key={log.id} style={styles.logItem}>
              • {log.event_type} ({log.actor}) — {new Date(log.created_at).toLocaleTimeString()}
            </Text>
          ))}
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 20, paddingBottom: 48, backgroundColor: "#f8fafc" },
  title: { fontSize: 22, fontWeight: "700", color: "#0f172a", marginBottom: 4 },
  apiBanner: { fontSize: 12, color: "#334155", marginBottom: 14 },
  label: { fontSize: 13, fontWeight: "600", color: "#1e293b", marginTop: 10, marginBottom: 4 },
  input: {
    backgroundColor: "#ffffff",
    borderWidth: 1,
    borderColor: "#cbd5e1",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    color: "#0f172a",
  },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 4 },
  chip: {
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#94a3b8",
    backgroundColor: "#ffffff",
  },
  chipActive: { backgroundColor: "#0f172a", borderColor: "#0f172a" },
  chipText: { fontSize: 12, fontWeight: "600", color: "#0f172a" },
  chipTextActive: { color: "#ffffff" },
  switchRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 12,
  },
  primaryBtn: {
    marginTop: 20,
    backgroundColor: "#2563eb",
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: "center",
  },
  primaryBtnText: { color: "#ffffff", fontWeight: "700", fontSize: 15 },
  secondaryBtn: {
    marginTop: 8,
    backgroundColor: "#e2e8f0",
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 8,
    alignItems: "center",
  },
  secondaryBtnText: { color: "#0f172a", fontWeight: "600", fontSize: 13 },
  card: {
    marginTop: 22,
    backgroundColor: "#ffffff",
    borderRadius: 10,
    padding: 14,
    borderWidth: 1,
    borderColor: "#cbd5e1",
  },
  cardTitle: { fontSize: 16, fontWeight: "700", color: "#0f172a", marginBottom: 6 },
  status: { fontSize: 15, fontWeight: "700", color: "#1d4ed8", marginVertical: 4 },
  meta: { fontSize: 13, color: "#334155", marginBottom: 2 },
  subHeading: { fontSize: 14, fontWeight: "700", color: "#0f172a", marginTop: 12, marginBottom: 4 },
  logItem: { fontSize: 12, color: "#475569", marginBottom: 2 },
});