"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

export default function Header() {
  const [time, setTime] = useState("");
  const [window, setWindow] = useState("");

  useEffect(() => {
    function update() {
      const now = new Date();
      const ct = new Date(
        now.toLocaleString("en-US", { timeZone: "America/Chicago" }),
      );
      const hours = ct.getHours();
      const minutes = ct.getMinutes();
      const totalMinutes = hours * 60 + minutes;
      const day = ct.getDay(); // 0=Sun, 6=Sat

      setTime(
        ct.toLocaleTimeString("en-US", {
          hour: "numeric",
          minute: "2-digit",
          hour12: true,
        }) + " CT",
      );

      // MES futures: Sun 5pm CT – Fri 4pm CT, daily halt 4pm-5pm CT
      const isSaturday = day === 6;
      const isSundayBeforeOpen = day === 0 && totalMinutes < 1020; // before 5pm
      const isFridayAfterClose = day === 5 && totalMinutes >= 960; // after 4pm
      const isDailyHalt = totalMinutes >= 960 && totalMinutes < 1020; // 4pm-5pm CT

      if (isSaturday || isSundayBeforeOpen || isFridayAfterClose) {
        setWindow("Closed");
      } else if (isDailyHalt) {
        setWindow("Daily Halt");
      } else if (totalMinutes >= 510 && totalMinutes < 960) {
        // 8:30am - 4pm CT — RTH (regular trading hours)
        setWindow("RTH");
      } else {
        // Globex / overnight session
        setWindow("Globex");
      }
    }

    update();
    const interval = setInterval(update, 30000);
    return () => clearInterval(interval);
  }, []);

  return (
    <header className="flex items-center justify-between px-1 py-5 border-b border-[var(--zf-border-soft)] bg-[var(--zf-header)]">
      <div className="flex items-center gap-4">
        <Link
          href="/"
          className="text-2xl md:text-3xl font-black text-[var(--zf-text)] tracking-[0.08em] uppercase hover:text-white transition-colors leading-none"
        >
          RABID RACCOON
        </Link>
      </div>
      <div className="flex items-center gap-3">
        {window && (
          <span className="px-2 py-0.5 rounded text-[10px] font-bold uppercase bg-[var(--zf-control)] text-[var(--zf-text-muted)] border border-[var(--zf-border-soft)]">
            {window}
          </span>
        )}
        <span className="text-xs text-[var(--zf-text-muted)] tabular-nums font-medium">
          {time}
        </span>
      </div>
    </header>
  );
}
