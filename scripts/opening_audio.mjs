import fs from "node:fs";
import path from "node:path";

/**
 * The flash segment historically reused one path for both the video and its
 * audio. media-use can supply a dedicated SFX, so video and audio bind
 * separately while projects without `opening.flashSfx` keep the legacy path.
 */
export function resolveFlashTracks(spec) {
  const video = spec.opening?.flashMedia;
  if (!video) throw new Error("PROJECT_SPEC.opening.flashMedia is required");
  const audio = spec.opening?.flashSfx ?? video;
  return { video, audio };
}

export function assertFlashTracksExist(root, tracks) {
  for (const [label, relative] of Object.entries(tracks)) {
    const absolute = path.resolve(root, relative);
    if (!fs.existsSync(absolute)) {
      throw new Error(`PROJECT_SPEC.opening.${label === "video" ? "flashMedia" : "flashSfx"} is missing: ${absolute}`);
    }
  }
}
