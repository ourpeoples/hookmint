import React, { useEffect, useState } from "react";
import { AbsoluteFill, Audio, cancelRender, continueRender, delayRender, Img, interpolate, OffthreadVideo, Sequence, spring, staticFile, useCurrentFrame } from "remotion";
import { type Aspect, buildTimeline, CAPTION_SCRIM, ctaWindow, FPS, fitText, type PlanLite, pickTextColor, safeRect, sizes } from "../src/render/layout";

export interface MediaRef {
  kind: "image" | "video";
  src: string;
}
export interface AdProps {
  plan: PlanLite;
  aspect: Aspect;
  brand: { name: string; primary: string; secondary: string; logo?: { src: string } };
  /** Media the renderer has already checked and is serving locally. Anything missing falls back to a brand gradient. */
  media: Record<string, { visual?: MediaRef; voice?: { src: string } }>;
  /**
   * Layout probe for tests: black background, every text box drawn solid white, no animation.
   * Anything painted outside the safe area is then easy to find in a still.
   */
  probe?: boolean;
}


function useFonts() {
  const [handle] = useState(() => delayRender("Loading fonts"));
  useEffect(() => {
    Promise.all([
      new FontFace("Inter", `url(${staticFile("fonts/Inter-400.woff2")})`, { weight: "400" }).load(),
      new FontFace("Inter", `url(${staticFile("fonts/Inter-800.woff2")})`, { weight: "800" }).load(),
    ])
      .then((faces) => {
        faces.forEach((f) => (document.fonts as unknown as { add(face: FontFace): void }).add(f));
        continueRender(handle);
      })
      .catch((err) => cancelRender(err));
  }, [handle]);
}

const SceneView: React.FC<{ props: AdProps; index: number; startFrame: number; durationFrames: number }> = ({ props, index, durationFrames }) => {
  const { plan, aspect, brand, media, probe } = props;
  const frame = useCurrentFrame();
  const scene = plan.scenes[index];
  const tl = buildTimeline(plan).scenes[index];
  const rect = safeRect(aspect);
  const s = sizes(aspect);
  const m = media[scene.id];

  const enter = probe ? 1 : spring({ frame, fps: FPS, config: { damping: 200 }, durationInFrames: 12 });
  const exit = probe ? 1 : interpolate(frame, [durationFrames - 6, durationFrames], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const zoom = interpolate(frame, [0, durationFrames], [1, 1.06]);

  const headlineText = tl.onScreenText ?? (tl.isFirst ? plan.hook : null);
  const headline = headlineText ? fitText(headlineText, rect.width, 3, s.headline, s.headlineMin) : null;
  const cta = tl.isLast ? ctaWindow(durationFrames) : null;
  const showCta = !!cta && frame >= cta.startFrame;
  const ctaFit = fitText(plan.cta.text, rect.width - 2 * s.cta, 2, s.cta, Math.round(s.cta * 0.6));
  const ctaText = probe ? "#ffffff" : pickTextColor(brand.primary);
  const white = "#ffffff";

  const clamp = (lines: number): React.CSSProperties => ({ display: "-webkit-box", WebkitLineClamp: lines, WebkitBoxOrient: "vertical", overflow: "hidden" });

  return (
    <AbsoluteFill style={{ background: "#000" }}>
      {!probe && (
        <AbsoluteFill style={{ overflow: "hidden" }}>
          {m?.visual?.kind === "video" ? (
            <OffthreadVideo src={m.visual.src} muted style={{ width: "100%", height: "100%", objectFit: "cover" }} />
          ) : m?.visual?.kind === "image" ? (
            <Img src={m.visual.src} style={{ width: "100%", height: "100%", objectFit: "cover", transform: `scale(${zoom})` }} />
          ) : (
            <AbsoluteFill style={{ background: `linear-gradient(150deg, ${brand.primary} 0%, ${brand.secondary} 100%)`, transform: `scale(${zoom})` }} />
          )}
          <AbsoluteFill style={{ background: "linear-gradient(to bottom, rgba(0,0,0,0.25) 0%, rgba(0,0,0,0) 35%, rgba(0,0,0,0.45) 100%)" }} />
        </AbsoluteFill>
      )}

      {m?.voice && <Audio src={m.voice.src} />}

      {/* Everything readable lives inside the safe area, and anything that would overflow it is clipped. */}
      <div style={{ position: "absolute", left: rect.x, top: rect.y, width: rect.width, height: rect.height, overflow: "hidden", display: "flex", flexDirection: "column", justifyContent: "space-between", fontFamily: "Inter, sans-serif", opacity: exit }}>
        <div style={{ display: "flex", alignItems: "center", gap: Math.round(s.tag * 0.4), alignSelf: "flex-start", fontSize: s.tag, fontWeight: 800, letterSpacing: 1, textTransform: "uppercase", color: white, background: probe ? white : "transparent", textShadow: probe ? "none" : "0 1px 6px rgba(0,0,0,0.5)" }}>
          {brand.logo ? (
            // A white chip keeps any logo readable, whatever its colours or transparency, on any brand colour.
            <span style={{ display: "inline-flex", alignItems: "center", background: white, borderRadius: Math.round(s.tag * 0.4), padding: Math.round(s.tag * 0.3) }}>
              {probe ? (
                <span style={{ display: "inline-block", height: Math.round(s.tag * 1.6), width: Math.round(s.tag * 3.2), background: white }} />
              ) : (
                <Img src={brand.logo.src} style={{ height: Math.round(s.tag * 1.6), maxWidth: Math.round(rect.width * 0.3), objectFit: "contain" }} />
              )}
            </span>
          ) : (
            !probe && <span style={{ width: s.tag * 0.5, height: s.tag * 0.5, borderRadius: "50%", background: "#ffffff", display: "inline-block" }} />
          )}
          <span style={{ ...clamp(1), maxWidth: rect.width }}>{brand.name}</span>
        </div>

        <div style={{ flex: 1, display: "flex", alignItems: "center", minHeight: 0 }}>
          {headline && headlineText && (
            <div style={{ ...clamp(headline.maxLines), fontSize: headline.fontSize, fontWeight: 800, lineHeight: 1.1, color: white, textShadow: probe ? "none" : "0 2px 14px rgba(0,0,0,0.55)", transform: probe ? "none" : `translateY(${(1 - enter) * 30}px)`, opacity: enter, maxWidth: rect.width }}>
              {headlineText}
            </div>
          )}
        </div>

        {showCta ? (
          <div style={{ alignSelf: "center", maxWidth: rect.width, boxSizing: "border-box", padding: `${Math.round(s.cta * 0.4)}px ${s.cta}px`, borderRadius: s.cta, background: probe ? white : brand.primary, color: ctaText, fontSize: ctaFit.fontSize, fontWeight: 800, textAlign: "center", lineHeight: 1.15, ...clamp(ctaFit.maxLines) }}>
            {plan.cta.text}
          </div>
        ) : (
          <div style={{ boxSizing: "border-box", maxWidth: rect.width, padding: `${Math.round(s.caption * 0.45)}px ${Math.round(s.caption * 0.7)}px`, borderRadius: Math.round(s.caption * 0.5), background: probe ? white : `rgba(0,0,0,${CAPTION_SCRIM})`, color: white, fontSize: s.caption, fontWeight: 400, lineHeight: 1.3, ...clamp(3) }}>
            {tl.voiceover}
          </div>
        )}
      </div>
    </AbsoluteFill>
  );
};

export const Ad: React.FC<AdProps> = (props) => {
  useFonts();
  const { scenes } = buildTimeline(props.plan);
  return (
    <AbsoluteFill style={{ background: "#000" }}>
      {scenes.map((sc, i) => (
        <Sequence key={sc.id} from={sc.startFrame} durationInFrames={sc.durationFrames}>
          <SceneView props={props} index={i} startFrame={sc.startFrame} durationFrames={sc.durationFrames} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};
