import cors from "cors";
import express from "express";
import { env } from "./config/env.js";
import { pool } from "./db/pool.js";
import { authRouter } from "./routes/auth.routes.js";
import { bankRouter } from "./routes/bank.routes.js";
import { kycRouter } from "./routes/kyc.routes.js";

const app = express();

app.use(cors());
app.use(express.json({ limit: "2mb" }));

app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url} from ${req.ip}`);
  next();
});

app.get("/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    return res.json({ status: "ok", database: "connected" });
  } catch (err) {
    console.error("Health check failed:", err);
    return res.status(500).json({ status: "error", database: "unreachable" });
  }
});

app.use("/api/kyc", kycRouter);
app.use("/api/auth", authRouter);
app.use("/api/bank", bankRouter);

app.listen(env.PORT, env.HOST, () => {
  console.log(`eKYC & Bank server listening on http://${env.HOST}:${env.PORT}`);
});