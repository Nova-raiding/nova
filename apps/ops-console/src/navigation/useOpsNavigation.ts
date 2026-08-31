import { useEffect, useState } from "react";
import {
  domainFromLocation,
  type OpsDomain,
  urlForDomain,
} from "./opsNavigation.js";

export function useOpsNavigation(): {
  activeDomain: OpsDomain;
  navigate: (domain: OpsDomain) => void;
} {
  const [activeDomain, setActiveDomain] = useState<OpsDomain>(() =>
    domainFromLocation(window.location),
  );

  useEffect(() => {
    const restore = () => setActiveDomain(domainFromLocation(window.location));
    window.addEventListener("hashchange", restore);
    window.addEventListener("popstate", restore);
    return () => {
      window.removeEventListener("hashchange", restore);
      window.removeEventListener("popstate", restore);
    };
  }, []);

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
