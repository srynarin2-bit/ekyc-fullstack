import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { evaluateKyc } from "../services/kycEvaluator.js";

export const kycRouter = Router();

const uuidSchema = z.string().uuid();

const createSessionSchema = z.object({
  userId: z.string().trim().min(1).max(128),
});

const submitKycSchema = z.object({
  docType: z.enum(["NATIONAL_ID", "PASSPORT", "DRIVER_LICENSE"]),
  storageKey: z.string().trim().min(1).max(512),
  document: z.object({
    fullName: z.string().trim().min(1).max(200),
    docNumber: z.string().trim().min(1).max(128),
    dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD"),
    expiryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD"),
    ocrConfidence: z.number().min(0).max(1),
  }),
  biometrics: z.object({
    livenessPassed: z.boolean(),
    livenessScore: z.number().min(0).max(1),
    faceMatchScore: z.number().min(0).max(1),
  }),
});

kycRouter.post("/sessions", async (req, res) => {
  const parsed = createSessionSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
  }

  const { userId } = parsed.data;
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const { rows } = await client.query(
      `INSERT INTO kyc_sessions (user_id, status)
       VALUES ($1, 'PENDING')
       RETURNING id, user_id, status, risk_score, decision_reason, created_at, updated_at`,
      [userId]
    );

    const session = rows[0];

    await client.query(
      `INSERT INTO kyc_audit_logs (session_id, event_type, actor, metadata)
       VALUES ($1, 'SESSION_CREATED', $2, $3::jsonb)`,
      [session.id, userId, JSON.stringify({ status: "PENDING" })]
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

kycRouter.post("/sessions/:sessionId/submit", async (req, res) => {
  const parsedId = uuidSchema.safeParse(req.params.sessionId);
  if (!parsedId.success) {
    return res.status(400).json({ error: "Invalid sessionId UUID" });
  }

  const parsedBody = submitKycSchema.safeParse(req.body);
  if (!parsedBody.success) {
    return res.status(400).json({ error: "Invalid payload", details: parsedBody.error.flatten() });
  }

  const sessionId = parsedId.data;
  const { docType, storageKey, document, biometrics } = parsedBody.data;
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const sessionCheck = await client.query(
      `SELECT id FROM kyc_sessions WHERE id = $1 FOR UPDATE`,
      [sessionId]
    );

    if (sessionCheck.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Session not found" });
    }

    await client.query(
      `INSERT INTO kyc_documents (
         session_id, doc_type, storage_key, full_name,
         doc_number, date_of_birth, expiry_date, ocr_confidence
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        sessionId,
        docType,
        storageKey,
        document.fullName,
        document.docNumber,
        document.dateOfBirth,
        document.expiryDate,
        document.ocrConfidence,
      ]
    );

    await client.query(
      `INSERT INTO kyc_biometric_checks (
         session_id, liveness_passed, liveness_score, face_match_score
       ) VALUES ($1, $2, $3, $4)`,
      [
        sessionId,
        biometrics.livenessPassed,
        biometrics.livenessScore,
        biometrics.faceMatchScore,
      ]
    );

    const evaluation = evaluateKyc({
      expiryDate: document.expiryDate,
      ocrConfidence: document.ocrConfidence,
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
       VALUES ($1, 'KYC_SUBMITTED_AND_EVALUATED', 'mobile-client', $2::jsonb)`,
      [
        sessionId,
        JSON.stringify({
          status: evaluation.status,
          riskScore: evaluation.riskScore,
          reason: evaluation.reason,
        }),
      ]
    );

    await client.query("COMMIT");
    return res.status(200).json({ session: updated.rows[0] });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Submit KYC error:", err);
    return res.status(500).json({ error: "Failed to submit eKYC data" });
  } finally {
    client.release();
  }
});

kycRouter.get("/sessions/:sessionId", async (req, res) => {
  const parsedId = uuidSchema.safeParse(req.params.sessionId);
  if (!parsedId.success) {
    return res.status(400).json({ error: "Invalid sessionId UUID" });
  }

  try {
    const sessionRes = await pool.query(
      `SELECT id, user_id, status, risk_score, decision_reason, created_at, updated_at
       FROM kyc_sessions WHERE id = $1`,
      [parsedId.data]
    );

    if (sessionRes.rowCount === 0) {
      return res.status(404).json({ error: "Session not found" });
    }

    const logsRes = await pool.query(
      `SELECT id, event_type, actor, metadata, created_at
       FROM kyc_audit_logs WHERE session_id = $1 ORDER BY id ASC`,
      [parsedId.data]
    );

    return res.json({
      session: sessionRes.rows[0],
      auditLogs: logsRes.rows,
    });
  } catch (err) {
    console.error("Fetch session error:", err);
    return res.status(500).json({ error: "Failed to load eKYC session" });
  }
});