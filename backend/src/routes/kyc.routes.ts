import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import multer from "multer";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { evaluateKyc } from "../services/kycEvaluator.js";
import { analyzeLivenessAndSelfie } from "../services/livenessService.js";
import { runDocumentOcr } from "../services/ocrService.js";

export const kycRouter = Router();

const uploadDir = path.resolve("uploads");
fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const safeExt = path.extname(file.originalname) || ".jpg";
    cb(null, `${Date.now()}-${Math.round(Math.random() * 1e6)}${safeExt}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 6 * 1024 * 1024 },
});

const uuidSchema = z.string().uuid();

// 1. Create a new eKYC verification session
kycRouter.post("/sessions", async (req, res) => {
  const parsed = z.object({ userId: z.string().trim().min(1).max(128) }).safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "userId is required" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows } = await client.query(
      `INSERT INTO kyc_sessions (user_id, status)
       VALUES ($1, 'PENDING')
       RETURNING id, user_id, status, risk_score, decision_reason, created_at, updated_at`,
      [parsed.data.userId]
    );
    const session = rows[0];

    await client.query(
      `INSERT INTO kyc_audit_logs (session_id, event_type, actor, metadata)
       VALUES ($1, 'SESSION_CREATED', $2, $3::jsonb)`,
      [session.id, parsed.data.userId, JSON.stringify({ status: "PENDING" })]
    );

    await client.query("COMMIT");
    return res.status(201).json({ session });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Create session error:", err);
    return res.status(500).json({ error: "Failed to create eKYC session" });
  } finally {
    client.release();
  }
});

// 2. Upload National ID or Passport image and extract OCR fields
kycRouter.post("/sessions/:sessionId/ocr-scan", upload.single("idImage"), async (req, res) => {
  const parsedId = uuidSchema.safeParse(req.params.sessionId);
  if (!parsedId.success) return res.status(400).json({ error: "Invalid sessionId UUID" });
  if (!req.file) return res.status(400).json({ error: "idImage file is required" });

  const docType = z
    .enum(["NATIONAL_ID", "PASSPORT", "DRIVER_LICENSE"])
    .catch("NATIONAL_ID")
    .parse(req.body.docType);

  try {
    const extracted = await runDocumentOcr(req.file.path, docType);
    const storageKey = `uploads/${req.file.filename}`;

    await pool.query(
      `INSERT INTO kyc_audit_logs (session_id, event_type, actor, metadata)
       VALUES ($1, 'OCR_DOCUMENT_SCANNED', 'ocr-service', $2::jsonb)`,
      [
        parsedId.data,
        JSON.stringify({
          docType,
          storageKey,
          docNumber: extracted.docNumber,
          nationality: extracted.nationality,
          ocrConfidence: extracted.ocrConfidence,
          mrzCheckValid: extracted.mrzCheckValid,
        }),
      ]
    );

    return res.json({
      storageKey,
      extracted,
    });
  } catch (err) {
    console.error("OCR scan error:", err);
    return res.status(500).json({ error: "Failed to run OCR on document image" });
  }
});

// 3. Upload a single selfie frame cleanly from Expo FileSystem.createUploadTask
kycRouter.post("/sessions/:sessionId/upload-selfie", upload.single("selfieImage"), async (req, res) => {
  const parsedId = uuidSchema.safeParse(req.params.sessionId);
  if (!parsedId.success) return res.status(400).json({ error: "Invalid sessionId UUID" });
  if (!req.file) return res.status(400).json({ error: "selfieImage file is required" });

  return res.json({ storageKey: `uploads/${req.file.filename}` });
});

// 4. Verify 2 uploaded selfie frames + evaluate eKYC + persist to PostgreSQL
kycRouter.post("/sessions/:sessionId/liveness-verify-json", async (req, res) => {
  const parsedId = uuidSchema.safeParse(req.params.sessionId);
  if (!parsedId.success) return res.status(400).json({ error: "Invalid sessionId UUID" });

  const bodySchema = z.object({
    docType: z.enum(["NATIONAL_ID", "PASSPORT", "DRIVER_LICENSE"]),
    storageKey: z.string().min(1),
    neutralStorageKey: z.string().min(1),
    challengeStorageKey: z.string().min(1),
    fullName: z.string().trim().min(1).max(200),
    docNumber: z.string().trim().min(1).max(128),
    dateOfBirth: z.string().trim().max(20),
    expiryDate: z.string().trim().max(20),
    ocrConfidence: z.coerce.number().min(0).max(1),
  });

  const parsedBody = bodySchema.safeParse(req.body);
  if (!parsedBody.success) {
    return res.status(400).json({ error: "Invalid verification payload", details: parsedBody.error.flatten() });
  }

  const sessionId = parsedId.data;
  const {
    docType,
    storageKey,
    neutralStorageKey,
    challengeStorageKey,
    fullName,
    docNumber,
    dateOfBirth,
    expiryDate,
    ocrConfidence,
  } = parsedBody.data;

  const neutralPath = path.resolve(neutralStorageKey);
  const challengePath = path.resolve(challengeStorageKey);
  const idDiskPath = path.resolve(storageKey);

  if (!fs.existsSync(neutralPath) || !fs.existsSync(challengePath)) {
    return res.status(400).json({ error: "Uploaded selfie frames not found on server" });
  }

  const client = await pool.connect();
  try {
    const biometrics = await analyzeLivenessAndSelfie(
      neutralPath,
      challengePath,
      fs.existsSync(idDiskPath) ? idDiskPath : neutralPath
    );

    await client.query("BEGIN");

    const sessionCheck = await client.query(
      `SELECT id FROM kyc_sessions WHERE id = $1 FOR UPDATE`,
      [sessionId]
    );
    if (sessionCheck.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "KYC session not found" });
    }

    // Prevent reusing a document number already registered to another user account
    const duplicateDoc = await client.query(
      `SELECT id FROM users WHERE UPPER(doc_number) = UPPER($1) LIMIT 1`,
      [docNumber]
    );
    if ((duplicateDoc.rowCount ?? 0) > 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        error: "This National ID / Passport number is already linked to another registered account",
      });
    }

    const safeDob = /^\d{4}-\d{2}-\d{2}$/.test(dateOfBirth) ? dateOfBirth : "1990-01-01";
    const safeExp = /^\d{4}-\d{2}-\d{2}$/.test(expiryDate) ? expiryDate : "2020-01-01";

    await client.query(
      `INSERT INTO kyc_documents (
         session_id, doc_type, storage_key, full_name,
         doc_number, date_of_birth, expiry_date, ocr_confidence
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [sessionId, docType, storageKey, fullName, docNumber, safeDob, safeExp, ocrConfidence]
    );

    await client.query(
      `INSERT INTO kyc_biometric_checks (
         session_id, liveness_passed, liveness_score, face_match_score
       ) VALUES ($1, $2, $3, $4)`,
      [sessionId, biometrics.livenessPassed, biometrics.livenessScore, biometrics.faceMatchScore]
    );

    const evaluation = evaluateKyc({
      docNumber,
      fullName,
      dateOfBirth,
      expiryDate,
      ocrConfidence,
      livenessPassed: biometrics.livenessPassed,
      livenessScore: biometrics.livenessScore,
      faceMatchScore: biometrics.faceMatchScore,
    });

    const updated = await client.query(
      `UPDATE kyc_sessions
       SET status = $1,
           risk_score = $2,
           decision_reason = $3,
           updated_at = NOW()
       WHERE id = $4
       RETURNING id, user_id, status, risk_score, decision_reason, created_at, updated_at`,
      [evaluation.status, evaluation.riskScore, evaluation.reason, sessionId]
    );

    await client.query(
      `INSERT INTO kyc_audit_logs (session_id, event_type, actor, metadata)
       VALUES ($1, 'LIVENESS_AND_KYC_COMPLETED', 'liveness-service', $2::jsonb)`,
      [
        sessionId,
        JSON.stringify({
          status: evaluation.status,
          riskScore: evaluation.riskScore,
          reason: evaluation.reason,
          livenessNotes: biometrics.notes,
        }),
      ]
    );

    await client.query("COMMIT");
    return res.json({
      session: updated.rows[0],
      biometrics,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Liveness verify error:", err);
    return res.status(500).json({ error: "Failed to verify liveness and save eKYC" });
  } finally {
    client.release();
  }
});

// 5. Inspect KYC session, latest document, latest biometrics, and audit trail
kycRouter.get("/sessions/:sessionId", async (req, res) => {
  const parsedId = uuidSchema.safeParse(req.params.sessionId);
  if (!parsedId.success) return res.status(400).json({ error: "Invalid sessionId UUID" });

  try {
    const [sessionRes, docRes, bioRes, logsRes] = await Promise.all([
      pool.query(
        `SELECT id, user_id, status, risk_score, decision_reason, created_at, updated_at
         FROM kyc_sessions WHERE id = $1`,
        [parsedId.data]
      ),
      pool.query(
        `SELECT * FROM kyc_documents WHERE session_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [parsedId.data]
      ),
      pool.query(
        `SELECT * FROM kyc_biometric_checks WHERE session_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [parsedId.data]
      ),
      pool.query(
        `SELECT * FROM kyc_audit_logs WHERE session_id = $1 ORDER BY id ASC`,
        [parsedId.data]
      ),
    ]);

    if (sessionRes.rowCount === 0) return res.status(404).json({ error: "Session not found" });

    return res.json({
      session: sessionRes.rows[0],
      document: docRes.rows[0] ?? null,
      biometrics: bioRes.rows[0] ?? null,
      auditLogs: logsRes.rows,
    });
  } catch (err) {
    console.error("Fetch session error:", err);
    return res.status(500).json({ error: "Failed to load session" });
  }
});