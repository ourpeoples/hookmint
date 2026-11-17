import sharp from "sharp";
import { AdError } from "../core/errors.js";

sharp.cache(false); // do not keep decoded untrusted images in memory

export interface ImageLimits {
  /** Refuse inputs with more pixels than this before decoding them (protects memory). */
  maxInputPixels: number;
  /** The longest side of the stored image. Larger images are scaled down. */
  maxSide: number;
  /** Refuse to store anything larger than this. */
  maxOutputBytes: number;
}

export const LOGO_LIMITS: ImageLimits = { maxInputPixels: 16_777_216, maxSide: 1024, maxOutputBytes: 1_000_000 };
export const PHOTO_LIMITS: ImageLimits = { maxInputPixels: 50_000_000, maxSide: 2160, maxOutputBytes: 10_000_000 };

/** Only these input formats are accepted. sharp can read many more (SVG, GIF, TIFF, PDF...), so this is an explicit allow-list. */
const ALLOWED = new Set(["png", "jpeg", "webp"]);
const NOT_AN_IMAGE = () => new AdError("invalid_input", "That file is not a readable PNG, JPEG or WebP image.");

export interface CleanImage {
  bytes: Buffer;
  width: number;
  height: number;
  format: "png" | "jpeg";
}

/**
 * Decodes an untrusted image and writes a fresh one. Re-encoding drops everything that was not pixels
 * (metadata, embedded profiles, trailing data, polyglot payloads). Logos become PNG so transparency survives;
 * photos become JPEG unless they have transparency.
 */
export async function sanitizeImage(input: Buffer, kind: "logo" | "photo", limits: ImageLimits = kind === "logo" ? LOGO_LIMITS : PHOTO_LIMITS): Promise<CleanImage> {
  try {
    const img = sharp(input, { limitInputPixels: limits.maxInputPixels, failOn: "error", animated: false });
    const meta = await img.metadata();
    if (!meta.format || !ALLOWED.has(meta.format)) {
      throw new AdError("invalid_input", `That image format${meta.format ? ` (${meta.format})` : ""} is not accepted. Use PNG, JPEG or WebP.`);
    }
    if ((meta.pages ?? 1) > 1) throw new AdError("invalid_input", "Animated images are not accepted.");
    if (!meta.width || !meta.height || meta.width < 16 || meta.height < 16) throw new AdError("invalid_input", "That image is too small to use (at least 16 pixels on each side).");

    let pipeline = img.rotate().resize({ width: limits.maxSide, height: limits.maxSide, fit: "inside", withoutEnlargement: true }).toColourspace("srgb");
    const asPng = kind === "logo" || meta.hasAlpha;
    pipeline = asPng ? pipeline.png({ compressionLevel: 9 }) : pipeline.jpeg({ quality: 88 });
    const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
    if (data.length > limits.maxOutputBytes) throw new AdError("invalid_input", "That image is too large once processed.");
    return { bytes: data, width: info.width, height: info.height, format: asPng ? "png" : "jpeg" };
  } catch (err) {
    if (err instanceof AdError) throw err;
    throw NOT_AN_IMAGE(); // decoder messages can describe internals; give the user a plain one
  }
}
