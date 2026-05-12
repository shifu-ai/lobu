import { landingUseCaseGroupedOptions } from "../use-case-showcases";

const GITHUB_URL = "https://github.com/lobu-ai/lobu";

const resourceLinks = [
  { label: "Docs", href: "/getting-started/" },
  { label: "Blog", href: "/blog/" },
  { label: "Security", href: "/guides/security/" },
  { label: "REST API", href: "/platforms/rest-api/" },
];

export function Footer() {
  return (
    <footer class="mt-20 bg-[#050505] px-6 py-12 text-white sm:px-8">
      <div class="mx-auto grid max-w-[76rem] gap-10 lg:grid-cols-[1.1fr_1.6fr]">
        <div>
          <a href="/" class="inline-flex items-center gap-2 text-lg font-bold tracking-[-0.04em]">
            <img src="/lobster-icon.png" alt="" class="h-7 w-7" />
            Lobu
          </a>
          <p class="mt-4 max-w-sm text-sm leading-6 text-white/58">
            Open-source infrastructure for agents that remember, act, and show up wherever your team already works.
          </p>
          <div class="mt-6 flex flex-wrap items-center gap-4 text-xs text-white/48">
            <span>&copy; {new Date().getFullYear()} Lobu</span>
            <a href="/terms/" class="hover:text-white">Terms</a>
            <a href="/privacy/" class="hover:text-white">Privacy</a>
            <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" class="hover:text-white">
              GitHub
            </a>
          </div>
        </div>

        <div class="grid gap-8 sm:grid-cols-3">
          <div>
            <h2 class="text-xs font-semibold uppercase tracking-[0.2em] text-white/38">
              Solutions
            </h2>
            <div class="mt-4 grid gap-2">
              {landingUseCaseGroupedOptions
                .flatMap((group) => group.useCases)
                .slice(0, 7)
                .map((useCase) => (
                  <a key={useCase.id} href={`/for/${useCase.id}/`} class="text-sm text-white/62 hover:text-white">
                    {useCase.label}
                  </a>
                ))}
            </div>
          </div>
          <div>
            <h2 class="text-xs font-semibold uppercase tracking-[0.2em] text-white/38">
              Platform
            </h2>
            <div class="mt-4 grid gap-2">
              <a href="/#model-the-world" class="text-sm text-white/62 hover:text-white">Model the world</a>
              <a href="/#connect-your-data" class="text-sm text-white/62 hover:text-white">Connect your data</a>
              <a href="/#define-goals" class="text-sm text-white/62 hover:text-white">Define goals</a>
              <a href="/#connect-everywhere" class="text-sm text-white/62 hover:text-white">Connect everywhere</a>
            </div>
          </div>
          <div>
            <h2 class="text-xs font-semibold uppercase tracking-[0.2em] text-white/38">
              Resources
            </h2>
            <div class="mt-4 grid gap-2">
              {resourceLinks.map((link) => (
                <a key={link.href} href={link.href} class="text-sm text-white/62 hover:text-white">
                  {link.label}
                </a>
              ))}
            </div>
          </div>
        </div>
      </div>
    </footer>
  );
}
