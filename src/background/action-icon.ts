// AUTHORED-BY Claude Opus 4.8
/**
 * The pinned top-right toolbar identity: the `chrome.action` icon becomes the signed-in
 * WebID's avatar (the profile photo, or coloured initials), plus a status badge. Rendered
 * off-DOM with `OffscreenCanvas` (a service worker has no `document`), then handed to
 * `chrome.action.setIcon` as `ImageData`.
 *
 * Fail-soft: any failure (no canvas, an un-fetchable/cross-origin photo) falls back to
 * initials, and ultimately to the bundled default icon — the toolbar entry is never left
 * broken. The badge is a tiny dot indicating signed-in (green) / signed-out (cleared).
 */

import { initials } from '@jeswr/solid-elements';

const SIZES = [16, 32, 48, 128] as const;

/** A deterministic accent colour derived from a string (stable per WebID). */
function colorFor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  const hue = hash % 360;
  return `hsl(${hue} 62% 48%)`;
}

function drawInitials(size: number, name: string, seed: string): ImageData {
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('No 2d context');
  ctx.fillStyle = colorFor(seed);
  // a filled rounded square
  const r = size * 0.22;
  ctx.beginPath();
  ctx.roundRect(0, 0, size, size, r);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.font = `${Math.round(size * 0.46)}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(initials(name) || 'S', size / 2, size / 2 + size * 0.02);
  return ctx.getImageData(0, 0, size, size);
}

async function drawPhoto(size: number, photoUrl: string): Promise<ImageData> {
  const response = await fetch(photoUrl);
  if (!response.ok) throw new Error(`photo ${response.status}`);
  const blob = await response.blob();
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('No 2d context');
  // circular crop
  ctx.save();
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
  ctx.clip();
  // cover-fit
  const scale = Math.max(size / bitmap.width, size / bitmap.height);
  const w = bitmap.width * scale;
  const h = bitmap.height * scale;
  ctx.drawImage(bitmap, (size - w) / 2, (size - h) / 2, w, h);
  ctx.restore();
  bitmap.close();
  return ctx.getImageData(0, 0, size, size);
}

/**
 * Set the toolbar action icon to the signed-in user's avatar (photo → initials fallback)
 * and a green status dot. Best-effort: failures leave the previous/default icon intact.
 */
export async function setSignedInIcon(profile: {
  webId: string;
  name: string | null;
  photoUrl: string | null;
}): Promise<void> {
  const label = profile.name ?? profile.webId;
  const imageData: Record<number, ImageData> = {};

  for (const size of SIZES) {
    try {
      imageData[size] = profile.photoUrl
        ? await drawPhoto(size, profile.photoUrl)
        : drawInitials(size, label, profile.webId);
    } catch {
      // photo fetch/decoder failed for this size — fall back to initials.
      try {
        imageData[size] = drawInitials(size, label, profile.webId);
      } catch {
        // canvas unavailable entirely — leave the default bundled icon.
        return;
      }
    }
  }

  try {
    await chrome.action.setIcon({ imageData });
    await chrome.action.setBadgeBackgroundColor({ color: '#2e9e57' });
    await chrome.action.setBadgeText({ text: ' ' });
    await chrome.action.setTitle({ title: `Signed in as ${label}` });
  } catch {
    // ignore — icon update is cosmetic.
  }
}

/** Reset the action icon + badge to the signed-out (default) state. */
export async function setSignedOutIcon(): Promise<void> {
  try {
    await chrome.action.setIcon({
      path: {
        16: 'icons/icon16.png',
        32: 'icons/icon32.png',
        48: 'icons/icon48.png',
        128: 'icons/icon128.png',
      },
    });
    await chrome.action.setBadgeText({ text: '' });
    await chrome.action.setTitle({ title: 'Sign in to Solid' });
  } catch {
    // ignore.
  }
}
