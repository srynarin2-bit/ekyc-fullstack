import bcrypt from "bcryptjs";
import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool.js";

export const authRouter = Router();

const registerSchema = z.object({
  kycSessionId: z.string().uuid(),
  email: z.string().email().max(255),
  password: z.string().min(8).max(128),
});

authRouter.post("/register", async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid registration fields", details: parsed.error.flatten() });
  }

  const { kycSessionId, email, password } = parsed.data;
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Verify eKYC session exists and is APPROVED
    const kycRes = await client.query(
      `SELECT s.id, s.status, d.full_name, d.doc_number
       FROM kyc_sessions s
       JOIN kyc_documents d ON d.session_id = s.id
       WHERE s.id = $1
       ORDER BY d.created_at DESC
       LIMIT 1`,
      [kycSessionId]
    );

    if (kycRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "Complete National ID/Passport eKYC before registering." });
    }

    const kyc = kycRes.rows[0];
    if (kyc.status !== "APPROVED") {
      await client.query("ROLLBACK");
      return res.status(403).json({
        error: `Account registration blocked: your eKYC status is ${kyc.status}.`,
      });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const userRes = await client.query(
      `INSERT INTO users (kyc_session_id, email, password_hash, full_name, doc_number)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, kyc_session_id, email, full_name, doc_number, created_at`,
      [kycSessionId, email.toLowerCase(), passwordHash, kyc.full_name, kyc.doc_number]
    );

    await client.query(
      `INSERT INTO kyc_audit_logs (session_id, event_type, actor, metadata)
       VALUES ($1, 'ACCOUNT_REGISTERED', $2, $3::jsonb)`,
      [kycSessionId, email.toLowerCase(), JSON.stringify({ userId: userRes.rows[0].id })]
    );

    await client.query("COMMIT");
    return res.status(201).json({
      message: "Verified account created successfully",
      user: userRes.rows[0],
    });
  } catch (err: any) {
    await client.query("ROLLBACK");
    if (err?.code === "23505") {
      return res.status(409).json({ error: "Email or eKYC session already registered" });
    }
    console.error("Registration error:", err);
    return res.status(500).json({ error: "Failed to register account" });
  } finally {
    client.release();
  }
});