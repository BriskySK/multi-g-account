import { google, type gmail_v1 } from "googleapis";
import type { OAuth2Client } from "google-auth-library";

export function gmailClient(auth: OAuth2Client): gmail_v1.Gmail {
  return google.gmail({ version: "v1", auth });
}

export interface ParsedMessage {
  id: string;
  threadId: string;
  labelIds: string[];
  from?: string;
  to?: string;
  cc?: string;
  subject?: string;
  date?: string;
  snippet?: string;
  body?: string;
  bodyType?: "text/plain" | "text/html";
  attachments: AttachmentMeta[];
}

export interface AttachmentMeta {
  /** Pass to gmail_get_attachment along with the message id. */
  attachmentId: string;
  filename: string;
  mimeType?: string;
  /** Size in bytes as reported by Gmail. */
  size?: number;
}

function header(payload: gmail_v1.Schema$MessagePart | undefined, name: string): string | undefined {
  return payload?.headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? undefined;
}

function decodeBody(data: string): string {
  return Buffer.from(data, "base64url").toString("utf8");
}

/** Walks the MIME tree; prefers text/plain, falls back to text/html. */
function extractBody(part: gmail_v1.Schema$MessagePart | undefined): { body: string; type: "text/plain" | "text/html" } | undefined {
  if (!part) return undefined;
  const stack: gmail_v1.Schema$MessagePart[] = [part];
  let html: string | undefined;
  while (stack.length > 0) {
    const current = stack.shift()!;
    if (current.mimeType === "text/plain" && current.body?.data) {
      return { body: decodeBody(current.body.data), type: "text/plain" };
    }
    if (current.mimeType === "text/html" && current.body?.data && html === undefined) {
      html = decodeBody(current.body.data);
    }
    if (current.parts) stack.push(...current.parts);
  }
  return html !== undefined ? { body: html, type: "text/html" } : undefined;
}

/** Walks the MIME tree collecting parts that carry a filename + attachmentId (actual attachments, not inline body parts). */
function collectAttachments(part: gmail_v1.Schema$MessagePart | undefined): AttachmentMeta[] {
  if (!part) return [];
  const attachments: AttachmentMeta[] = [];
  const stack: gmail_v1.Schema$MessagePart[] = [part];
  while (stack.length > 0) {
    const current = stack.shift()!;
    if (current.filename && current.body?.attachmentId) {
      attachments.push({
        attachmentId: current.body.attachmentId,
        filename: current.filename,
        mimeType: current.mimeType ?? undefined,
        size: current.body.size ?? undefined,
      });
    }
    if (current.parts) stack.push(...current.parts);
  }
  return attachments;
}

export function parseMessage(message: gmail_v1.Schema$Message): ParsedMessage {
  const extracted = extractBody(message.payload ?? undefined);
  return {
    id: message.id ?? "",
    threadId: message.threadId ?? "",
    labelIds: message.labelIds ?? [],
    from: header(message.payload ?? undefined, "From"),
    to: header(message.payload ?? undefined, "To"),
    cc: header(message.payload ?? undefined, "Cc"),
    subject: header(message.payload ?? undefined, "Subject"),
    date: header(message.payload ?? undefined, "Date"),
    snippet: message.snippet ?? undefined,
    body: extracted?.body,
    bodyType: extracted?.type,
    attachments: collectAttachments(message.payload ?? undefined),
  };
}

/** Downloads one attachment's raw bytes via the Gmail API. Gmail encodes attachment data as base64url. */
export async function getAttachmentBytes(
  gmail: gmail_v1.Gmail,
  messageId: string,
  attachmentId: string,
): Promise<Buffer> {
  const res = await gmail.users.messages.attachments.get({ userId: "me", messageId, id: attachmentId });
  if (!res.data.data) throw new Error("Gmail returned no attachment data.");
  return Buffer.from(res.data.data, "base64url");
}

export interface OutgoingMessage {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  /** Gmail thread to attach the message to (for replies). */
  threadId?: string;
  /** RFC 822 Message-ID of the message being replied to; sets In-Reply-To/References. */
  inReplyTo?: string;
}

/** RFC 2047 encoded-word for non-ASCII header values. */
function encodeHeaderValue(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

export function buildRawMessage(from: string, msg: OutgoingMessage): string {
  const lines = [
    `From: ${from}`,
    `To: ${msg.to.join(", ")}`,
    ...(msg.cc?.length ? [`Cc: ${msg.cc.join(", ")}`] : []),
    ...(msg.bcc?.length ? [`Bcc: ${msg.bcc.join(", ")}`] : []),
    `Subject: ${encodeHeaderValue(msg.subject)}`,
    ...(msg.inReplyTo ? [`In-Reply-To: ${msg.inReplyTo}`, `References: ${msg.inReplyTo}`] : []),
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(msg.body, "utf8").toString("base64"),
  ];
  return Buffer.from(lines.join("\r\n")).toString("base64url");
}
