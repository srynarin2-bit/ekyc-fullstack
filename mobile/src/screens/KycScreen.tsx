import { CameraView, useCameraPermissions } from "expo-camera";
import * as ImageManipulator from "expo-image-manipulator";
import React, { useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import {
  API_BASE_URL,
  createKycSession,
  getKycSessionDetails,
  openBankAccount,
  registerVerifiedAccount,
  uploadIdForOcr,
  verifyLivenessAndSubmit,
} from "../services/kycApi";
import {
  AuditLogEntry,
  BankCurrency,
  BiometricsResult,
  DocType,
  KycSession,
  OpenedBankAccount,
  RegisteredUser,
} from "../types/kyc";

const DOC_TYPES: DocType[] = ["NATIONAL_ID", "PASSPORT", "DRIVER_LICENSE"];
const CURRENCIES: BankCurrency[] = ["USD", "KHR"];

async function prepareImage(uri: string, width: number, compress: number): Promise<string> {
  const manipulated = await ImageManipulator.manipulateAsync(
    uri,
    [{ resize: { width } }],
    { compress, format: ImageManipulator.SaveFormat.JPEG }
  );
  return manipulated.uri;
}

export function KycScreen() {
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef<CameraView | null>(null);

  // Document & OCR state
  const [docType, setDocType] = useState<DocType>("NATIONAL_ID");
  const [session, setSession] = useState<KycSession | null>(null);
  const [idPhotoUri, setIdPhotoUri] = useState<string | null>(null);
  const [storageKey, setStorageKey] = useState<string>("");
  const [fullName, setFullName] = useState<string>("");
  const [docNumber, setDocNumber] = useState<string>("");
  const [nationality, setNationality] = useState<string>("KHM");
  const [dateOfBirth, setDateOfBirth] = useState<string>("");
  const [expiryDate, setExpiryDate] = useState<string>("");
  const [ocrConfidence, setOcrConfidence] = useState<number>(0);
  const [mrzValid, setMrzValid] = useState<boolean>(false);
  const [ocrIssues, setOcrIssues] = useState<string[]>([]);

  // Liveness camera state
  const [captureMode, setCaptureMode] = useState<"NONE" | "ID_CAM" | "LIVENESS_CAM">("NONE");
  const [neutralSelfieUri, setNeutralSelfieUri] = useState<string | null>(null);
  const [biometrics, setBiometrics] = useState<BiometricsResult | null>(null);
  const [auditLogs, setAuditLogs] = useState<AuditLogEntry[]>([]);

  // Account & Bank onboarding state
  const [email, setEmail] = useState<string>("");
  const [password, setPassword] = useState<string>("");
  const [registeredUser, setRegisteredUser] = useState<RegisteredUser | null>(null);
  const [currency, setCurrency] = useState<BankCurrency>("USD");
  const [bankAccount, setBankAccount] = useState<OpenedBankAccount | null>(null);

  const [busy, setBusy] = useState<boolean>(false);
  const [statusMessage, setStatusMessage] = useState<string>("");

  const openCamera = async (mode: "ID_CAM" | "LIVENESS_CAM") => {
    if (busy) return;
    if (!permission?.granted) {
      const granted = await requestPermission();
      if (!granted.granted) {
        Alert.alert("Camera Required", "Allow camera permission in Android settings to scan ID and face.");
        return;
      }
    }
    if (mode === "LIVENESS_CAM") {
      setNeutralSelfieUri(null);
    }
    setCaptureMode(mode);
  };

  const handleCaptureId = async () => {
    if (!cameraRef.current || busy) return;
    setBusy(true);
    setStatusMessage("Capturing ID photo & running OCR...");

    try {
      const rawPhoto = await cameraRef.current.takePictureAsync({
        quality: 0.85,
        skipProcessing: false,
      });
      if (!rawPhoto?.uri) throw new Error("Camera returned no image URI");

      // High enough resolution for crisp MRZ & ID numbers without huge file size
      const sharpUri = await prepareImage(rawPhoto.uri, 1400, 0.82);
      setIdPhotoUri(sharpUri);
      setCaptureMode("NONE");

      let activeSession = session;
      if (!activeSession) {
        const created = await createKycSession(`user_${Date.now()}`);
        activeSession = created.session;
        setSession(activeSession);
      }

      const res = await uploadIdForOcr(activeSession.id, docType, sharpUri);
      setStorageKey(res.storageKey);
      setFullName(res.extracted.fullName);
      setDocNumber(res.extracted.docNumber);
      setNationality(res.extracted.nationality);
      setDateOfBirth(res.extracted.dateOfBirth);
      setExpiryDate(res.extracted.expiryDate);
      setOcrConfidence(res.extracted.ocrConfidence);
      setMrzValid(res.extracted.mrzCheckValid);
      setOcrIssues(res.extracted.validationIssues);

      const issuesText =
        res.extracted.validationIssues.length > 0
          ? `\nWarnings: ${res.extracted.validationIssues.join(", ")}`
          : "";

      Alert.alert(
        "OCR Scan Finished",
        `Name: ${res.extracted.fullName}\nID #: ${res.extracted.docNumber}\nConfidence: ${(
          res.extracted.ocrConfidence * 100
        ).toFixed(1)}%${issuesText}`
      );
    } catch (err) {
      setCaptureMode("NONE");
      Alert.alert("ID Scan Error", err instanceof Error ? err.message : "Failed to scan ID");
    } finally {
      setBusy(false);
      setStatusMessage("");
    }
  };

  const handleCaptureSelfieFrame = async () => {
    if (!cameraRef.current || !session || busy) return;
    setBusy(true);

    try {
      const rawSelfie = await cameraRef.current.takePictureAsync({
        quality: 0.78,
        skipProcessing: false,
      });
      if (!rawSelfie?.uri) throw new Error("Camera returned no selfie URI");

      const compressedSelfie = await prepareImage(rawSelfie.uri, 720, 0.72);

      if (!neutralSelfieUri) {
        setNeutralSelfieUri(compressedSelfie);
        Alert.alert(
          "Pose 1/2 Saved",
          "Now turn your head slightly to the right or smile, then tap Capture Challenge Pose."
        );
      } else {
        setCaptureMode("NONE");
        setStatusMessage("Verifying 2-frame liveness & portrait match...");

        const result = await verifyLivenessAndSubmit(session.id, neutralSelfieUri, compressedSelfie, {
          docType,
          storageKey,
          fullName: fullName.trim(),
          docNumber: docNumber.trim(),
          dateOfBirth: dateOfBirth.trim(),
          expiryDate: expiryDate.trim(),
          ocrConfidence,
        });

        setSession(result.session);
        setBiometrics(result.biometrics);

        const details = await getKycSessionDetails(session.id);
        setAuditLogs(details.auditLogs);
      }
    } catch (err) {
      setCaptureMode("NONE");
      Alert.alert("Liveness Error", err instanceof Error ? err.message : "Liveness verification failed");
    } finally {
      setBusy(false);
      setStatusMessage("");
    }
  };

  const handleRegister = async () => {
    if (!session || session.status !== "APPROVED" || busy) return;
    setBusy(true);
    setStatusMessage("Registering verified user...");

    try {
      const res = await registerVerifiedAccount({
        kycSessionId: session.id,
        email: email.trim(),
        password,
      });
      setRegisteredUser(res.user);
      const details = await getKycSessionDetails(session.id);
      setAuditLogs(details.auditLogs);
      Alert.alert("Account Created", `Verified user ${res.user.full_name} saved in PostgreSQL.`);
    } catch (err) {
      Alert.alert("Registration Failed", err instanceof Error ? err.message : "Unable to register");
    } finally {
      setBusy(false);
      setStatusMessage("");
    }
  };

  const handleOpenBankAccount = async () => {
    if (!session || !registeredUser || busy) return;
    setBusy(true);
    setStatusMessage("Opening bank account...");

    try {
      const res = await openBankAccount({
        userId: registeredUser.id,
        kycSessionId: session.id,
        currency,
      });
      setBankAccount(res.account);
      const details = await getKycSessionDetails(session.id);
      setAuditLogs(details.auditLogs);
      Alert.alert("Bank Account Opened", `Account #: ${res.account.account_number} (${res.account.currency})`);
    } catch (err) {
      Alert.alert("Bank Account Error", err instanceof Error ? err.message : "Could not open account");
    } finally {
      setBusy(false);
      setStatusMessage("");
    }
  };

  if (captureMode !== "NONE") {
    const isIdCam = captureMode === "ID_CAM";
    return (
      <View style={styles.cameraRoot}>
        <CameraView ref={cameraRef} style={styles.camera} facing={isIdCam ? "back" : "front"} />
        <View style={styles.cameraOverlay}>
          <Text style={styles.guideBanner}>
            {isIdCam
              ? `Keep entire ${docType} & bottom MRZ sharp inside frame`
              : !neutralSelfieUri
              ? "Liveness 1/2: Face forward in good light"
              : "Liveness 2/2: Move/turn head slightly & smile"}
          </Text>

          <View style={isIdCam ? styles.idBox : styles.faceOval} />

          <View style={styles.camButtonRow}>
            <TouchableOpacity
              style={styles.camCancel}
              onPress={() => setCaptureMode("NONE")}
              disabled={busy}
            >
              <Text style={styles.camBtnText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.camSnap}
              onPress={isIdCam ? handleCaptureId : handleCaptureSelfieFrame}
              disabled={busy}
            >
              {busy ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.camBtnText}>
                  {isIdCam
                    ? "Snap ID & Scan OCR"
                    : !neutralSelfieUri
                    ? "Capture Neutral Face"
                    : "Capture Challenge Pose"}
                </Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </View>
    );
  }

  const isApproved = session?.status === "APPROVED";

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>eKYC & Bank Onboarding</Text>
      <Text style={styles.subText}>API: {API_BASE_URL}</Text>
      {statusMessage !== "" && (
        <View style={styles.progressBox}>
          <ActivityIndicator size="small" color="#1d4ed8" />
          <Text style={styles.progressText}>{statusMessage}</Text>
        </View>
      )}

      {/* Step 1: ID / Passport Scan */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>1. National ID / Passport OCR Scan</Text>
        <View style={styles.row}>
          {DOC_TYPES.map((t) => (
            <TouchableOpacity
              key={t}
              style={[styles.chip, docType === t && styles.chipActive]}
              onPress={() => setDocType(t)}
              disabled={busy}
            >
              <Text style={[styles.chipText, docType === t && styles.chipTextActive]}>{t}</Text>
            </TouchableOpacity>
          ))}
        </View>

        <TouchableOpacity style={styles.btnPrimary} onPress={() => openCamera("ID_CAM")} disabled={busy}>
          <Text style={styles.btnPrimaryText}>
            {idPhotoUri ? "Re-Scan ID / Passport" : "Scan ID / Passport with Camera"}
          </Text>
        </TouchableOpacity>

        {idPhotoUri && <Image source={{ uri: idPhotoUri }} style={styles.preview} />}

        {storageKey !== "" && (
          <View style={{ marginTop: 8 }}>
            <Text style={styles.meta}>
              Dynamic OCR Confidence: {(ocrConfidence * 100).toFixed(1)}% | MRZ Check:{" "}
              {mrzValid ? "PASSED" : "CHECK"} | Nat: {nationality}
            </Text>
            {ocrIssues.map((issue, idx) => (
              <Text key={idx} style={styles.warnText}>
                ! {issue}
              </Text>
            ))}

            <Text style={styles.label}>Full Name</Text>
            <TextInput style={styles.input} value={fullName} onChangeText={setFullName} />

            <Text style={styles.label}>Document Number</Text>
            <TextInput style={styles.input} value={docNumber} onChangeText={setDocNumber} />

            <Text style={styles.label}>Date of Birth (YYYY-MM-DD)</Text>
            <TextInput style={styles.input} value={dateOfBirth} onChangeText={setDateOfBirth} />

            <Text style={styles.label}>Expiry Date (YYYY-MM-DD)</Text>
            <TextInput style={styles.input} value={expiryDate} onChangeText={setExpiryDate} />
          </View>
        )}
      </View>

      {/* Step 2: Face Liveness Verification */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>2. Live Face Liveness & ID Match</Text>
        <TouchableOpacity
          style={[styles.btnPrimary, (!storageKey || busy) && styles.btnDisabled]}
          disabled={!storageKey || busy}
          onPress={() => openCamera("LIVENESS_CAM")}
        >
          <Text style={styles.btnPrimaryText}>Start 2-Pose Liveness Check</Text>
        </TouchableOpacity>

        {session && (
          <View style={styles.infoBox}>
            <Text style={styles.statusHighlight}>Status: {session.status}</Text>
            <Text style={styles.meta}>Session: {session.id}</Text>
            <Text style={styles.meta}>Risk Score: {session.risk_score ?? "N/A"}</Text>
            <Text style={styles.meta}>Reason: {session.decision_reason ?? "Pending"}</Text>
            {biometrics && (
              <Text style={styles.meta}>
                Liveness: {(biometrics.livenessScore * 100).toFixed(1)}% | Match:{" "}
                {(biometrics.faceMatchScore * 100).toFixed(1)}% ({biometrics.notes})
              </Text>
            )}
          </View>
        )}
      </View>

      {/* Step 3 & 4: Account Registration + Bank Account Opening */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>3. Account & Bank Account Onboarding</Text>
        {!isApproved ? (
          <Text style={styles.warnText}>
            Blocked until eKYC status is APPROVED. Mismatched faces, low match scores, or invalid IDs cannot open an account.
          </Text>
        ) : !registeredUser ? (
          <>
            <Text style={styles.label}>Email</Text>
            <TextInput
              style={styles.input}
              value={email}
              onChangeText={setEmail}
              autoCapitalize="none"
              keyboardType="email-address"
              placeholder="name@example.com"
            />
            <Text style={styles.label}>Password (8+ chars)</Text>
            <TextInput
              style={styles.input}
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              placeholder="********"
            />
            <TouchableOpacity style={styles.btnPrimary} onPress={handleRegister} disabled={busy}>
              <Text style={styles.btnPrimaryText}>Register Verified User</Text>
            </TouchableOpacity>
          </>
        ) : (
          <View style={styles.infoBox}>
            <Text style={styles.statusHighlight}>Registered User: {registeredUser.full_name}</Text>
            <Text style={styles.meta}>Email: {registeredUser.email}</Text>

            <Text style={styles.label}>Select Bank Account Currency</Text>
            <View style={styles.row}>
              {CURRENCIES.map((c) => (
                <TouchableOpacity
                  key={c}
                  style={[styles.chip, currency === c && styles.chipActive]}
                  onPress={() => setCurrency(c)}
                  disabled={busy}
                >
                  <Text style={[styles.chipText, currency === c && styles.chipTextActive]}>{c}</Text>
                </TouchableOpacity>
              ))}
            </View>

            {!bankAccount ? (
              <TouchableOpacity style={styles.btnPrimary} onPress={handleOpenBankAccount} disabled={busy}>
                <Text style={styles.btnPrimaryText}>Open {currency} Bank Account</Text>
              </TouchableOpacity>
            ) : (
              <View style={styles.bankBox}>
                <Text style={styles.statusHighlight}>Account Number: {bankAccount.account_number}</Text>
                <Text style={styles.meta}>
                  Currency: {bankAccount.currency} | Balance: {bankAccount.balance} | Status:{" "}
                  {bankAccount.status}
                </Text>
              </View>
            )}
          </View>
        )}

        {auditLogs.length > 0 && (
          <View style={{ marginTop: 12 }}>
            <Text style={styles.label}>PostgreSQL Audit Logs ({auditLogs.length})</Text>
            {auditLogs.map((log) => (
              <Text key={log.id} style={styles.logLine}>
                • {log.event_type} ({log.actor})
              </Text>
            ))}
          </View>
        )}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 16, paddingBottom: 48, backgroundColor: "#f8fafc" },
  title: { fontSize: 22, fontWeight: "700", color: "#0f172a" },
  subText: { fontSize: 12, color: "#475569", marginBottom: 10 },
  progressBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "#dbeafe",
    padding: 10,
    borderRadius: 8,
    marginBottom: 12,
  },
  progressText: { fontSize: 13, color: "#1e3a8a", fontWeight: "600" },
  card: {
    backgroundColor: "#ffffff",
    borderRadius: 12,
    padding: 14,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: "#cbd5e1",
  },
  cardTitle: { fontSize: 16, fontWeight: "700", color: "#0f172a", marginBottom: 8 },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 8 },
  chip: {
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#94a3b8",
  },
  chipActive: { backgroundColor: "#0f172a", borderColor: "#0f172a" },
  chipText: { fontSize: 12, fontWeight: "600", color: "#0f172a" },
  chipTextActive: { color: "#ffffff" },
  label: { fontSize: 13, fontWeight: "600", color: "#1e293b", marginTop: 10, marginBottom: 4 },
  input: {
    backgroundColor: "#f8fafc",
    borderWidth: 1,
    borderColor: "#cbd5e1",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 9,
    fontSize: 14,
    color: "#0f172a",
  },
  btnPrimary: {
    marginTop: 10,
    backgroundColor: "#2563eb",
    paddingVertical: 13,
    borderRadius: 10,
    alignItems: "center",
  },
  btnDisabled: { backgroundColor: "#94a3b8" },
  btnPrimaryText: { color: "#ffffff", fontWeight: "700", fontSize: 14 },
  preview: { width: "100%", height: 175, borderRadius: 8, marginTop: 10, resizeMode: "cover" },
  meta: { fontSize: 12, color: "#334155", marginTop: 3 },
  warnText: { fontSize: 12, color: "#b91c1c", fontWeight: "600", marginTop: 3 },
  infoBox: {
    marginTop: 12,
    padding: 10,
    borderRadius: 8,
    backgroundColor: "#f1f5f9",
    borderWidth: 1,
    borderColor: "#cbd5e1",
  },
  bankBox: {
    marginTop: 10,
    padding: 10,
    borderRadius: 8,
    backgroundColor: "#ecfdf5",
    borderWidth: 1,
    borderColor: "#86efac",
  },
  statusHighlight: { fontSize: 14, fontWeight: "700", color: "#0f172a" },
  logLine: { fontSize: 12, color: "#475569", marginTop: 2 },
  cameraRoot: { flex: 1, backgroundColor: "#000" },
  camera: { flex: 1 },
  cameraOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 44,
    paddingHorizontal: 18,
  },
  guideBanner: {
    color: "#fff",
    fontSize: 15,
    fontWeight: "700",
    textAlign: "center",
    backgroundColor: "rgba(0,0,0,0.65)",
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
  },
  idBox: {
    width: "94%",
    height: 215,
    borderWidth: 3,
    borderColor: "#38bdf8",
    borderRadius: 14,
  },
  faceOval: {
    width: 230,
    height: 300,
    borderWidth: 3,
    borderColor: "#4ade80",
    borderRadius: 150,
  },
  camButtonRow: { flexDirection: "row", gap: 12, width: "100%" },
  camCancel: {
    flex: 1,
    backgroundColor: "rgba(255,255,255,0.22)",
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: "center",
  },
  camSnap: {
    flex: 2,
    backgroundColor: "#16a34a",
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: "center",
  },
  camBtnText: { color: "#fff", fontWeight: "700", fontSize: 14 },
});