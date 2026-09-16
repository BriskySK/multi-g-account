import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { calendarClient, summarizeEvent, toEventDateTime } from "../google/calendar.js";
import { guarded, jsonResult, textResult, type Deps } from "./util.js";

const account = z.string().describe("Email address of the connected account to act as");
const calendarId = z.string().default("primary").describe("Calendar id; defaults to the account's primary calendar");
const sendUpdates = z
  .enum(["none", "all", "externalOnly"])
  .default("none")
  .describe("Whether Google notifies attendees about this change");
const eventTime = z
  .string()
  .describe("ISO datetime with offset (2026-09-15T10:00:00+02:00) or bare date (2026-09-15) for all-day");

export function registerCalendarTools(server: McpServer, deps: Deps): void {
  server.registerTool(
    "calendar_list_calendars",
    {
      description: "List calendars visible to the given account.",
      inputSchema: { account },
    },
    guarded("calendar_list_calendars", async (args: { account: string }) => {
      const calendar = calendarClient(deps.auth.getClientFor(args.account, ["calendar_read"]));
      const res = await calendar.calendarList.list();
      return jsonResult({
        calendars: (res.data.items ?? []).map((c) => ({
          id: c.id,
          summary: c.summary,
          primary: c.primary ?? false,
          accessRole: c.accessRole,
          timeZone: c.timeZone,
        })),
      });
    }),
  );

  server.registerTool(
    "calendar_list_events",
    {
      description: "List events in a time range, expanded to single instances and ordered by start time.",
      inputSchema: {
        account,
        calendar_id: calendarId,
        time_min: z.string().describe("Range start, ISO datetime with offset (e.g. 2026-09-13T00:00:00+02:00)"),
        time_max: z.string().describe("Range end, ISO datetime with offset"),
        max_results: z.number().int().min(1).max(250).default(50),
      },
    },
    guarded(
      "calendar_list_events",
      async (args: { account: string; calendar_id: string; time_min: string; time_max: string; max_results: number }) => {
        const calendar = calendarClient(deps.auth.getClientFor(args.account, ["calendar_read"]));
        const res = await calendar.events.list({
          calendarId: args.calendar_id,
          timeMin: args.time_min,
          timeMax: args.time_max,
          maxResults: args.max_results,
          singleEvents: true,
          orderBy: "startTime",
        });
        return jsonResult({ events: (res.data.items ?? []).map(summarizeEvent) });
      },
    ),
  );

  server.registerTool(
    "calendar_search_events",
    {
      description: "Free-text search of events (summary, description, location, attendees).",
      inputSchema: {
        account,
        query: z.string(),
        calendar_id: calendarId,
        time_min: z.string().optional().describe("Optional range start, ISO datetime with offset"),
        time_max: z.string().optional().describe("Optional range end, ISO datetime with offset"),
        max_results: z.number().int().min(1).max(250).default(25),
      },
    },
    guarded(
      "calendar_search_events",
      async (args: {
        account: string;
        query: string;
        calendar_id: string;
        time_min?: string;
        time_max?: string;
        max_results: number;
      }) => {
        const calendar = calendarClient(deps.auth.getClientFor(args.account, ["calendar_read"]));
        const res = await calendar.events.list({
          calendarId: args.calendar_id,
          q: args.query,
          timeMin: args.time_min,
          timeMax: args.time_max,
          maxResults: args.max_results,
          singleEvents: true,
          orderBy: "startTime",
        });
        return jsonResult({ events: (res.data.items ?? []).map(summarizeEvent) });
      },
    ),
  );

  server.registerTool(
    "calendar_create_event",
    {
      description: "Create a calendar event. Use bare dates on start/end for all-day events.",
      inputSchema: {
        account,
        calendar_id: calendarId,
        summary: z.string().describe("Event title"),
        start: eventTime,
        end: eventTime,
        description: z.string().optional(),
        location: z.string().optional(),
        attendees: z.array(z.string()).optional().describe("Attendee email addresses"),
        time_zone: z.string().optional().describe("IANA time zone (e.g. Europe/Bratislava) if start/end lack offsets"),
        send_updates: sendUpdates,
      },
    },
    guarded(
      "calendar_create_event",
      async (args: {
        account: string;
        calendar_id: string;
        summary: string;
        start: string;
        end: string;
        description?: string;
        location?: string;
        attendees?: string[];
        time_zone?: string;
        send_updates: "none" | "all" | "externalOnly";
      }) => {
        const calendar = calendarClient(deps.auth.getClientFor(args.account, ["calendar_write"]));
        const res = await calendar.events.insert({
          calendarId: args.calendar_id,
          sendUpdates: args.send_updates,
          requestBody: {
            summary: args.summary,
            description: args.description,
            location: args.location,
            start: toEventDateTime(args.start, args.time_zone),
            end: toEventDateTime(args.end, args.time_zone),
            attendees: args.attendees?.map((email) => ({ email })),
          },
        });
        return jsonResult(summarizeEvent(res.data));
      },
    ),
  );

  server.registerTool(
    "calendar_update_event",
    {
      description: "Update fields of an existing event. Only provided fields change.",
      inputSchema: {
        account,
        calendar_id: calendarId,
        event_id: z.string(),
        summary: z.string().optional(),
        start: eventTime.optional(),
        end: eventTime.optional(),
        description: z.string().optional(),
        location: z.string().optional(),
        attendees: z.array(z.string()).optional().describe("Replaces the attendee list when provided"),
        time_zone: z.string().optional(),
        send_updates: sendUpdates,
      },
    },
    guarded(
      "calendar_update_event",
      async (args: {
        account: string;
        calendar_id: string;
        event_id: string;
        summary?: string;
        start?: string;
        end?: string;
        description?: string;
        location?: string;
        attendees?: string[];
        time_zone?: string;
        send_updates: "none" | "all" | "externalOnly";
      }) => {
        const calendar = calendarClient(deps.auth.getClientFor(args.account, ["calendar_write"]));
        const res = await calendar.events.patch({
          calendarId: args.calendar_id,
          eventId: args.event_id,
          sendUpdates: args.send_updates,
          requestBody: {
            ...(args.summary !== undefined ? { summary: args.summary } : {}),
            ...(args.description !== undefined ? { description: args.description } : {}),
            ...(args.location !== undefined ? { location: args.location } : {}),
            ...(args.start !== undefined ? { start: toEventDateTime(args.start, args.time_zone) } : {}),
            ...(args.end !== undefined ? { end: toEventDateTime(args.end, args.time_zone) } : {}),
            ...(args.attendees !== undefined ? { attendees: args.attendees.map((email) => ({ email })) } : {}),
          },
        });
        return jsonResult(summarizeEvent(res.data));
      },
    ),
  );

  server.registerTool(
    "calendar_delete_event",
    {
      description: "Delete a calendar event.",
      inputSchema: { account, calendar_id: calendarId, event_id: z.string(), send_updates: sendUpdates },
    },
    guarded(
      "calendar_delete_event",
      async (args: { account: string; calendar_id: string; event_id: string; send_updates: "none" | "all" | "externalOnly" }) => {
        const calendar = calendarClient(deps.auth.getClientFor(args.account, ["calendar_write"]));
        await calendar.events.delete({
          calendarId: args.calendar_id,
          eventId: args.event_id,
          sendUpdates: args.send_updates,
        });
        return textResult(`Deleted event ${args.event_id}.`);
      },
    ),
  );

  server.registerTool(
    "calendar_respond_to_event",
    {
      description: "RSVP to an event invitation as the given account (accepted, declined, or tentative).",
      inputSchema: {
        account,
        calendar_id: calendarId,
        event_id: z.string(),
        response: z.enum(["accepted", "declined", "tentative"]),
        send_updates: sendUpdates,
      },
    },
    guarded(
      "calendar_respond_to_event",
      async (args: {
        account: string;
        calendar_id: string;
        event_id: string;
        response: "accepted" | "declined" | "tentative";
        send_updates: "none" | "all" | "externalOnly";
      }) => {
        const calendar = calendarClient(deps.auth.getClientFor(args.account, ["calendar_write"]));
        const event = await calendar.events.get({ calendarId: args.calendar_id, eventId: args.event_id });
        const attendees = event.data.attendees ?? [];
        const self = attendees.find((a) => a.self || a.email?.toLowerCase() === args.account.toLowerCase());
        if (!self) {
          throw new Error(`${args.account} is not an attendee of event ${args.event_id}.`);
        }
        self.responseStatus = args.response;
        const res = await calendar.events.patch({
          calendarId: args.calendar_id,
          eventId: args.event_id,
          sendUpdates: args.send_updates,
          requestBody: { attendees },
        });
        return jsonResult(summarizeEvent(res.data));
      },
    ),
  );
}
