import sharp from "sharp";
import { createWorker, Worker } from "tesseract.js";

export interface ExtractedIdFields {
  rawText: string;
  khmerName: string;
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

const KHMER_DIGITS_MAP: Record<string, string> = {
  "០": "0",
  "១": "1",
  "២": "2",
  "៣": "3",
  "៤": "4",
  "៥": "5",
  "៦": "6",
  "៧": "7",
  "៨": "8",
  "៩": "9",
};

function normalizeKhmerDigits(input: string): string {
  return input.replace(/[០-៩]/g, (ch) => KHMER_DIGITS_MAP[ch] ?? ch);
}

let cachedWorker: Worker | null = null;
let workerInitPromise: Promise<Worker> | null = null;

async function getDualLangWorker(): Promise<Worker> {
  if (cachedWorker) return cachedWorker;
  if (!workerInitPromise) {
    workerInitPromise = (async () => {
      // Loads Central Khmer (khm) + English (eng) together
      const worker = await createWorker("khm+eng");
      await worker.setParameters({
        tessedit_pageseg_mode: "3" as any,
      });
      cachedWorker = worker;
      return worker;
    })();
  }
  return workerInitPromise;
}

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

  const curYy = new Date().getFullYear() % 100;
  const fullYear = assumeExpiry
    ? 2000 + yy
    : yy > curYy
    ? 1900 + yy
    : 2000 + yy;

  return `${fullYear}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
}

function extractDynamicFields(rawText: string, docType: string) {
  const normalizedAll = normalizeKhmerDigits(rawText);
  const lines = rawText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const normLines = normalizedAll
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  // 1. Extract Khmer holder name dynamically from Khmer script lines (U+1780..U+17FF)
  let khmerName = "";
  for (const line of lines) {
    if (!/[\u1780-\u17FF]/.test(line)) continue;
    // Match after Khmer label like គោត្តនាមនិងនាម: or នាម:
    const labeledMatch = line.match(/(?:គោត្តនាមនិងនាម|នាម|ឈ្មោះ)[:：\s]*([\u1780-\u17FF\s]{2,40})/);
    if (labeledMatch) {
      khmerName = labeledMatch[1].replace(/\s+/g, " ").trim();
      break;
    }
  }
  if (!khmerName) {
    for (const line of lines) {
      const khOnly = line
        .replace(/[^\u1780-\u17FF\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      const words = khOnly.split(/\s+/).filter(Boolean);
      if (
        words.length >= 2 &&
        words.length <= 4 &&
        !/ព្រះរាជាណាចក្រ|កម្ពុជា|អត្តសញ្ញាណប័ណ្ណ|សុពលភាព|ថ្ងៃខែឆ្នាំកំណើត​|ទីកន្លែងកំណើត|អាសយដ្ឋាន|ភេទ|កំពស់/.test(khOnly)
      ) {
        khmerName = khOnly;
        break;
      }
    }
  }

  // 2. Extract MRZ lines (TD1 3-line Cambodian ID or TD3 2-line Passport)
  const mrzLines = normLines
    .map((l) => l.replace(/\s+/g, "").replace(/[«»]/g, "<").toUpperCase())
    .filter((l) => l.includes("<") && l.length >= 20);

  let fullName = "";
  let docNumber = "";
  let nationality = "";
  let dateOfBirth = "";
  let expiryDate = "";
  let checkMatches = 0;
  let checkAttempts = 0;

  const td1Start = mrzLines.findIndex((l) => /^I[D0O]/.test(l));
  if (td1Start !== -1 && mrzLines.length >= td1Start + 3) {
    const l1 = mrzLines[td1Start];
    const l2 = mrzLines[td1Start + 1];
    const l3 = mrzLines[td1Start + 2];

    nationality = l1.slice(2, 5).replace(/</g, "").replace(/[^A-Z]/g, "") || "KHM";

    const docRaw = l1.slice(5, 14).replace(/</g, "").replace(/[^A-Z0-9]/g, "");
    const docCheck = l1[14] ?? "";
    if (docRaw.length >= 6) {
      docNumber = docRaw;
      if (/[0-9]/.test(docCheck)) {
        checkAttempts++;
        if (mrzCheckDigit(l1.slice(5, 14)) === docCheck) checkMatches++;
      }
    }

    const dobRaw = l2.slice(0, 6);
    const dobCheck = l2[6] ?? "";
    const expRaw = l2.slice(8, 14);
    const expCheck = l2[14] ?? "";

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

    if (!dateOfBirth || !expiryDate) {
      const sixDigitDates = (l2.match(/\d{6}/g) ?? [])
        .map((d) => toIsoDateFromMrz(d, false))
        .filter((d): d is string => Boolean(d))
        .sort();
      if (!dateOfBirth && sixDigitDates.length >= 1) dateOfBirth = sixDigitDates[0];
      if (!expiryDate && sixDigitDates.length >= 2) expiryDate = sixDigitDates[sixDigitDates.length - 1];
    }

    const [surnamePart, givenPart] = l3.split("<<");
    fullName = `${cleanMrzSegment(surnamePart ?? "")} ${cleanMrzSegment(givenPart ?? "")}`.trim();
  }

  const td3Start = mrzLines.findIndex((l) => /^P</.test(l));
  if (!docNumber && td3Start !== -1 && mrzLines.length >= td3Start + 2) {
    const l1 = mrzLines[td3Start];
    const l2 = mrzLines[td3Start + 1];

    nationality = l1.slice(2, 5).replace(/</g, "").replace(/[^A-Z]/g, "") || "INT";
    const [surnamePart, givenPart] = l1.slice(5).split("<<");
    fullName = `${cleanMrzSegment(surnamePart ?? "")} ${cleanMrzSegment(givenPart ?? "")}`.trim();

    const docRaw = l2.slice(0, 9).replace(/</g, "").replace(/[^A-Z0-9]/g, "");
    const docCheck = l2[9] ?? "";
    if (docRaw.length >= 6) {
      docNumber = docRaw;
      if (/[0-9]/.test(docCheck)) {
        checkAttempts++;
        if (mrzCheckDigit(l2.slice(0, 9)) === docCheck) checkMatches++;
      }
    }

    const dobRaw = l2.slice(13, 19);
    const dobCheck = l2[19] ?? "";
    const expRaw = l2.slice(21, 27);
    const expCheck = l2[27] ?? "";

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

  // 3. Printed text & date fallbacks (supports DD/MM/YYYY, DD-MM-YYYY, and YYYY-MM-DD)
  if (!docNumber) {
    const numMatch = normalizedAll.match(/\b([A-Z]{1,2}\d{6,9}|0\d{8}|\d{8,12})\b/);
    if (numMatch) docNumber = numMatch[1];
  }

  if (!fullName) {
    const latinCandidate = normLines.find(
      (line) =>
        /^[A-Z]{2,}(?:\s+[A-Z]{2,}){1,4}$/.test(line) &&
        !/KINGDOM|PASSPORT|IDENTITY|CARD|NATIONAL|CAMBODIA|KHMER|MINISTRY|INTERIOR|SURNAME|GIVEN/.test(
          line.toUpperCase()
        )
    );
    if (latinCandidate) fullName = latinCandidate;
  }

  if (!fullName && khmerName) {
    fullName = khmerName;
  }

  if (!nationality) {
    const natMatch = normalizedAll.match(/\b(KHM|USA|GBR|FRA|THA|VNM|CHN|JPN|KOR)\b/i);
    nationality = natMatch ? natMatch[1].toUpperCase() : docType === "NATIONAL_ID" ? "KHM" : "INT";
  }

  const collectedIsoDates: string[] = [];
  for (const m of normalizedAll.matchAll(/\b(0[1-9]|[12]\d|3[01])[/.-](0[1-9]|1[0-2])[/.-](19\d{2}|20\d{2})\b/g)) {
    collectedIsoDates.push(`${m[3]}-${m[2]}-${m[1]}`);
  }
  for (const m of normalizedAll.matchAll(/\b(19\d{2}|20\d{2})[-/.](0[1-9]|1[0-2])[-/.](0[1-9]|[12]\d|3[01])\b/g)) {
    collectedIsoDates.push(`${m[1]}-${m[2]}-${m[3]}`);
  }
  const sortedDates = [...new Set(collectedIsoDates)].sort();

  if (!dateOfBirth && sortedDates.length >= 1) dateOfBirth = sortedDates[0];
  if (!expiryDate && sortedDates.length >= 2) expiryDate = sortedDates[sortedDates.length - 1];

  const mrzCheckValid = checkAttempts > 0 && checkMatches === checkAttempts;

  return {
    khmerName,
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
    .resize({ width: 1500, withoutEnlargement: true })
    .grayscale()
    .normalize()
    .sharpen()
    .toBuffer();

  const worker = await getDualLangWorker();
  const { data } = await worker.recognize(preprocessed);

  const rawText = (data.text ?? "").trim();
  const rawConf = Math.min(Math.max((data.confidence ?? 0) / 100, 0), 1);
  const parsed = extractDynamicFields(rawText, docType);

  const validationIssues: string[] = [];
  if (!parsed.docNumber || parsed.docNumber.length < 6) {
    validationIssues.push("Document number not clearly detected");
  }
  if (!parsed.fullName || parsed.fullName.length < 2) {
    validationIssues.push("Holder name not clearly detected");
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

  let fieldRatio = 0;
  if (parsed.docNumber.length >= 6) fieldRatio += 0.3;
  if (parsed.fullName.length >= 2) fieldRatio += 0.25;
  if (parsed.khmerName) fieldRatio += 0.15;
  if (parsed.dateOfBirth) fieldRatio += 0.15;
  if (parsed.expiryDate) fieldRatio += 0.15;

  const checkRatio =
    parsed.checkAttempts > 0 ? parsed.checkMatches / parsed.checkAttempts : 0.5;

  const dynamicConfidence = Number(
    Math.min(
      Math.max(rawConf * 0.4 + fieldRatio * 0.4 + checkRatio * 0.2, 0.05),
      0.99
    ).toFixed(4)
  );

  return {
    rawText,
    khmerName: parsed.khmerName,
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