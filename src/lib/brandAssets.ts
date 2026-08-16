/**
 * Where an uploaded brand mark is stored, and what is allowed to be one.
 *
 * ## Reusing the bucket that already has the right policies
 *
 * There is no new bucket here, and there is no migration. `product-assets` is
 * already public-read, already restricted on write to
 * `bucket_id = 'product-assets' and public.is_staff_user()`, and already the
 * host for every photograph this business owns. A logo is the same kind of
 * object with the same audience — world-readable, staff-writable — so a second
 * bucket would have been a second set of policies to keep in step with the
 * first, for no property the first does not have.
 *
 * Brand marks live under a `brand/` prefix. The bucket's policies do not
 * constrain the prefix (unlike `avatars`, whose first path segment *is* the
 * check), so the prefix is organisational rather than load-bearing — but the
 * route that writes here still builds the key itself from a fixed slot name and
 * a sniffed extension, so a request cannot choose its own path.
 *
 * ## One object per slot
 *
 * The key is `brand/<slot>.<ext>` — stable, not timestamped. This is the same
 * reasoning `avatars.ts` records: a timestamped key leaves the previous object
 * behind on every change, and cleaning those up is a delete that can fail
 * silently. Overwriting one key means replacement needs nothing to be deleted
 * in the common case, and the only orphan possible is the *previous format* of
 * the same slot, which is a known, enumerable list of two other keys.
 *
 * The cost is caching, handled the same way: the stored URL carries a version
 * query, so what changes when a logo is replaced is the URL the settings point
 * at rather than anything about the object.
 *
 * ## Why SVG is refused
 *
 * An SVG is a document, not a bitmap. It can carry `<script>`, external
 * references and event handlers, and it would be served from the same origin as
 * the storefront out of a world-readable bucket. Making it safe means parsing
 * and sanitising it on upload and re-sanitising on every read, which is a real
 * subsystem, not a checkbox. The bucket does not list `image/svg+xml` among its
 * allowed types either, so this refusal agrees with the storage layer rather
 * than fighting it.
 */

export const BRAND_BUCKET = "product-assets";

/**
 * Every slot this site will store an owner-uploaded image into.
 *
 * `homepage-hero` joined the two logo slots rather than getting a pipeline of
 * its own. The brief for this pass asked for homepage imagery that does not
 * require pasting an external URL, and the property that makes *this* route safe
 * — the storage key is built from a name off this list and an extension sniffed
 * from the bytes, so nothing the request supplies reaches the path — is a
 * property of the list, not of logos. A second upload endpoint would have been a
 * second set of those decisions to keep in step.
 *
 * The slots differ only in what counts as a reasonable file, which is
 * `SLOT_POLICY` below and not a separate code path.
 */
export const BRAND_SLOTS = ["primary", "alternate", "homepage-hero"] as const;
export type BrandSlot = (typeof BRAND_SLOTS)[number];

/**
 * What may be uploaded as a brand mark.
 *
 * A subset of what the bucket allows. AVIF is missing on purpose: it is an
 * ISOBMFF container, so reading its dimensions means walking boxes rather than
 * reading a fixed header, and a logo gains nothing from it that WebP does not
 * already give. Refusing a format is reversible; shipping one we cannot
 * validate is not.
 */
export const BRAND_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export type BrandMimeType = (typeof BRAND_MIME_TYPES)[number];

/**
 * 2 MB. The bucket's own ceiling is 50 MB, which is right for a product
 * photograph and absurd for a mark that renders at 40 CSS pixels. The header
 * loads this file on every page of the site.
 */
export const BRAND_MAX_BYTES = 2 * 1024 * 1024;

/** Below this in either axis a mark is too small to render crisply at 2×. */
export const BRAND_MIN_DIMENSION = 32;
/** Above this it is a photograph somebody has mistaken for a logo. */
export const BRAND_MAX_DIMENSION = 4096;

export type SlotPolicy = {
  /** What the owner calls this slot, for messages and the audit log. */
  label: string;
  maxBytes: number;
  minDimension: number;
};

/**
 * What counts as a reasonable file for each slot.
 *
 * A logo and a hero photograph are the same kind of object to the storage layer
 * and completely different objects to a person. A 900 KB mark is suspicious; a
 * 900 KB hero is normal. A 64px mark is fine; a 64px hero is a thumbnail
 * somebody grabbed by mistake, and accepting it means the homepage ships
 * blurred and nobody is told why.
 *
 * So the limits are per slot and the *checks* are not: every slot goes through
 * the same sniff, the same header read and the same refusals, which is the part
 * that has to be identical.
 */
export const SLOT_POLICY: Readonly<Record<BrandSlot, SlotPolicy>> = {
  primary: { label: "Primary logo", maxBytes: BRAND_MAX_BYTES, minDimension: BRAND_MIN_DIMENSION },
  alternate: { label: "Alternate logo", maxBytes: BRAND_MAX_BYTES, minDimension: BRAND_MIN_DIMENSION },
  "homepage-hero": {
    label: "Homepage hero image",
    // Four times the logo ceiling. This renders full-bleed above the fold, so it
    // is the one image on the site where a photograph's own weight is the point.
    maxBytes: 4 * 1024 * 1024,
    // Narrower than this and it is upscaled across the hero frame on every
    // laptop, which reads as a broken image rather than as a small one.
    minDimension: 600,
  },
};

const EXTENSIONS: Readonly<Record<BrandMimeType, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

export function isBrandSlot(value: unknown): value is BrandSlot {
  return typeof value === "string" && (BRAND_SLOTS as readonly string[]).includes(value);
}

/**
 * The real type of the bytes, ignoring whatever the request claimed.
 *
 * `File.type` on a multipart upload is supplied by the client and is not
 * evidence of anything — it is the browser repeating the file's extension back,
 * and a script posting the form can put any string there. Every check that
 * matters runs against these leading bytes instead.
 *
 * Returns null when the bytes are not one of the three formats, which is what
 * makes "renamed .exe" and "polyglot" refusals fall out of the same test rather
 * than needing their own.
 */
export function sniffBrandImageType(bytes: Uint8Array): BrandMimeType | null {
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return "image/png";
  }

  // JPEG: FF D8 FF
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }

  // WebP: "RIFF" .... "WEBP"
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return "image/webp";
  }

  return null;
}

export type ImageDimensions = { width: number; height: number };

/**
 * Pixel dimensions read straight out of the header.
 *
 * Null when they cannot be determined — a truncated file, or a WebP in a
 * variant this does not decode. The caller treats null as "cannot verify" and
 * refuses, rather than as "fine", because the whole point of the check is that
 * an unreadable header is itself a reason to be suspicious.
 */
export function readImageDimensions(bytes: Uint8Array, type: BrandMimeType): ImageDimensions | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  if (type === "image/png") {
    // IHDR is always the first chunk: width at byte 16, height at 20, big-endian.
    if (bytes.length < 24) return null;
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }

  if (type === "image/jpeg") {
    // Walk the marker segments to the start-of-frame, which carries the size.
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) return null;
      const marker = bytes[offset + 1];
      // SOF0..SOF15, excluding the four that are not frame headers.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) };
      }
      offset += 2 + view.getUint16(offset + 2);
    }
    return null;
  }

  // WebP: the format byte follows the "WEBP" tag. Lossy, lossless and extended
  // each store the size differently, and all three are common enough that
  // handling only one would refuse ordinary exports.
  if (bytes.length < 30) return null;
  const format = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);

  if (format === "VP8 ") {
    // 14 bits each, following a 3-byte start code and a 3-byte sync code.
    return {
      width: view.getUint16(26, true) & 0x3fff,
      height: view.getUint16(28, true) & 0x3fff,
    };
  }
  if (format === "VP8L") {
    // 14 bits each, packed across four little-endian bytes after the signature.
    const bits = view.getUint32(21, true);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (format === "VP8X") {
    // 24-bit little-endian, stored one less than the real value.
    const width = bytes[24] | (bytes[25] << 8) | (bytes[26] << 16);
    const height = bytes[27] | (bytes[28] << 8) | (bytes[29] << 16);
    return { width: width + 1, height: height + 1 };
  }

  return null;
}

/**
 * The storage key for a slot.
 *
 * Both halves come from values this module owns — a slot from a fixed list and
 * an extension from a sniffed type — so nothing a request supplies reaches the
 * path. That is deliberate: `avatars.ts` records the same rule for the same
 * reason, and there the path segment is a policy check.
 */
export function brandObjectKey(slot: BrandSlot, type: BrandMimeType): string {
  return `brand/${slot}.${EXTENSIONS[type]}`;
}

/** Every key this slot could occupy, for clearing a stale format after a swap. */
export function brandObjectKeysFor(slot: BrandSlot): string[] {
  return BRAND_MIME_TYPES.map((type) => brandObjectKey(slot, type));
}

/** A stored brand URL with a cache-busting version, for the stable-key reason above. */
export function versionedBrandUrl(publicUrl: string, at: number = Date.now()): string {
  const separator = publicUrl.includes("?") ? "&" : "?";
  return `${publicUrl}${separator}v=${at}`;
}

export type BrandUploadCheck =
  | { ok: true; type: BrandMimeType; dimensions: ImageDimensions }
  | { ok: false; error: string };

/**
 * Every check an uploaded image has to pass, in one place.
 *
 * Ordered so the message names the first real problem: size before format,
 * because a 40 MB file that is also a GIF should be told it is too large rather
 * than sent away to convert it and hit the size limit on the second try.
 *
 * `slot` selects the limits and nothing else. The sniff, the header read and
 * every refusal below are the same whichever slot is being written — a hero
 * image is served from the same world-readable bucket on the same origin as the
 * logo, so relaxing any of them for the larger file would relax them for the
 * threat too.
 */
export function checkBrandUpload(
  bytes: Uint8Array,
  declaredSize: number,
  slot: BrandSlot = "primary"
): BrandUploadCheck {
  const policy = SLOT_POLICY[slot];

  if (declaredSize === 0 || bytes.length === 0) {
    return { ok: false, error: "That file is empty." };
  }
  if (declaredSize > policy.maxBytes || bytes.length > policy.maxBytes) {
    const mb = Math.round(policy.maxBytes / (1024 * 1024));
    return { ok: false, error: `That file is too large. Please use one under ${mb} MB.` };
  }

  const type = sniffBrandImageType(bytes);
  if (!type) {
    return {
      ok: false,
      error: "Please upload a PNG, JPEG, or WebP image. SVG and other formats are not accepted.",
    };
  }

  const dimensions = readImageDimensions(bytes, type);
  if (!dimensions || !dimensions.width || !dimensions.height) {
    return { ok: false, error: "That image could not be read. Try re-exporting it." };
  }
  if (dimensions.width < policy.minDimension || dimensions.height < policy.minDimension) {
    return {
      ok: false,
      error: `That image is ${dimensions.width}×${dimensions.height}. ${policy.label} needs to be at least ${policy.minDimension}px on each side.`,
    };
  }
  if (dimensions.width > BRAND_MAX_DIMENSION || dimensions.height > BRAND_MAX_DIMENSION) {
    return {
      ok: false,
      error: `That image is ${dimensions.width}×${dimensions.height}. Please use something no larger than ${BRAND_MAX_DIMENSION}px on a side.`,
    };
  }

  return { ok: true, type, dimensions };
}

/**
 * Whether an asset is one this application stored and may therefore delete.
 *
 * Guards the cleanup path. The shipped marks live in `public/brand/` and are
 * referenced by `site.config.ts` as the build-time fallback, so they are not
 * ours to remove; neither is a URL an owner pasted from somewhere else. Only an
 * object under this bucket's `brand/` prefix qualifies.
 */
export function isManagedBrandAsset(url: string): boolean {
  return /\/storage\/v1\/object\/public\/product-assets\/brand\//.test(url);
}
