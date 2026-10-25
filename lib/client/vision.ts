// Vision déterministe dans le navigateur : grille de 16 x 9 cases et captures JPEG.
export const GRID_W = 16;
export const GRID_H = 9;
const SAMPLE = 4; // chaque case est la moyenne de 4 x 4 pixels

export type Grid = Float32Array; // luminance moyenne par case, de 0 à 255

let gridCanvas: HTMLCanvasElement | null = null;
let jpegCanvas: HTMLCanvasElement | null = null;

function ready(video: HTMLVideoElement): boolean {
  return video.readyState >= 2 && video.videoWidth > 0;
}

export type Rect = { x: number; y: number; w: number; h: number };

/** La zone analysée, en pixels de la vidéo : toute l'image, la télé peut être n'importe où dedans. */
export function zone(vw: number, vh: number): Rect {
  return { x: 0, y: 0, w: vw, h: vh };
}

/** Réduit l'image en 144 cases de luminance moyenne. */
export function captureGrid(video: HTMLVideoElement): Grid | null {
  if (!ready(video)) return null;
  gridCanvas ??= document.createElement("canvas");
  const w = GRID_W * SAMPLE;
  const h = GRID_H * SAMPLE;
  gridCanvas.width = w;
  gridCanvas.height = h;
  const ctx = gridCanvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  const z = zone(video.videoWidth, video.videoHeight);
  ctx.drawImage(video, z.x, z.y, z.w, z.h, 0, 0, w, h);
  const px = ctx.getImageData(0, 0, w, h).data;
  const grid = new Float32Array(GRID_W * GRID_H);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const lum = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
      grid[Math.floor(y / SAMPLE) * GRID_W + Math.floor(x / SAMPLE)] += lum / (SAMPLE * SAMPLE);
    }
  }
  return grid;
}

/**
 * Part des cases qui ont changé, de 0 à 1.
 * On retire d'abord la variation moyenne, pour ignorer l'exposition automatique de la caméra.
 */
export function gridDiff(a: Grid, b: Grid, threshold = 18): number {
  let mean = 0;
  for (let i = 0; i < a.length; i++) mean += b[i] - a[i];
  mean /= a.length;
  let changed = 0;
  for (let i = 0; i < a.length; i++) if (Math.abs(b[i] - a[i] - mean) > threshold) changed++;
  return changed / a.length;
}

/** Capture JPEG de la zone analysée, en data URL, plus grand côté limité. */
export function captureJpeg(video: HTMLVideoElement, maxWidth: number, quality: number): string | null {
  if (!ready(video)) return null;
  jpegCanvas ??= document.createElement("canvas");
  const z = zone(video.videoWidth, video.videoHeight);
  const scale = Math.min(1, maxWidth / Math.max(z.w, z.h)); // limite le plus grand côté
  jpegCanvas.width = Math.round(z.w * scale);
  jpegCanvas.height = Math.round(z.h * scale);
  const ctx = jpegCanvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(video, z.x, z.y, z.w, z.h, 0, 0, jpegCanvas.width, jpegCanvas.height);
  return jpegCanvas.toDataURL("image/jpeg", quality);
}
