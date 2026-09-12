import { useEffect, useState } from "react";
import {
  domainFromLocation,
  type OpsDomain,
  urlForDomain,
} from "./opsNavigation.js";

function canonicalizeOpsLocation(location: Pick<Location, "pathname" | "search" | "hash">): OpsDomain {
  const domain = domainFromLocation(location);
  const canonical = urlForDomain(location, domain);
  const next = `${canonical}${location.hash}`;
  const current = `${location.pathname}${location.search}${location.hash}`;
  if (current !== next) window.history.replaceState(null, "", next);
  return domain;
}

export function useOpsNavigation(options: {
  onPopstate?: (domain: OpsDomain, commit: () => void) => boolean;
} = {}): {
  activeDomain: OpsDomain;
  navigate: (domain: OpsDomain) => void;
} {
  const [activeDomain, setActiveDomain] = useState<OpsDomain>(() =>
    canonicalizeOpsLocation(window.location),
  );

  useEffect(() => {
    const restore = () => {
      const domain = canonicalizeOpsLocation(window.location);
      const commit = () => setActiveDomain(domain);
      if (!options.onPopstate?.(domain, commit)) commit();
    };
    window.addEventListener("hashchange", restore);
    window.addEventListener("popstate", restore);
    return () => {
      window.removeEventListener("hashchange", restore);
      window.removeEventListener("popstate", restore);
    };
  }, [options.onPopstate]);

  const navigate = (domain: OpsDomain) => {
    const target = urlForDomain(window.location, domain);
    if (
      `${window.location.pathname}${window.location.search}${window.location.hash}` !==
      target
    ) {
      window.history.pushState(null, "", target);
    }
    setActiveDomain(domain);
    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    window.scrollTo({ top: 0, behavior: reducedMotion ? "auto" : "smooth" });
    window.requestAnimationFrame(() =>
      document
        .querySelector<HTMLElement>("#ops-main-content")
        ?.focus({ preventScroll: true }),
    );
  };

  return { activeDomain, navigate };
}
