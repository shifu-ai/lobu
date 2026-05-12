import { useMemo, useState } from "preact/hooks";
import type { LandingUseCaseId } from "../use-case-definitions";
import {
  DEFAULT_LANDING_USE_CASE_ID,
  getLandingUseCaseShowcase,
  type SurfaceHeroCopy,
} from "../use-case-showcases";
import { AgentScrollStory } from "./AgentScrollStory";
import { CTA } from "./CTA";
import { HeroSection } from "./HeroSection";
import type { LatestBlogPost } from "./LatestBlogPosts";
import { MemoryConfigSection } from "./MemoryConfigSection";
import { PlatformStory } from "./PlatformStory";

export function LandingPage(props: {
  defaultUseCaseId?: LandingUseCaseId;
  linkTabsToCampaigns?: boolean;
  heroCopy?: SurfaceHeroCopy;
  latestPosts?: LatestBlogPost[];
}) {
  const [activeUseCaseId] = useState<LandingUseCaseId>(
    props.defaultUseCaseId ?? DEFAULT_LANDING_USE_CASE_ID
  );
  const activeUseCase = useMemo(
    () => getLandingUseCaseShowcase(activeUseCaseId),
    [activeUseCaseId]
  );
  const useScopedOwlettoUrl = Boolean(props.heroCopy);

  return (
    <>
      <HeroSection
        activeUseCaseId={activeUseCaseId}
        linkTabsToCampaigns={props.linkTabsToCampaigns}
        heroCopy={props.heroCopy}
        useScopedOwlettoUrl={useScopedOwlettoUrl}
      />

      <PlatformStory activeUseCaseId={activeUseCaseId} />

      <AgentScrollStory activeUseCase={activeUseCase} />

      <MemoryConfigSection activeUseCase={activeUseCase} />

      <CTA
        activeUseCaseId={activeUseCaseId}
        useScopedOwlettoUrl={useScopedOwlettoUrl}
      />
    </>
  );
}
