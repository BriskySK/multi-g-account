/** pdf-parse@1.x ships no types; minimal shape for the fields we use. */
declare module "pdf-parse" {
  interface PdfParseResult {
    text: string;
    numpages: number;
    numrender: number;
    info?: Record<string, unknown>;
    metadata?: unknown;
    version?: string;
  }

  function pdfParse(buffer: Buffer, options?: Record<string, unknown>): Promise<PdfParseResult>;

  export = pdfParse;
}
