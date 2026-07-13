import { useEffect, useState } from "react";

/**
 * A coarse ticking clock (epoch ms) for recomputing relative-time / freshness labels without
 * refetching data. Ticks on an interval and pauses while the tab is hidden to avoid waste.
 */
export function useNow(intervalMs = 5000): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;

    const start = () => {
      if (timer == null) {
        timer = setInterval(() => setNow(Date.now()), intervalMs);
      }
    };
    const stop = () => {
      if (timer != null) {
        clearInterval(timer);
        timer = null;
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        setNow(Date.now());
        start();
      } else {
        stop();
      }
    };

    if (document.visibilityState !== "hidden") start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [intervalMs]);

  return now;
}
