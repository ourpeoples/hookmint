import React from "react";
import { Composition, registerRoot } from "remotion";
import { ASPECTS, buildTimeline, DIMENSIONS, FPS } from "../src/render/layout";
import { Ad, type AdProps } from "./Ad";

export const compositionId = (aspect: string) => `Ad-${aspect.replace(":", "x")}`;

const defaults: AdProps = {
  plan: { hook: "Hook", cta: { text: "Learn more" }, scenes: [{ id: "s1", duration_s: 3, voiceover: "Placeholder" }, { id: "s2", duration_s: 3, voiceover: "Placeholder" }] },
  aspect: "9:16",
  brand: { name: "Brand", primary: "#0a84ff", secondary: "#052a55" },
  media: {},
};

const Root: React.FC = () => (
  <>
    {ASPECTS.map((aspect) => (
      <Composition
        key={aspect}
        id={compositionId(aspect)}
        component={Ad as unknown as React.FC<Record<string, unknown>>}
        width={DIMENSIONS[aspect].width}
        height={DIMENSIONS[aspect].height}
        fps={FPS}
        durationInFrames={FPS * 6}
        defaultProps={{ ...defaults, aspect } as unknown as Record<string, unknown>}
        calculateMetadata={({ props }) => {
          const p = props as unknown as AdProps;
          return { durationInFrames: buildTimeline(p.plan).totalFrames, width: DIMENSIONS[p.aspect].width, height: DIMENSIONS[p.aspect].height };
        }}
      />
    ))}
  </>
);

registerRoot(Root);
