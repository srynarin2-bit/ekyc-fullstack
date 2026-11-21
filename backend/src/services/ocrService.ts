import sharp from "sharp";
import { createWorker, Worker } from "tesseract.js";

export interface ExtractedIdFields {
  rawText: string;
  fullName: string;
  docNumber: string;
  nationality: string;
  dateOfBirth: string; // YYYY-MM-DD
  expiryDate: string;  // YYYY-MM-DD
  mrzCheckValid: boolean;
  ocrConfidence: number; // 0.0 - 1.0
  isValidData: boolean;
  validationIssues: string[];
}

let cachedWorker: Worker | null = null;
let workerInitPromise: Promise<Worker> | null = null;

async function getOcrWorker(): Promise<Worker> {
  if (cachedWorker) return cachedWorker;
  if (!workerInitPromise) {
    workerInitPromise = (async () => {
      const worker = await createWorker("eng");
      await worker.setParameters({
        tessedit_pageseg_mode: "3" as any, // Fully automatic page segmentation
      });
      cachedWorker = worker;
      return worker;
    })();
  }
  return workerInitPromise;
}

// Standard ICAO 9303 MRZ check digit calculation (weights 7, 3, 1)
function computeMrzCheckDigit(input: string): string {
  const weights = [7, 3, 1];
  let sum = 0;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    let val = 0;
    if (ch >= "0" && ch <= "9") {
      val = Number(ch);
    } else if (ch >= "A" && ch <= "Z") {
      val = ch.charCodeAt(0) - 55; // A=10 .. Z=35
    } else if (ch === "<") {
      val = 0;
    } else {
      val = 0;
    }
    sum += val * weights[i % 3];
  }

  return String(sum % 10);
}

function parseYymmdd(yymmdd: string, isExpiry: boolean): string | null {
  if (!/^\d{6}$/.test(yymmdd)) return null;
  const yy = Number(yymmdd.slice(0, 2));
  const mm = Number(yymmdd.slice(2, 4));
  const dd = Number(yymmdd.slice(4, 6));
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;

  const year = isExpiry ? 2000 + yy : yy > 35 ? 1900 + yy : 2000 + yy;
  return `${year}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
}

function cleanMrzName(raw: string): string {
  return raw
    .replace(/<+/g, " ")
    .replace(/[^A-Z\s'-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseDocumentFields(rawText: string, docType: string) {
  const lines = rawText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  // Collect MRZ candidate lines (lines with '<<' or long uppercase MRZ-like strings)
  const mrzLines = lines
    .map((l) => l.replace(/\s+/g, "").replace(/[«»]/g, "<").toUpperCase())
    .filter((l) => l.includes("<") && l.length >= 24);

  let fullName = "";
  let docNumber = "";
  let nationality = docType === "NATIONAL_ID" ? "KHM" : "";
  let dateOfBirth = "";
  let expiryDate = "";
  let mrzCheckValid = false;

  // TD1 3-line MRZ (Cambodian National ID: IDKHM..., YYMMDD..., SURNAME<<GIVEN...)
  const td1Idx = mrzLines.findIndex((l) => /^I[D0O]/.test(l));
  if (td1Idx !== -1 && mrzLines.length >= td1Idx + 3) {
    const l1 = mrzLines[td1Idx];
    const l2 = mrzLines[td1Idx + 1];
    const l3 = mrzLines[td1Idx + 2];

    const docNumRaw = l1.slice(5, 14).replace(/</g, "").replace(/[^A-Z0-9]/g, "");
    const docCheck = l1[14] ?? "";
    docNumber = docNumRaw;
    nationality = l1.slice(2, 5).replace(/</g, "") || "KHM";

    const dobRaw = l2.slice(0, 6);
    const dobCheck = l2[6] ?? "";
    const expRaw = l2.slice(8, 14);
    const expCheck = l2[14] ?? "";

    const dobParsed = parseYymmdd(dobRaw, false);
    const expParsed = parseYymmdd(expRaw, true);
    if (dobParsed) dateOfBirth = dobParsed;
    if (expParsed) expiryDate = expParsed;

    const [surnamePart, givenPart] = l3.split("<<");
    fullName = `${cleanMrzName(surnamePart ?? "")} ${cleanMrzName(givenPart ?? "")}`.trim();

    const docOk = docNumRaw.length >= 6 && (!/[0-9]/.test(docCheck) || computeMrzCheckDigit(l1.slice(5, 14)) === docCheck);
    const dobOk = /^\d{6}$/.test(dobRaw) && computeMrzCheckDigit(dobRaw) === dobCheck;
    const expOk = /^\d{6}$/.test(expRaw) && computeMrzCheckDigit(expRaw) === expCheck;
    mrzCheckValid = docOk && (dobOk || expOk);
  }
  // TD3 2-line MRZ (International Passports: P<CCCSURNAME<<GIVEN... and DOCNUM<CHECK...)
  else if (mrzLines.length >= 2 && mrzLines[0].startsWith("P")) {
    const l1 = mrzLines[0];
    const l2 = mrzLines[1];

    nationality = l1.slice(2, 5).replace(/</g, "") || "INT";
    const [surnamePart, givenPart] = l1.slice(5).split("<<");
    fullName = `${cleanMrzName(surnamePart ?? "")} ${cleanMrzName(givenPart ?? "")}`.trim();

    const docNumRaw = l2.slice(0, 9).replace(/</g, "").replace(/[^A-Z0-9]/g, "");
    const docCheck = l2[9] ?? "";
    docNumber = docNumRaw;

    const dobRaw = l2.slice(13, 19);
    const dobCheck = l2[19] ?? "";
    const expRaw = l2.slice(21, 27);
    const expCheck = l2[27] ?? "";

    const dobParsed = parseYymmdd(dobRaw, false);
    const expParsed = parseYymmdd(expRaw, true);
    if (dobParsed) dateOfBirth = dobParsed;
    if (expParsed) expiryDate = expParsed;

    const docOk = docNumRaw.length >= 6 && computeMrzCheckDigit(l2.slice(0, 9)) === docCheck;
    const dobOk = /^\d{6}$/.test(dobRaw) && computeMrzCheckDigit(dobRaw) === dobCheck;
    const expOk = /^\d{6}$/.test(expRaw) && computeMrzCheckDigit(expRaw) === expCheck;
    mrzCheckValid = docOk && dobOk && expOk;
  }

  // Fallback text extraction if MRZ was partially occluded
  if (!docNumber) {
    const docMatch = rawText.match(/\b([A-Z]{1,2}\d{6,9}|0\d{8}|\d{9,12})\b/);
    docNumber = docMatch ? docMatch[1] : "";
  }

  if (!fullName) {
    const candidate = lines.find(
      (line) =>
        /^[A-Z]{2,}(?:\s+[A-Z]{2,}){1,4}$/.test(line.trim()) &&
        !/KINGDOM|PASSPORT|IDENTITY|CARD|NATIONAL|CAMBODIA|KHMER|MINISTRY|INTERIOR|SURNAME|GIVEN/.test(
          line.toUpperCase()
        )
    );
    fullName = candidate ? candidate.trim() : "";
  }

  const dates = (rawText.match(/\b(19\d{2}|20\d{2})[-/.](0[1-9]|1[0-2])[-/.](0[1-9]|[12]\d|3[01])\b/g) ?? [])
    .map((d) => d.replace(/[/.]/g, "-"))
    .sort();

  if (!dateOfBirth && dates.length >= 1) dateOfBirth = dates[0];
  if (!expiryDate && dates.length >= 2) expiryDate = dates[dates.length - 1];

  return {
    fullName,
    docNumber,
    nationality,
    dateOfBirth,
    expiryDate,
    mrzCheckValid,
  };
}

export async function runDocumentOcr(filePath: string, docType: string): Promise<ExtractedIdFields> {
  const preprocessed = await sharp(filePath)
    .rotate()
    .resize({ width: 1400, withoutEnlargement: true })
    .grayscale()
    .normalize()
    .sharpen()
    .toBuffer();

  const worker = await getOcrWorker();
  const { data } = await worker.recognize(preprocessed);

  const rawText = (data.text ?? "").trim();
  const tesseractConf = Math.min(Math.max((data.confidence ?? 0) / 100, 0), 1);
  const parsed = parseDocumentFields(rawText, docType);

  const validationIssues: string[] = [];
  if (!parsed.docNumber || parsed.docNumber.length < 6) {
    validationIssues.push("Document number missing or unreadable");
  }
  if (!parsed.fullName || parsed.fullName.length < 3) {
    validationIssues.push("Holder full name missing or unreadable");
  }
  if (!parsed.dateOfBirth) {
    validationIssues.push("Date of birth missing or unreadable");
  }
  if (!parsed.expiryDate) {
    validationIssues.push("Expiry date missing or unreadable");
  } else {
    const todayIso = new Date().toISOString().slice(0, 10);
    if (parsed.expiryDate < todayIso) {
      validationIssues.push(`Document expired on ${parsed.expiryDate}`);
    }
  }
  if ((rawText.includes("<<") || docType === "PASSPORT") && !parsed.mrzCheckValid) {
    validationIssues.push("MRZ check-digit verification failed (re-scan clearly)");
  }

  let completeness = 0;
  if (parsed.docNumber.length >= 6) completeness += 0.3;
  if (parsed.fullName.length >= 3) completeness += 0.3;
  if (parsed.dateOfBirth) completeness += 0.15;
  if (parsed.expiryDate) completeness += 0.15;
  if (parsed.mrzCheckValid) completeness += 0.1;

  const dynamicConfidence = Number(
    Math.min(Math.max(tesseractConf * 0.45 + completeness * 0.55, 0.05), 0.99).toFixed(4)
  );

  return {
    rawText,
    fullName: parsed.fullName || "UNREADABLE_NAME",
    docNumber: parsed.docNumber || "UNREADABLE_ID",
    nationality: parsed.nationality || "UNKNOWN",
    dateOfBirth: parsed.dateOfBirth || "1990-01-01",
    expiryDate: parsed.expiryDate || "2020-01-01",
    mrzCheckValid: parsed.mrzCheckValid,
    ocrConfidence: dynamicConfidence,
    isValidData: validationIssues.length === 0,
    validationIssues,
  };
}