import { z } from "zod";
import pdfParse from "pdf-parse";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { buildRawMessage, getAttachmentBytes, gmailClient, parseMessage } from "../google/gmail.js";
import { guarded, jsonResult, type Deps } from "./util.js";

/** PDF text is sliced to this many characters per call so one attachment can't blow up a response or the container's memory. */
const DEFAULT_ATTACHMENT_MAX_CHARS = 15_000;
const PDF_MAGIC_BYTES = Buffer.from("%PDF");

const account = z.string().describe("Email address of the connected account to act as");

export function registerGmailTools(server: McpServer, deps: Deps): void {
  server.registerTool(
    "gmail_search_threads",
    {
      description:
        "Search Gmail threads using Gmail query syntax (e.g. 'from:alice is:unread newer_than:7d'). " +
        "Returns thread ids and snippets; use gmail_get_thread for full content.",
      inputSchema: {
        account,
        query: z.string().describe("Gmail search query"),
        max_results: z.number().int().min(1).max(100).default(20),
        page_token: z.string().optional().describe("Token from a previous page of results"),
      },
    },
    guarded("gmail_search_threads", async (args: { account: string; query: string; max_results: number; page_token?: string }) => {
      const gmail = gmailClient(deps.auth.getClientFor(args.account, ["gmail_read"]));
      const res = await gmail.users.threads.list({
        userId: "me",
        q: args.query,
        maxResults: args.max_results,
        pageToken: args.page_token,
      });
      return jsonResult({
        threads: (res.data.threads ?? []).map((t) => ({ id: t.id, snippet: t.snippet })),
        nextPageToken: res.data.nextPageToken ?? undefined,
        resultSizeEstimate: res.data.resultSizeEstimate ?? undefined,
      });
    }),
  );

  server.registerTool(
    "gmail_get_message",
    {
      description:
        "Fetch a single Gmail message by id: headers, labels, decoded body, and a list of attachments " +
        "(filename, mimeType, size, attachmentId). Use gmail_get_attachment to read a PDF attachment's content.",
      inputSchema: { account, id: z.string().describe("Message id") },
    },
    guarded("gmail_get_message", async (args: { account: string; id: string }) => {
      const gmail = gmailClient(deps.auth.getClientFor(args.account, ["gmail_read"]));
      const res = await gmail.users.messages.get({ userId: "me", id: args.id, format: "full" });
      return jsonResult(parseMessage(res.data));
    }),
  );

  server.registerTool(
    "gmail_get_thread",
    {
      description: "Fetch a Gmail thread by id with all its messages (headers and decoded bodies).",
      inputSchema: { account, id: z.string().describe("Thread id") },
    },
    guarded("gmail_get_thread", async (args: { account: string; id: string }) => {
      const gmail = gmailClient(deps.auth.getClientFor(args.account, ["gmail_read"]));
      const res = await gmail.users.threads.get({ userId: "me", id: args.id, format: "full" });
      return jsonResult({
        id: res.data.id,
        messages: (res.data.messages ?? []).map(parseMessage),
      });
    }),
  );

  const outgoingFields = {
    account,
    to: z.array(z.string()).min(1).describe("Recipient email addresses"),
    cc: z.array(z.string()).optional(),
    bcc: z.array(z.string()).optional(),
    subject: z.string(),
    body: z.string().describe("Plain-text message body"),
    thread_id: z.string().optional().describe("Existing thread id to reply within"),
    in_reply_to: z
      .string()
      .optional()
      .describe("RFC 822 Message-ID header value of the message being replied to"),
  };

  type Outgoing = {
    account: string;
    to: string[];
    cc?: string[];
    bcc?: string[];
    subject: string;
    body: string;
    thread_id?: string;
    in_reply_to?: string;
  };

  const toRaw = (args: Outgoing) =>
    buildRawMessage(args.account, {
      to: args.to,
      cc: args.cc,
      bcc: args.bcc,
      subject: args.subject,
      body: args.body,
      threadId: args.thread_id,
      inReplyTo: args.in_reply_to,
    });

  server.registerTool(
    "gmail_send_message",
    {
      description:
        "Send an email from the given account. Supports replying within an existing thread via thread_id + in_reply_to.",
      inputSchema: outgoingFields,
    },
    guarded("gmail_send_message", async (args: Outgoing) => {
      const gmail = gmailClient(deps.auth.getClientFor(args.account, ["gmail_send"]));
      const res = await gmail.users.messages.send({
        userId: "me",
        requestBody: { raw: toRaw(args), threadId: args.thread_id },
      });
      return jsonResult({ sent: true, id: res.data.id, threadId: res.data.threadId });
    }),
  );

  server.registerTool(
    "gmail_create_draft",
    {
      description: "Create a Gmail draft (not sent) in the given account.",
      inputSchema: outgoingFields,
    },
    guarded("gmail_create_draft", async (args: Outgoing) => {
      const gmail = gmailClient(deps.auth.getClientFor(args.account, ["gmail_modify"]));
      const res = await gmail.users.drafts.create({
        userId: "me",
        requestBody: { message: { raw: toRaw(args), threadId: args.thread_id } },
      });
      return jsonResult({ draftId: res.data.id, messageId: res.data.message?.id });
    }),
  );

  server.registerTool(
    "gmail_list_labels",
    {
      description: "List Gmail labels (system and user-created) for the given account.",
      inputSchema: { account },
    },
    guarded("gmail_list_labels", async (args: { account: string }) => {
      const gmail = gmailClient(deps.auth.getClientFor(args.account, ["gmail_read"]));
      const res = await gmail.users.labels.list({ userId: "me" });
      return jsonResult({
        labels: (res.data.labels ?? []).map((l) => ({ id: l.id, name: l.name, type: l.type })),
      });
    }),
  );

  server.registerTool(
    "gmail_label_message",
    {
      description:
        "Add and/or remove labels on a Gmail message. Use label ids from gmail_list_labels " +
        "(e.g. add UNREAD, remove INBOX to archive).",
      inputSchema: {
        account,
        message_id: z.string(),
        add_label_ids: z.array(z.string()).default([]),
        remove_label_ids: z.array(z.string()).default([]),
      },
    },
    guarded(
      "gmail_label_message",
      async (args: { account: string; message_id: string; add_label_ids: string[]; remove_label_ids: string[] }) => {
        if (args.add_label_ids.length === 0 && args.remove_label_ids.length === 0) {
          throw new Error("Provide add_label_ids and/or remove_label_ids.");
        }
        const gmail = gmailClient(deps.auth.getClientFor(args.account, ["gmail_modify"]));
        const res = await gmail.users.messages.modify({
          userId: "me",
          id: args.message_id,
          requestBody: { addLabelIds: args.add_label_ids, removeLabelIds: args.remove_label_ids },
        });
        return jsonResult({ id: res.data.id, labelIds: res.data.labelIds });
      },
    ),
  );

  server.registerTool(
    "gmail_get_attachment",
    {
      description:
        "Read the text content of a PDF attachment on a Gmail message (attachment ids come from " +
        "gmail_get_message/gmail_get_thread). Only PDF attachments are supported. Long PDFs are truncated to " +
        "a chunk of text at a time — check `truncated` in the result and pass a higher `offset` to read on.",
      inputSchema: {
        account,
        message_id: z.string(),
        attachment_id: z.string(),
        offset: z.number().int().min(0).default(0).describe("Character offset into the extracted text to start from"),
        max_chars: z
          .number()
          .int()
          .min(1000)
          .max(50_000)
          .default(DEFAULT_ATTACHMENT_MAX_CHARS)
          .describe("Maximum characters of extracted text to return in this call"),
      },
    },
    guarded(
      "gmail_get_attachment",
      async (args: { account: string; message_id: string; attachment_id: string; offset: number; max_chars: number }) => {
        const gmail = gmailClient(deps.auth.getClientFor(args.account, ["gmail_read"]));
        const bytes = await getAttachmentBytes(gmail, args.message_id, args.attachment_id);
        if (!bytes.subarray(0, 4).equals(PDF_MAGIC_BYTES)) {
          throw new Error("Only PDF attachments are supported (this file's content doesn't start with a PDF header).");
        }
        const parsed = await pdfParse(bytes);
        const totalChars = parsed.text.length;
        const slice = parsed.text.slice(args.offset, args.offset + args.max_chars);
        return jsonResult({
          pages: parsed.numpages,
          totalChars,
          offset: args.offset,
          returnedChars: slice.length,
          truncated: args.offset + slice.length < totalChars,
          text: slice,
        });
      },
    ),
  );
}
