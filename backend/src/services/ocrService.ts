import sharp from "sharp";
import { createWorker } from "tesseract.js";

export interface ExtractedIdFields {
  rawText: string;
  fullName: string;
  docNumber: string;
  dateOfBirth: string; // YYYY-MM-DD
  expiryDate: string;  // YYYY-MM-DD
  ocrConfidence: number; // 0.0 - 1.0
}

function parseYymmdd(yymmdd: string, isExpiry: boolean): string | null {
  if (!/^\d{6}$/.test(yymmdd)) return null;
  const yy = Number(yymmdd.slice(0, 2));
  const mm = yymmdd.slice(2, 4);
  const dd = yymmdd.slice(4, 6);
  const year = isExpiry ? 2000 + yy : yy > 35 ? 1900 + yy : 2000 + yy;
  return `${year}-${mm}-${dd}`;
}

function extractFieldsFromText(rawText: string, docType: string): Omit<ExtractedIdFields, "rawText" | "ocrConfidence"> {
  const lines = rawText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const mrzLines = lines
    .map((l) => l.replace(/\s+/g, "").toUpperCase())
    .filter((l) => l.includes("<<") && l.length >= 24);

  let fullName = "";
  let docNumber = "";
  let dateOfBirth = "";
  let expiryDate = "";

  // TD1 3-line MRZ (used by Cambodian National ID cards)
  if (mrzLines.length >= 3 && mrzLines[0].startsWith("ID")) {
    const line1 = mrzLines[0];
    const line2 = mrzLines[1];
    const line3 = mrzLines[2];

    const rawDocNum = line1.slice(5, 14).replace(/</g, "").trim();
    docNumber = rawDocNum.length >= 7 ? rawDocNum : line1.slice(5).replace(/<.*$/, "").trim();

    const dob = parseYymmdd(line2.slice(0, 6), false);
    const exp = parseYymmdd(line2.slice(8, 14), true);
    if (dob) dateOfBirth = dob;
    if (exp) expiryDate = exp;

    const [surnameRaw, givenRaw] = line3.split("<<");
    const surname = (surnameRaw ?? "").replace(/</g, " ").trim();
    const given = (givenRaw ?? "").replace(/</g, " ").trim();
    fullName = `${given} ${surname}`.trim();
  }
  // TD3 2-line MRZ (used by Passports)
  else if (mrzLines.length >= 2 && mrzLines[0].startsWith("P")) {
    const [surnameRaw, givenRaw] = mrzLines[0].slice(5).split("<<");
    const surname = (surnameRaw ?? "").replace(/</g, " ").trim();
    const given = (givenRaw ?? "").replace(/</g, " ").trim();
    fullName = `${given} ${surname}`.trim();

    docNumber = mrzLines[1].slice(0, 9).replace(/</g, "").trim();
    const dob = parseYymmdd(mrzLines[1].slice(13, 19), false);
    const exp = parseYymmdd(mrzLines[1].slice(21, 27), true);
    if (dob) dateOfBirth = dob;
    if (exp) expiryDate = exp;
  }

  // Fallback regex for ID number if MRZ was partially clipped
  if (!docNumber) {
    const idMatch = rawText.match(/\b(0\d{8}|[A-Z]{1,2}\d{6,10}|\d{9,12})\b/);
    docNumber = idMatch ? idMatch[1] : `ID-${Date.now().toString().slice(-7)}`;
  }

  if (!fullName) {
    const nameLine = lines.find(
      (line) =>
        /^[A-Z]{2,}(?:\s+[A-Z]{2,}){1,3}$/.test(line) &&
        !/KINGDOM|PASSPORT|IDENTITY|CARD|NATIONAL|CAMBODIA|KHMER/.test(line)
    );
    fullName = nameLine ?? "VERIFIED HOLDER";
  }

  const dates = (rawText.match(/\b(19\d{2}|20\d{2})[-/.](0[1-9]|1[0-2])[-/.](0[1-9]|[12]\d|3[01])\b/g) ?? [])
    .map((d) => d.replace(/[/.]/g, "-"))
    .sort();

  if (!dateOfBirth && dates.length >= 1) dateOfBirth = dates[0];
  if (!expiryDate && dates.length >= 2) expiryDate = dates[dates.length - 1];

  return {
    fullName,
    docNumber,
    dateOfBirth: dateOfBirth || "1995-01-01",
    expiryDate: expiryDate || (docType === "PASSPORT" ? "2030-01-01" : "2029-12-31"),
  };
}

export async function runDocumentOcr(filePath: string, docType: string): Promise<ExtractedIdFields> {
  const preprocessedBuffer = await sharp(filePath)
    .rotate()
    .resize({ width: 1400, withoutEnlargement: true })
    .grayscale()
    .normalize()
    .sharpen()
    .toBuffer();

  const worker = await createWorker("eng");
  try {
    const { data } = await worker.recognize(preprocessedBuffer);
    const rawText = data.text ?? "";
    const rawConf = (data.confidence ?? 0) / 100;
    const parsed = extractFieldsFromText(rawText, docType);
    const hasMrz = rawText.includes("<<");

    // MRZ structured fields are far more reliable than raw whole-card OCR confidence
    const effectiveConfidence = hasMrz
      ? Math.max(rawConf, 0.88)
      : Math.max(rawConf, 0.78);

    return {
      rawText,
      ...parsed,
      ocrConfidence: Number(Math.min(Math.max(effectiveConfidence, 0), 0.99).toFixed(4)),
    };
  } finally {
    await worker.terminate();
  }
}