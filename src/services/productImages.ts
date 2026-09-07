// Product photos for reports.
//
// Line items carry a full-size WooCommerce image URL (~200 KB, 1000x1280). A
// report can reference the same photo hundreds of times but only uses a ~40pt
// thumbnail, so each distinct URL is fetched once, downscaled, and cached on
// disk. A report of 900 orders touches roughly 90 distinct photos.
//
// Photos are decoration: any fetch that fails or times out yields null and the
// report renders that row without an image rather than failing.

import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";

/** Thumbnail width in pixels: ~3x the 40pt draw size, so print stays sharp. */
const THUMB_WIDTH = 120;
const FETCH_TIMEOUT_MS = 8000;
const MAX_CONCURRENT = 6;
/** Guard against a mis-sized asset filling memory. */
const MAX_BYTES = 12 * 1024 * 1024;

const CACHE_DIR = path.join(os.tmpdir(), "flowpulse-report-thumbs");

/** Process-lifetime cache, so one report never fetches a URL twice. */
const memory = new Map<string, Buffer | null>();

function cacheKey(url: string): string {
  return crypto.createHash("sha1").update(url).digest("hex") + ".jpg";
}

async function fromDisk(url: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(path.join(CACHE_DIR, cacheKey(url)));
  } catch {
    return null;
  }
}

async function toDisk(url: string, data: Buffer): Promise<void> {
  try {
    await fs.mkdir(CACHE_DIR, { recursive: true });
    await fs.writeFile(path.join(CACHE_DIR, cacheKey(url)), data);
  } catch {
    // A read-only or full disk just means we re-fetch next time.
  }
}

async function fetchThumbnail(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: "follow",
    });
    if (!res.ok) return null;
    const raw = Buffer.from(await res.arrayBuffer());
    if (raw.length === 0 || raw.length > MAX_BYTES) return null;
    return await sharp(raw)
      .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
      .jpeg({ quality: 72 })
      .toBuffer();
  } catch {
    return null;
  }
}

/**
 * Fetch and cache thumbnails for every distinct URL, a few at a time.
 * The returned map holds a JPEG buffer per URL that resolved, and nothing for
 * URLs that failed.
 */
export async function loadThumbnails(
  urls: Iterable<string>
): Promise<Map<string, Buffer>> {
  const wanted = [...new Set([...urls].filter((u) => /^https?:\/\//i.test(u)))];
  const out = new Map<string, Buffer>();

  const pending: string[] = [];
  for (const url of wanted) {
    const cached = memory.get(url);
    if (cached !== undefined) {
      if (cached) out.set(url, cached);
      continue;
    }
    pending.push(url);
  }

  let next = 0;
  const workers = Array.from(
    { length: Math.min(MAX_CONCURRENT, pending.length) },
    async () => {
      while (next < pending.length) {
        const url = pending[next++];
        let thumb = await fromDisk(url);
        if (!thumb) {
          thumb = await fetchThumbnail(url);
          if (thumb) await toDisk(url, thumb);
        }
        memory.set(url, thumb);
        if (thumb) out.set(url, thumb);
      }
    }
  );
  await Promise.all(workers);

  return out;
}
