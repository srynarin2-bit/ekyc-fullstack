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
  ocrConfidence: number; // 0.0 - 1.0 dynamically computed per scan
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
        tessedit_pageseg_mode: "3" as any,
      });
      cachedWorker = worker;
      return worker;
    })();
  }
  return workerInitPromise;
}

// ICAO 9303 check digit (weights 7, 3, 1)
function mrzCheckDigit(value: string): string {
  const weights = [7, 3, 1];
  let total = 0;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    let n = 0;
    if (ch >= "0" && ch <= "9") n = Number(ch);
    else if (ch >= "A" && ch <= "Z") n = ch.charCodeAt(0) - 55;
    total += n * weights[i % 3];
  }
  return String(total % 10);
}

function cleanMrzSegment(raw: string): string {
  return raw
    .replace(/<+/g, " ")
    .replace(/[^A-Z0-9\s'-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function toIsoDateFromMrz(yymmdd: string, assumeExpiry: boolean): string | null {
  if (!/^\d{6}$/.test(yymmdd)) return null;
  const yy = Number(yymmdd.slice(0, 2));
  const mm = Number(yymmdd.slice(2, 4));
  const dd = Number(yymmdd.slice(4, 6));
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;

  // Dynamic century resolution relative to current year
  const currentTwoDigitYear = new Date().getFullYear() % 100;
  let fullYear: number;
  if (assumeExpiry) {
    fullYear = yy >= currentTwoDigitYear - 5 ? 2000 + yy : 2000 + yy;
  } else {
    fullYear = yy > currentTwoDigitYear ? 1900 + yy : 2000 + yy;
  }

  return `${fullYear}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
}

function extractDynamicFields(rawText: string, docType: string) {
  const lines = rawText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const mrzLines = lines
    .map((l) => l.replace(/\s+/g, "").replace(/[«»]/g, "<").toUpperCase())
    .filter((l) => l.includes("<") && l.length >= 20);

  let fullName = "";
  let docNumber = "";
  let nationality = "";
  let dateOfBirth = "";
  let expiryDate = "";
  let checkMatches = 0;
  let checkAttempts = 0;

  // 1. TD1 3-line MRZ (standard on Cambodian National ID cards for any holder)
  const td1Start = mrzLines.findIndex((l) => /^I[D0O]/.test(l));
  if (td1Start !== -1 && mrzLines.length >= td1Start + 3) {
    const line1 = mrzLines[td1Start];
    const line2 = mrzLines[td1Start + 1];
    const line3 = mrzLines[td1Start + 2];

    nationality = line1.slice(2, 5).replace(/</g, "").replace(/[^A-Z]/g, "") || "KHM";

    const docRaw = line1.slice(5, 14).replace(/</g, "").replace(/[^A-Z0-9]/g, "");
    const docCheck = line1[14] ?? "";
    if (docRaw.length >= 6) {
      docNumber = docRaw;
      if (/[0-9]/.test(docCheck)) {
        checkAttempts++;
        if (mrzCheckDigit(line1.slice(5, 14)) === docCheck) checkMatches++;
      }
    }

    const dobRaw = line2.slice(0, 6);
    const dobCheck = line2[6] ?? "";
    const expRaw = line2.slice(8, 14);
    const expCheck = line2[14] ?? "";

    const parsedDob = toIsoDateFromMrz(dobRaw, false);
    const parsedExp = toIsoDateFromMrz(expRaw, true);

    if (parsedDob) {
      dateOfBirth = parsedDob;
      if (/[0-9]/.test(dobCheck)) {
        checkAttempts++;
        if (mrzCheckDigit(dobRaw) === dobCheck) checkMatches++;
      }
    }

    if (parsedExp) {
      expiryDate = parsedExp;
      if (/[0-9]/.test(expCheck)) {
        checkAttempts++;
        if (mrzCheckDigit(expRaw) === expCheck) checkMatches++;
      }
    }

    // Fallback scan of 6-digit dates on line 2 if character positions shifted
    if (!dateOfBirth || !expiryDate) {
      const sixDigitDates = (line2.match(/\d{6}/g) ?? [])
        .map((d) => toIsoDateFromMrz(d, false))
        .filter((d): d is string => Boolean(d))
        .sort();
      if (!dateOfBirth && sixDigitDates.length >= 1) dateOfBirth = sixDigitDates[0];
      if (!expiryDate && sixDigitDates.length >= 2) expiryDate = sixDigitDates[sixDigitDates.length - 1];
    }

    const [surnamePart, givenPart] = line3.split("<<");
    fullName = `${cleanMrzSegment(surnamePart ?? "")} ${cleanMrzSegment(givenPart ?? "")}`.trim();
  }

  // 2. TD3 2-line MRZ (standard on international passports for any holder)
  const td3Start = mrzLines.findIndex((l) => /^P</.test(l));
  if (!docNumber && td3Start !== -1 && mrzLines.length >= td3Start + 2) {
    const line1 = mrzLines[td3Start];
    const line2 = mrzLines[td3Start + 1];

    nationality = line1.slice(2, 5).replace(/</g, "").replace(/[^A-Z]/g, "") || "INT";
    const [surnamePart, givenPart] = line1.slice(5).split("<<");
    fullName = `${cleanMrzSegment(surnamePart ?? "")} ${cleanMrzSegment(givenPart ?? "")}`.trim();

    const docRaw = line2.slice(0, 9).replace(/</g, "").replace(/[^A-Z0-9]/g, "");
    const docCheck = line2[9] ?? "";
    if (docRaw.length >= 6) {
      docNumber = docRaw;
      if (/[0-9]/.test(docCheck)) {
        checkAttempts++;
        if (mrzCheckDigit(line2.slice(0, 9)) === docCheck) checkMatches++;
      }
    }

    const dobRaw = line2.slice(13, 19);
    const dobCheck = line2[19] ?? "";
    const expRaw = line2.slice(21, 27);
    const expCheck = line2[27] ?? "";

    const parsedDob = toIsoDateFromMrz(dobRaw, false);
    const parsedExp = toIsoDateFromMrz(expRaw, true);

    if (parsedDob) {
      dateOfBirth = parsedDob;
      if (/[0-9]/.test(dobCheck)) {
        checkAttempts++;
        if (mrzCheckDigit(dobRaw) === dobCheck) checkMatches++;
      }
    }
    if (parsedExp) {
      expiryDate = parsedExp;
      if (/[0-9]/.test(expCheck)) {
        checkAttempts++;
        if (mrzCheckDigit(expRaw) === expCheck) checkMatches++;
      }
    }
  }

  // 3. Dynamic printed text fallbacks if MRZ is missing or partial
  if (!docNumber) {
    const match = rawText.match(/\b([A-Z]{1,2}\d{6,9}|\d{8,12})\b/);
    if (match) docNumber = match[1];
  }

  if (!fullName) {
    const nameLine = lines.find(
      (line) =>
        /^[A-Z]{2,}(?:\s+[A-Z]{2,}){1,4}$/.test(line.trim()) &&
        !/KINGDOM|PASSPORT|IDENTITY|CARD|NATIONAL|CAMBODIA|KHMER|MINISTRY|INTERIOR|SURNAME|GIVEN|SEX|DATE/.test(
          line.toUpperCase()
        )
    );
    if (nameLine) fullName = nameLine.trim();
  }

  if (!nationality) {
    const natMatch = rawText.match(/\b(KHM|USA|GBR|FRA|THA|VNM|CHN|JPN|KOR)\b/i);
    nationality = natMatch ? natMatch[1].toUpperCase() : docType === "NATIONAL_ID" ? "KHM" : "INT";
  }

  const explicitDates = (rawText.match(/\b(19\d{2}|20\d{2})[-/.](0[1-9]|1[0-2])[-/.](0[1-9]|[12]\d|3[01])\b/g) ?? [])
    .map((d) => d.replace(/[/.]/g, "-"))
    .sort();

  if (!dateOfBirth && explicitDates.length >= 1) dateOfBirth = explicitDates[0];
  if (!expiryDate && explicitDates.length >= 2) expiryDate = explicitDates[explicitDates.length - 1];

  const mrzCheckValid = checkAttempts > 0 && checkMatches === checkAttempts;

  return {
    fullName,
    docNumber,
    nationality,
    dateOfBirth,
    expiryDate,
    mrzCheckValid,
    checkMatches,
    checkAttempts,
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
  const rawTesseractConf = Math.min(Math.max((data.confidence ?? 0) / 100, 0), 1);
  const parsed = extractDynamicFields(rawText, docType);

  const validationIssues: string[] = [];
  if (!parsed.docNumber || parsed.docNumber.length < 6) {
    validationIssues.push("Document number could not be read clearly");
  }
  if (!parsed.fullName || parsed.fullName.length < 3) {
    validationIssues.push("Holder name could not be read clearly");
  }
  if (!parsed.dateOfBirth) {
    validationIssues.push("Date of birth not detected");
  }
  if (!parsed.expiryDate) {
    validationIssues.push("Expiry date not detected");
  } else {
    const todayIso = new Date().toISOString().slice(0, 10);
    if (parsed.expiryDate < todayIso) {
      validationIssues.push(`Document expired on ${parsed.expiryDate}`);
    }
  }

  // Dynamic confidence per scan: blends actual Tesseract confidence, extracted fields, and MRZ check ratio
  let fieldRatio = 0;
  if (parsed.docNumber.length >= 6) fieldRatio += 0.35;
  if (parsed.fullName.length >= 3) fieldRatio += 0.35;
  if (parsed.dateOfBirth) fieldRatio += 0.15;
  if (parsed.expiryDate) fieldRatio += 0.15;

  const checkRatio =
    parsed.checkAttempts > 0 ? parsed.checkMatches / parsed.checkAttempts : 0.5;

  const dynamicConfidence = Number(
    Math.min(
      Math.max(rawTesseractConf * 0.4 + fieldRatio * 0.4 + checkRatio * 0.2, 0.05),
      0.99
    ).toFixed(4)
  );

  return {
    rawText,
    fullName: parsed.fullName || "UNREADABLE_NAME",
    docNumber: parsed.docNumber || "UNREADABLE_ID",
    nationality: parsed.nationality,
    dateOfBirth: parsed.dateOfBirth || "",
    expiryDate: parsed.expiryDate || "",
    mrzCheckValid: parsed.mrzCheckValid,
    ocrConfidence: dynamicConfidence,
    isValidData: validationIssues.length === 0,
    validationIssues,
  };
}