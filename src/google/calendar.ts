import { google, type calendar_v3 } from "googleapis";
import type { OAuth2Client } from "google-auth-library";

export function calendarClient(auth: OAuth2Client): calendar_v3.Calendar {
  return google.calendar({ version: "v3", auth });
}

export interface EventSummary {
  id: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: calendar_v3.Schema$EventDateTime;
  end?: calendar_v3.Schema$EventDateTime;
  status?: string;
  htmlLink?: string;
  organizer?: string;
  attendees?: { email?: string; responseStatus?: string; optional?: boolean }[];
  recurringEventId?: string;
}

export function summarizeEvent(event: calendar_v3.Schema$Event): EventSummary {
  return {
    id: event.id ?? "",
    summary: event.summary ?? undefined,
    description: event.description ? truncate(event.description, 1000) : undefined,
    location: event.location ?? undefined,
    start: event.start ?? undefined,
    end: event.end ?? undefined,
    status: event.status ?? undefined,
    htmlLink: event.htmlLink ?? undefined,
    organizer: event.organizer?.email ?? undefined,
    attendees: event.attendees?.map((a) => ({
      email: a.email ?? undefined,
      responseStatus: a.responseStatus ?? undefined,
      optional: a.optional ?? undefined,
    })),
    recurringEventId: event.recurringEventId ?? undefined,
  };
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * "2026-09-15" → all-day date; anything longer → dateTime.
 * Google requires the same form on both start and end.
 */
export function toEventDateTime(value: string, timeZone?: string): calendar_v3.Schema$EventDateTime {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return { date: value };
  return { dateTime: value, ...(timeZone ? { timeZone } : {}) };
}
