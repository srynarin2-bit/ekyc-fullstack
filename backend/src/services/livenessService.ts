import sharp from "sharp";

export interface LivenessAnalysisResult {
  livenessPassed: boolean;
  livenessScore: number;
  faceMatchScore: number;
  notes: string;
}

async function getGrayGrid(filePath: string, w = 64, h = 64): Promise<Uint8Array> {
  const buf = await sharp(filePath)
    .rotate()
    .resize(w, h, { fit: "cover" })
    .grayscale()
    .raw()
    .toBuffer();
  return new Uint8Array(buf);
}

async function getFacePatch(
  imagePath: string,
  box: { left: number; top: number; width: number; height: number }
): Promise<{ gray: Float32Array; hist: Float32Array }> {
  const meta = await sharp(imagePath).rotate().metadata();
  const imgW = meta.width ?? 1000;
  const imgH = meta.height ?? 800;

  const left = Math.max(0, Math.min(Math.floor(imgW * box.left), imgW - 40));
  const top = Math.max(0, Math.min(Math.floor(imgH * box.top), imgH - 40));
  const width = Math.max(40, Math.min(Math.floor(imgW * box.width), imgW - left));
  const height = Math.max(40, Math.min(Math.floor(imgH * box.height), imgH - top));

  const base = sharp(imagePath)
    .rotate()
    .extract({ left, top, width, height })
    .resize(48, 48, { fit: "fill" });

  const [grayRaw, rgbRaw] = await Promise.all([
    base.clone().grayscale().normalize().raw().toBuffer(),
    base.clone().removeAlpha().raw().toBuffer(),
  ]);

  const gray = new Float32Array(grayRaw.length);
  for (let i = 0; i < grayRaw.length; i++) gray[i] = grayRaw[i];

  const bins = 8;
  const hist = new Float32Array(bins * 3);
  const totalPixels = rgbRaw.length / 3;
  for (let i = 0; i < rgbRaw.length; i += 3) {
    const r = Math.min(bins - 1, Math.floor((rgbRaw[i] / 256) * bins));
    const g = Math.min(bins - 1, Math.floor((rgbRaw[i + 1] / 256) * bins));
    const b = Math.min(bins - 1, Math.floor((rgbRaw[i + 2] / 256) * bins));
    hist[r] += 1 / totalPixels;
    hist[bins + g] += 1 / totalPixels;
    hist[bins * 2 + b] += 1 / totalPixels;
  }

  return { gray, hist };
}

function cosineSim(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return Math.max(0, Math.min(1, dot / (Math.sqrt(na) * Math.sqrt(nb))));
}

function znccSim(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i];
    mb += b[i];
  }
  ma /= n;
  mb /= n;
  let num = 0;
  let da2 = 0;
  let db2 = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - ma;
    const db = b[i] - mb;
    num += da * db;
    da2 += da * da;
    db2 += db * db;
  }
  const den = Math.sqrt(da2 * db2);
  if (den === 0) return 0;
  return Math.max(0, Math.min(1, (num / den + 1) / 2));
}

export async function analyzeLivenessAndSelfie(
  neutralSelfiePath: string,
  challengeSelfiePath: string,
  idDocPath: string
): Promise<LivenessAnalysisResult> {
  const [neutralGrid, challengeGrid, idPatch, selfiePatch] = await Promise.all([
    getGrayGrid(neutralSelfiePath),
    getGrayGrid(challengeSelfiePath),
    getFacePatch(idDocPath, { left: 0.04, top: 0.16, width: 0.34, height: 0.58 }),
    getFacePatch(neutralSelfiePath, { left: 0.22, top: 0.18, width: 0.56, height: 0.55 }),
  ]);

  let diffSum = 0;
  let brightSum = 0;
  for (let i = 0; i < neutralGrid.length; i++) {
    diffSum += Math.abs(neutralGrid[i] - challengeGrid[i]);
    brightSum += challengeGrid[i];
  }

  const meanMotion = diffSum / neutralGrid.length;
  const meanBrightness = brightSum / challengeGrid.length;

  // Strict liveness: must have real movement between frames (blocks identical static images)
  // and proper exposure (blocks pitch-black or blown-out frames)
  const validLighting = meanBrightness >= 35 && meanBrightness <= 235;
  const validMotion = meanMotion >= 3.5 && meanMotion <= 105;
  const livenessPassed = validLighting && validMotion;

  const livenessScore = livenessPassed
    ? Number(Math.min(0.83 + Math.min(meanMotion, 25) / 170, 0.98).toFixed(4))
    : Number(Math.max(0.1, Math.min(0.45, meanMotion / 12)).toFixed(4));

  const colorSimilarity = cosineSim(idPatch.hist, selfiePatch.hist);
  const structureSimilarity = znccSim(idPatch.gray, selfiePatch.gray);
  const rawMatch = colorSimilarity * 0.65 + structureSimilarity * 0.35;

  const faceMatchScore = Number(Math.min(Math.max(0.2 + rawMatch * 0.76, 0.15), 0.96).toFixed(4));

  return {
    livenessPassed,
    livenessScore,
    faceMatchScore,
    notes: `motion=${meanMotion.toFixed(1)}, brightness=${meanBrightness.toFixed(1)}, color=${colorSimilarity.toFixed(2)}, struct=${structureSimilarity.toFixed(2)}`,
  };
}