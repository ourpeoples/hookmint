/**
 * What each ad platform needs from a video, as a small set of defaults. They are starting points drawn from public platform
 * guidance, not guarantees: change a number here and bump PLATFORM_RULES_VERSION so results from before the change stay
 * separate from results after it.
 */
export const PLATFORMS = ["tiktok", "meta", "youtube"] as const;
export type Platform = (typeof PLATFORMS)[number];

export const PLATFORM_RULES_VERSION = 1;

export interface PlatformRules {
  label: string;
  /** The seconds a viewer gives the opening before deciding to stay or scroll. The hook has to land inside them. */
  hook_window_s: number;
  /** The longest video worth making for the placement. */
  max_duration_s: number;
  /** Feeds that start muted or reward text on screen need words in the picture, not only in the voice. */
  text_overlay_required: boolean;
}

export const PLATFORM_RULES: Record<Platform, PlatformRules> = {
  tiktok: { label: "TikTok", hook_window_s: 1, max_duration_s: 60, text_overlay_required: true },
  meta: { label: "Meta (Instagram Reels and Facebook)", hook_window_s: 3, max_duration_s: 30, text_overlay_required: true },
  youtube: { label: "YouTube Shorts", hook_window_s: 5, max_duration_s: 60, text_overlay_required: false },
};
