import { describe, expect, it } from "vitest";
import { parseMessage } from "../src/google/gmail.js";
import type { gmail_v1 } from "googleapis";

function b64url(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url");
}

describe("parseMessage", () => {
  it("collects attachments from a multipart message, ignoring inline body parts", () => {
    const message: gmail_v1.Schema$Message = {
      id: "msg-1",
      threadId: "thread-1",
      labelIds: ["INBOX"],
      snippet: "hi",
      payload: {
        headers: [
          { name: "From", value: "a@b.c" },
          { name: "Subject", value: "Invoice" },
        ],
        mimeType: "multipart/mixed",
        parts: [
          { mimeType: "text/plain", body: { data: b64url("hello") } },
          {
            filename: "invoice.pdf",
            mimeType: "application/pdf",
            body: { attachmentId: "att-1", size: 1234 },
          },
          {
            // inline image referenced by the HTML body: has no filename, must not be treated as an attachment
            mimeType: "image/png",
            body: { attachmentId: "att-2", size: 99 },
          },
        ],
      },
    };

    const parsed = parseMessage(message);
    expect(parsed.body).toBe("hello");
    expect(parsed.attachments).toEqual([
      { attachmentId: "att-1", filename: "invoice.pdf", mimeType: "application/pdf", size: 1234 },
    ]);
  });

  it("returns an empty attachments array when there are none", () => {
    const message: gmail_v1.Schema$Message = {
      id: "msg-2",
      threadId: "thread-2",
      payload: { mimeType: "text/plain", body: { data: b64url("hi") } },
    };
    expect(parseMessage(message).attachments).toEqual([]);
  });
});
