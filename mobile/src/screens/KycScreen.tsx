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
  registerVerifiedAccount,
  uploadIdForOcr,
  verifyLivenessAndSubmit,
} from "../services/kycApi";
import { AuditLogEntry, DocType, KycSession, RegisteredUser } from "../types/kyc";

const DOC_TYPES: DocType[] = ["NATIONAL_ID", "PASSPORT", "DRIVER_LICENSE"];

async function compressPhoto(uri: string, targetWidth = 1000): Promise<string> {
  const result = await ImageManipulator.manipulateAsync(
    uri,
    [{ resize: { width: targetWidth } }],
    { compress: 0.72, format: ImageManipulator.SaveFormat.JPEG }
  );
  return result.uri;
}

export function KycScreen() {
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef<CameraView | null>(null);

  // Step 1: Document Capture & OCR
  const [docType, setDocType] = useState<DocType>("NATIONAL_ID");
  const [session, setSession] = useState<KycSession | null>(null);
  const [idPhotoUri, setIdPhotoUri] = useState<string | null>(null);
  const [storageKey, setStorageKey] = useState<string>("");
  const [fullName, setFullName] = useState("");
  const [docNumber, setDocNumber] = useState("");
  const [dateOfBirth, setDateOfBirth] = useState("1996-05-18");
  const [expiryDate, setExpiryDate] = useState("2031-12-31");
  const [ocrConfidence, setOcrConfidence] = useState<number>(0);

  // Step 2: 2-Frame Active Liveness Capture
  const [captureMode, setCaptureMode] = useState<"NONE" | "ID_CAM" | "LIVENESS_CAM">("NONE");
  const [neutralSelfieUri, setNeutralSelfieUri] = useState<string | null>(null);
  const [challengeSelfieUri, setChallengeSelfieUri] = useState<string | null>(null);
  const [livenessNotes, setLivenessNotes] = useState<string>("");
  const [auditLogs, setAuditLogs] = useState<AuditLogEntry[]>([]);

  // Step 3: Account Registration (Unlocked only when session.status === 'APPROVED')
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [registeredUser, setRegisteredUser] = useState<RegisteredUser | null>(null);
  const [loading, setLoading] = useState(false);

  const openCamera = async (mode: "ID_CAM" | "LIVENESS_CAM") => {
    if (!permission?.granted) {
      const res = await requestPermission();
      if (!res.granted) {
        Alert.alert("Permission Required", "Camera permission is required to scan your ID and selfie.");
        return;
      }
    }
    setCaptureMode(mode);
  };

  const handleCaptureIdAndOcr = async () => {
    if (!cameraRef.current) return;
    setLoading(true);
    try {
      const photo = await cameraRef.current.takePictureAsync({ quality: 0.8 });
      if (!photo?.uri) throw new Error("Failed to capture ID photo");

      const compressedUri = await compressPhoto(photo.uri, 1100);
      setIdPhotoUri(compressedUri);
      setCaptureMode("NONE");

      // Create session if not started yet
      let activeSession = session;
      if (!activeSession) {
        const created = await createKycSession(`applicant_${Date.now()}`);
        activeSession = created.session;
        setSession(activeSession);
      }

      // Send compressed ID photo to backend Tesseract OCR
      const ocrRes = await uploadIdForOcr(activeSession.id, docType, compressedUri);
      setStorageKey(ocrRes.storageKey);
      setFullName(ocrRes.extracted.fullName);
      setDocNumber(ocrRes.extracted.docNumber);
      setDateOfBirth(ocrRes.extracted.dateOfBirth);
      setExpiryDate(ocrRes.extracted.expiryDate);
      setOcrConfidence(ocrRes.extracted.ocrConfidence);

      Alert.alert(
        "OCR Extraction Complete",
        `Name: ${ocrRes.extracted.fullName}\nID #: ${ocrRes.extracted.docNumber}\nConfidence: ${(
          ocrRes.extracted.ocrConfidence * 100
        ).toFixed(0)}%`
      );
    } catch (err) {
      Alert.alert("ID Scan Error", err instanceof Error ? err.message : "OCR failed");
    } finally {
      setLoading(false);
    }
  };

  const handleCaptureLivenessFrame = async () => {
    if (!cameraRef.current || !session) return;
    setLoading(true);
    try {
      const photo = await cameraRef.current.takePictureAsync({ quality: 0.75 });
      if (!photo?.uri) throw new Error("Failed to capture selfie");

      const compressedUri = await compressPhoto(photo.uri, 720);

      if (!neutralSelfieUri) {
        setNeutralSelfieUri(compressedUri);
        Alert.alert(
          "Step 1 of 2 Captured",
          "Now turn your head slightly to the right and smile, then tap Capture Challenge Pose."
        );
      } else {
        setChallengeSelfieUri(compressedUri);
        setCaptureMode("NONE");

        const result = await verifyLivenessAndSubmit(session.id, neutralSelfieUri, compressedUri, {
          docType,
          storageKey,
          fullName: fullName.trim(),
          docNumber: docNumber.trim(),
          dateOfBirth: dateOfBirth.trim(),
          expiryDate: expiryDate.trim(),
          ocrConfidence: ocrConfidence || 0.9,
        });

        setSession(result.session);
        setLivenessNotes(result.biometrics.notes);

        const details = await getKycSessionDetails(session.id);
        setAuditLogs(details.auditLogs);
      }
    } catch (err) {
      Alert.alert("Liveness Error", err instanceof Error ? err.message : "Liveness check failed");
    } finally {
      setLoading(false);
    }
  };

  const handleRegisterAccount = async () => {
    if (!session || session.status !== "APPROVED") {
      Alert.alert("eKYC Required", "Your National ID/Passport and liveness check must be APPROVED first.");
      return;
    }

    setLoading(true);
    try {
      const res = await registerVerifiedAccount({
        kycSessionId: session.id,
        email: email.trim(),
        password,
      });
      setRegisteredUser(res.user);
      const details = await getKycSessionDetails(session.id);
      setAuditLogs(details.auditLogs);
      Alert.alert("Registration Complete", `Welcome ${res.user.full_name}! Account stored in PostgreSQL.`);
    } catch (err) {
      Alert.alert("Registration Blocked", err instanceof Error ? err.message : "Registration failed");
    } finally {
      setLoading(false);
    }
  };

  if (captureMode !== "NONE") {
    const isIdCam = captureMode === "ID_CAM";
    return (
      <View style={styles.cameraContainer}>
        <CameraView ref={cameraRef} style={styles.camera} facing={isIdCam ? "back" : "front"} />
        <View style={styles.overlayBox}>
          <Text style={styles.overlayTitle}>
            {isIdCam
              ? `Align your ${docType} clearly inside the frame`
              : !neutralSelfieUri
              ? "Liveness 1/2: Look straight at the camera"
              : "Liveness 2/2: Turn head slightly right & smile"}
          </Text>
          <View style={isIdCam ? styles.idFrameGuide : styles.faceOvalGuide} />
          <View style={styles.camActions}>
            <TouchableOpacity
              style={styles.cancelBtn}
              onPress={() => setCaptureMode("NONE")}
              disabled={loading}
            >
              <Text style={styles.cancelBtnText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.captureBtn}
              onPress={isIdCam ? handleCaptureIdAndOcr : handleCaptureLivenessFrame}
              disabled={loading}
            >
              {loading ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.captureBtnText}>
                  {isIdCam
                    ? "Snap ID & Run OCR"
                    : !neutralSelfieUri
                    ? "Capture Neutral Face"
                    : "Capture Challenge & Verify"}
                </Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>Real Camera eKYC & Account Gate</Text>
      <Text style={styles.apiBanner}>Backend: {API_BASE_URL}</Text>

      {/* STAGE 1: Document Selection + Camera OCR */}
      <View style={styles.card}>
        <Text style={styles.stepTitle}>Step 1: Scan National ID or Passport (OCR)</Text>
        <View style={styles.row}>
          {DOC_TYPES.map((item) => (
            <TouchableOpacity
              key={item}
              style={[styles.chip, docType === item && styles.chipActive]}
              onPress={() => setDocType(item)}
            >
              <Text style={[styles.chipText, docType === item && styles.chipTextActive]}>{item}</Text>
            </TouchableOpacity>
          ))}
        </View>

        <TouchableOpacity style={styles.primaryBtn} onPress={() => openCamera("ID_CAM")} disabled={loading}>
          <Text style={styles.primaryBtnText}>
            {idPhotoUri ? "Re-Scan ID / Passport with Camera" : "Open Camera to Scan ID / Passport"}
          </Text>
        </TouchableOpacity>

        {idPhotoUri && <Image source={{ uri: idPhotoUri }} style={styles.previewImg} />}

        {storageKey !== "" && (
          <>
            <Text style={styles.label}>Extracted Full Name (Verify/Edit)</Text>
            <TextInput style={styles.input} value={fullName} onChangeText={setFullName} />

            <Text style={styles.label}>Extracted Document Number</Text>
            <TextInput style={styles.input} value={docNumber} onChangeText={setDocNumber} />

            <Text style={styles.label}>Date of Birth (YYYY-MM-DD)</Text>
            <TextInput style={styles.input} value={dateOfBirth} onChangeText={setDateOfBirth} />

            <Text style={styles.label}>Expiry Date (YYYY-MM-DD)</Text>
            <TextInput style={styles.input} value={expiryDate} onChangeText={setExpiryDate} />

            <Text style={styles.meta}>OCR Confidence: {(ocrConfidence * 100).toFixed(1)}%</Text>
          </>
        )}
      </View>

      {/* STAGE 2: Live Face Liveness Challenge */}
      <View style={styles.card}>
        <Text style={styles.stepTitle}>Step 2: Real-Time Face Liveness Check</Text>
        <Text style={styles.meta}>
          Captures 2 sequential front-camera poses (neutral + head turn) and validates liveness in PostgreSQL.
        </Text>

        <TouchableOpacity
          style={[styles.primaryBtn, !storageKey && styles.disabledBtn]}
          disabled={!storageKey || loading}
          onPress={() => {
            setNeutralSelfieUri(null);
            setChallengeSelfieUri(null);
            openCamera("LIVENESS_CAM");
          }}
        >
          <Text style={styles.primaryBtnText}>Start Live Face Liveness Camera</Text>
        </TouchableOpacity>

        {session && (
          <View style={styles.resultBox}>
            <Text style={styles.statusText}>eKYC Status: {session.status}</Text>
            <Text style={styles.meta}>Session ID: {session.id}</Text>
            <Text style={styles.meta}>Risk Score: {session.risk_score ?? "Pending"}</Text>
            {livenessNotes !== "" && <Text style={styles.meta}>{livenessNotes}</Text>}
          </View>
        )}
      </View>

      {/* STAGE 3: Gated Account Registration */}
      <View style={styles.card}>
        <Text style={styles.stepTitle}>Step 3: Create System Account (Unlocked After Approval)</Text>
        {session?.status !== "APPROVED" ? (
          <Text style={styles.lockedText}>
            Account registration is locked until your National ID/Passport and Face Liveness are APPROVED.
          </Text>
        ) : registeredUser ? (
          <View style={styles.resultBox}>
            <Text style={styles.statusText}>Account Registered!</Text>
            <Text style={styles.meta}>User DB ID: {registeredUser.id}</Text>
            <Text style={styles.meta}>Email: {registeredUser.email}</Text>
            <Text style={styles.meta}>Verified Name: {registeredUser.full_name}</Text>
            <Text style={styles.meta}>Verified ID #: {registeredUser.doc_number}</Text>
          </View>
        ) : (
          <>
            <Text style={styles.label}>Email Address</Text>
            <TextInput
              style={styles.input}
              value={email}
              onChangeText={setEmail}
              autoCapitalize="none"
              keyboardType="email-address"
              placeholder="you@example.com"
            />
            <Text style={styles.label}>Password (min 8 chars)</Text>
            <TextInput
              style={styles.input}
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              placeholder="********"
            />
            <TouchableOpacity style={styles.primaryBtn} onPress={handleRegisterAccount} disabled={loading}>
              {loading ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.primaryBtnText}>Register Verified Account</Text>
              )}
            </TouchableOpacity>
          </>
        )}

        {auditLogs.length > 0 && (
          <View style={{ marginTop: 14 }}>
            <Text style={styles.label}>PostgreSQL Audit Trail ({auditLogs.length} events)</Text>
            {auditLogs.map((log) => (
              <Text key={log.id} style={styles.logItem}>
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
  container: { padding: 18, paddingBottom: 48, backgroundColor: "#f8fafc" },
  title: { fontSize: 21, fontWeight: "700", color: "#0f172a" },
  apiBanner: { fontSize: 12, color: "#475569", marginBottom: 12 },
  card: {
    backgroundColor: "#ffffff",
    borderRadius: 12,
    padding: 14,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: "#cbd5e1",
  },
  stepTitle: { fontSize: 16, fontWeight: "700", color: "#0f172a", marginBottom: 8 },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 10 },
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
  primaryBtn: {
    marginTop: 12,
    backgroundColor: "#2563eb",
    paddingVertical: 13,
    borderRadius: 10,
    alignItems: "center",
  },
  disabledBtn: { backgroundColor: "#94a3b8" },
  primaryBtnText: { color: "#ffffff", fontWeight: "700", fontSize: 14 },
  previewImg: { width: "100%", height: 170, borderRadius: 8, marginTop: 12, resizeMode: "cover" },
  meta: { fontSize: 12, color: "#334155", marginTop: 4 },
  resultBox: {
    marginTop: 12,
    padding: 10,
    borderRadius: 8,
    backgroundColor: "#eff6ff",
    borderWidth: 1,
    borderColor: "#bfdbfe",
  },
  statusText: { fontSize: 15, fontWeight: "700", color: "#1d4ed8" },
  lockedText: { fontSize: 13, color: "#b91c1c", fontWeight: "500" },
  logItem: { fontSize: 12, color: "#475569", marginTop: 2 },
  cameraContainer: { flex: 1, backgroundColor: "#000" },
  camera: { flex: 1 },
  overlayBox: {
    ...StyleSheet.absoluteFill,
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 48,
    paddingHorizontal: 20,
  },
  overlayTitle: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "700",
    textAlign: "center",
    backgroundColor: "rgba(0,0,0,0.6)",
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
  },
  idFrameGuide: {
    width: "92%",
    height: 210,
    borderWidth: 3,
    borderColor: "#38bdf8",
    borderRadius: 14,
  },
  faceOvalGuide: {
    width: 230,
    height: 300,
    borderWidth: 3,
    borderColor: "#4ade80",
    borderRadius: 150,
  },
  camActions: { flexDirection: "row", gap: 12, width: "100%" },
  cancelBtn: {
    flex: 1,
    backgroundColor: "rgba(255,255,255,0.2)",
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: "center",
  },
  cancelBtnText: { color: "#fff", fontWeight: "700" },
  captureBtn: {
    flex: 2,
    backgroundColor: "#16a34a",
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: "center",
  },
  captureBtnText: { color: "#fff", fontWeight: "700" },
});