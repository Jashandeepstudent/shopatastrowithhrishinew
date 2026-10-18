import { useEffect, useLayoutEffect, useRef } from "react";
import { useLocation, useNavigationType } from "react-router-dom";

const KEY = "awh_scroll_positions";

const read = (): Record<string, number> => {
  try {
    return JSON.parse(sessionStorage.getItem(KEY) || "{}");
  } catch {
    return {};
  }
};
const save = (id: string, y: number) => {
  try {
    const all = read();
    all[id] = y;
    // keep it small: only the most recent screens matter for the back button
    const ids = Object.keys(all);
    if (ids.length > 60) delete all[ids[0]];
    sessionStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* storage unavailable: the page simply opens at the top */
  }
};

/**
 * A new page opens at the top. The browser's back/forward buttons return to where the visitor was.
 * (The router does not do either by itself, so a page opened after scrolling the previous one
 * kept the old scroll position and landed on the footer.)
 */
const ScrollManager = () => {
  const { pathname, hash, key } = useLocation();
  const navType = useNavigationType();
  const currentKey = useRef(key);
  const lastPath = useRef(pathname);

  useEffect(() => {
    if ("scrollRestoration" in window.history) window.history.scrollRestoration = "manual";
  }, []);

  // remember the position of the screen we are on
  useEffect(() => {
    let timer: number | undefined;
    const onScroll = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => save(currentKey.current, window.scrollY), 120);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.clearTimeout(timer);
    };
  }, []);

  useLayoutEffect(() => {
    currentKey.current = key;
    const pathChanged = lastPath.current !== pathname;
    lastPath.current = pathname;

    if (hash) {
      // links like /page#section: let the browser find the element once it exists
      const id = decodeURIComponent(hash.slice(1));
      const t = window.setTimeout(() => document.getElementById(id)?.scrollIntoView(), 50);
      return () => window.clearTimeout(t);
    }

    if (navType === "POP") {
      // back / forward: return to the saved position, retrying while the lazy page content loads
      const target = read()[key] ?? 0;
      let tries = 0;
      const attempt = () => {
        window.scrollTo(0, target);
        if (Math.abs(window.scrollY - target) > 4 && tries++ < 20) timer = window.setTimeout(attempt, 100);
      };
      let timer = window.setTimeout(attempt, 0);
      return () => window.clearTimeout(timer);
    }

    // a link or button opened a different page: start at the top (same page with new filters keeps its place)
    if (pathChanged) window.scrollTo(0, 0);
  }, [pathname, hash, key, navType]);

  return null;
};

export default ScrollManager;
