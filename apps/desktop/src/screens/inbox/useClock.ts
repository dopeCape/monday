// The wall clock the list's relative times are written against ("2h",
// "Mon"), re-read every inbox.time_refresh_seconds so a row's time keeps up
// without a re-render for every tick. A pinned clock (a test's, the design
// fixture's on the dev server) never ticks.

import { useEffect, useState } from "react";

export function useClock(refreshSeconds: number, pinned?: Date | undefined): Date {
  const [now, setNow] = useState(() => pinned ?? new Date());
  useEffect(() => {
    if (pinned || refreshSeconds <= 0) return;
    setNow(new Date());
    const timer = setInterval(() => setNow(new Date()), refreshSeconds * 1000);
    return () => clearInterval(timer);
  }, [pinned, refreshSeconds]);
  return pinned ?? now;
}
