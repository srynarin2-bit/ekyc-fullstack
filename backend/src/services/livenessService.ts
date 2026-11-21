import sharp from "sharp";

export interface LivenessAnalysisResult {
  livenessPassed: boolean;
  livenessScore: number;
  faceMatchScore: number;
  notes: string;
}

async function getFrameGrid(filePath: string, w = 64, h = 64): Promise<Uint8Array> {
  const buf = await sharp(filePath)
    .rotate()
    .resize(w, h, { fit: "cover" })
    .grayscale()
    .raw()
    .toBuffer();
  return new Uint8Array(buf);
}

// Extracts a 4x4 spatial grid of normalized brightness + RGB means from a face/portrait region
async function getSpatialPatchSignature(
  imagePath: string,
  box: { left: number; top: number; width: number; height: number }
): Promise<Float32Array> {
  const meta = await sharp(imagePath).rotate().metadata();
  const imgW = meta.width ?? 1000;
  const imgH = meta.height ?? 800;

  const left = Math.max(0, Math.min(Math.floor(imgW * box.left), imgW - 40));
  const top = Math.max(0, Math.min(Math.floor(imgH * box.top), imgH - 40));
  const width = Math.max(40, Math.min(Math.floor(imgW * box.width), imgW - left));
  const height = Math.max(40, Math.min(Math.floor(imgH * box.height), imgH - top));

  const size = 64; // divisible by 4 -> 16x16 per cell across 4x4 grid
  const raw = await sharp(imagePath)
    .rotate()
    .extract({ left, top, width, height })
    .resize(size, size, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer();

  const cells = 4;
  const cellPx = size / cells;
  // 4x4 cells * 3 RGB channels = 48 features
  const sig = new Float32Array(cells * cells * 3);
  let idx = 0;

  for (let cy = 0; cy < cells; cy++) {
    for (let cx = 0; cx < cells; cx++) {
      let rSum = 0;
      let gSum = 0;
      let bSum = 0;
      const count = cellPx * cellPx;

      for (let py = cy * cellPx; py < (cy + 1) * cellPx; py++) {
        for (let px = cx * cellPx; px < (cx + 1) * cellPx; px++) {
          const pIdx = (py * size + px) * 3;
          rSum += raw[pIdx];
          gSum += raw[pIdx + 1];
          bSum += raw[pIdx + 2];
        }
      }

      sig[idx++] = rSum / count / 255;
      sig[idx++] = gSum / count / 255;
      sig[idx++] = bSum / count / 255;
    }
  }

  // Zero-center & normalize signature vector so lighting shifts don't distort cosine distance
  let mean = 0;
  for (let i = 0; i < sig.length; i++) mean += sig[i];
  mean /= sig.length;

  let normSq = 0;
  for (let i = 0; i < sig.length; i++) {
    sig[i] -= mean;
    normSq += sig[i] * sig[i];
  }

  const norm = Math.sqrt(normSq) || 1;
  for (let i = 0; i < sig.length; i++) sig[i] /= norm;

  return sig;
}

function dotProductSimilarity(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < n; i++) dot += a[i] * b[i];
  // Normalized vectors yield dot in [-1, 1]; map to [0, 1]
  return Math.max(0, Math.min(1, (dot + 1) / 2));
}

export async function analyzeLivenessAndSelfie(
  neutralSelfiePath: string,
  challengeSelfiePath: string,
  idDocPath: string
): Promise<LivenessAnalysisResult> {
  const [frame1, frame2, idSig, selfieSig] = await Promise.all([
    getFrameGrid(neutralSelfiePath),
    getFrameGrid(challengeSelfiePath),
    getSpatialPatchSignature(idDocPath, { left: 0.04, top: 0.16, width: 0.34, height: 0.58 }),
    getSpatialPatchSignature(neutralSelfiePath, { left: 0.22, top: 0.18, width: 0.56, height: 0.55 }),
  ]);

  let diffSum = 0;
  let brightSum = 0;
  for (let i = 0; i < frame1.length; i++) {
    diffSum += Math.abs(frame1[i] - frame2[i]);
    brightSum += frame2[i];
  }

  const meanMotion = diffSum / frame1.length;
  const meanBrightness = brightSum / frame1.length;

  // Dynamic liveness validation: blocks static/duplicate photos (meanMotion ~ 0) and dark/glare frames
  const lightingOk = meanBrightness >= 35 && meanBrightness <= 238;
  const motionOk = meanMotion >= 3.0 && meanMotion <= 110;
  const livenessPassed = lightingOk && motionOk;

  const livenessScore = livenessPassed
    ? Number(Math.min(0.8 + Math.min(meanMotion, 30) / 160, 0.98).toFixed(4))
    : Number(Math.max(0.05, Math.min(0.45, meanMotion / 10)).toFixed(4));

  const spatialSim = dotProductSimilarity(idSig, selfieSig);
  const faceMatchScore = Number(Math.min(Math.max(spatialSim, 0.05), 0.99).toFixed(4));

  return {
    livenessPassed,
    livenessScore,
    faceMatchScore,
    notes: `motion=${meanMotion.toFixed(1)}, brightness=${meanBrightness.toFixed(1)}, spatialSim=${spatialSim.toFixed(3)}`,
  };
}