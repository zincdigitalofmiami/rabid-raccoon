/**
 * econ-event-watcher — Fires compute-signal when high-impact econ events approach.
 *
 * Schedule: every 5 minutes during market hours (10:00-20:59 UTC / 6 AM-4:59 PM ET).
 *
 * Logic:
 *   - Queries econ_calendar for today's events marked HIGH impact
 *   - If any event is within 10 minutes (pre-release) OR happened within 5 minutes
 *     (post-release surprise window), sends 'econ/event.approaching' to trigger
 *     compute-signal for a fresh signal recalculation
 *
 * This gives us reactive signals around NFP, CPI, FOMC, Fed speeches, etc.
 * without polling every minute.
 *
 * compute-signal has:
 *   - concurrency: 1 (no parallel runs)
 *   - throttle: 1 per 10m (no back-to-back waste)
 *   - cancelOn: econ/event.approaching (preempt stale cron runs)
 *   - priority: econ events +200 (jump ahead of cron in queue)
 */

import { inngest } from '../client'
import { prisma } from '@/lib/prisma'

const PRE_EVENT_WINDOW_MS = 10 * 60 * 1000  // 10 minutes before
const POST_EVENT_WINDOW_MS = 5 * 60 * 1000  // 5 minutes after

export const econEventWatcher = inngest.createFunction(
  {
    id: 'econ-event-watcher',
    retries: 1,
    // Rate limit: skip excess runs if somehow double-fired. 1 run per 4 min.
    // Uses rate limiting (not throttle) because we DON'T need to queue misses —
    // the next cron tick in 5 min will check again.
    rateLimit: { limit: 1, period: '4m' },
  },
  { cron: '*/5 10-20 * * 1-5' }, // Every 5 min, 10:00-20:59 UTC, weekdays
  async ({ step }) => {
    const now = new Date()

    // Find today's high-impact events
    const startOfDay = new Date(now)
    startOfDay.setUTCHours(0, 0, 0, 0)
    const endOfDay = new Date(now)
    endOfDay.setUTCHours(23, 59, 59, 999)

    const events = await step.run('check-calendar', async () => {
      const rows = await prisma.econCalendar.findMany({
        where: {
          eventDate: { gte: startOfDay, lte: endOfDay },
          impactRating: 'HIGH',
        },
        select: {
          eventName: true,
          eventDate: true,
          eventTime: true,
          impactRating: true,
        },
        orderBy: { eventDate: 'asc' },
      })
      return rows.map((r) => ({
        name: r.eventName,
        // eventTime is the actual release time (HH:MM), eventDate is the calendar date
        time: r.eventTime
          ? new Date(`${r.eventDate.toISOString().slice(0, 10)}T${r.eventTime}:00Z`).toISOString()
          : r.eventDate.toISOString(),
        impact: r.impactRating ?? 'HIGH',
      }))
    })

    if (events.length === 0) {
      return { status: 'no-high-impact-events', checkedAt: now.toISOString() }
    }

    // Check if any event is in the approaching or just-released window
    const nowMs = now.getTime()
    const approaching = events.filter((e) => {
      const eventMs = new Date(e.time).getTime()
      const diff = eventMs - nowMs
      // Pre-event: within 10 minutes AND not more than 5 minutes in the past
      return diff > -POST_EVENT_WINDOW_MS && diff < PRE_EVENT_WINDOW_MS
    })

    if (approaching.length === 0) {
      return {
        status: 'no-imminent-events',
        checkedAt: now.toISOString(),
        todayEvents: events.length,
      }
    }

    // Fire the event trigger for compute-signal
    await step.run('fire-signal-trigger', async () => {
      await inngest.send({
        name: 'econ/event.approaching',
        data: {
          events: approaching,
          triggeredAt: now.toISOString(),
          reason: approaching.map((e) => e.name).join(', '),
        },
      })
    })

    return {
      status: 'triggered',
      checkedAt: now.toISOString(),
      triggered: approaching.map((e) => e.name),
    }
  },
)
