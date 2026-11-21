import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool.js";

export const bankRouter = Router();

const openAccountSchema = z.object({
  userId: z.string().uuid(),
  kycSessionId: z.string().uuid(),
  currency: z.enum(["USD", "KHR"]).default("USD"),
});

bankRouter.post("/accounts/open", async (req, res) => {
  const parsed = openAccountSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid bank account payload", details: parsed.error.flatten() });
  }

  const { userId, kycSessionId, currency } = parsed.data;
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const kycCheck = await client.query(
      `SELECT s.status, u.full_name, u.doc_number
       FROM kyc_sessions s
       JOIN users u ON u.kyc_session_id = s.id
       WHERE s.id = $1 AND u.id = $2
       FOR UPDATE OF s`,
      [kycSessionId, userId]
    );

    if (kycCheck.rowCount === 0 || kycCheck.rows[0].status !== "APPROVED") {
      await client.query("ROLLBACK");
      return res.status(403).json({
        error: "Bank account creation blocked: verified and APPROVED eKYC is required.",
      });
    }

    const prefix = currency === "USD" ? "840" : "116";
    const accountNumber = `${prefix}${Date.now().toString().slice(-9)}`;

    const created = await client.query(
      `INSERT INTO bank_accounts (user_id, kyc_session_id, account_number, currency, balance, status)
       VALUES ($1, $2, $3, $4, 0.00, 'ACTIVE')
       RETURNING id, user_id, kyc_session_id, account_number, currency, balance, status, created_at`,
      [userId, kycSessionId, accountNumber, currency]
    );

    await client.query(
      `INSERT INTO kyc_audit_logs (session_id, event_type, actor, metadata)
       VALUES ($1, 'BANK_ACCOUNT_OPENED', 'bank-onboarding', $2::jsonb)`,
      [kycSessionId, JSON.stringify({ accountNumber, currency })]
    );

    await client.query("COMMIT");
    return res.status(201).json({
      message: "Bank account opened successfully",
      account: created.rows[0],
    });
  } catch (err: any) {
    await client.query("ROLLBACK");
    if (err?.code === "23505") {
      return res.status(409).json({ error: "A bank account already exists for this eKYC session" });
    }
    console.error("Open bank account error:", err);
    return res.status(500).json({ error: "Failed to open bank account" });
  } finally {
    client.release();
  }
});