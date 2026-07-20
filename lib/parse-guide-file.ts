import { PDFParse } from "pdf-parse";

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const ALLOWED_EXTENSIONS = new Set(["pdf", "txt", "md"]);

export type GuideFileType = "pdf" | "txt" | "md";

export type ParsedGuideFile = {
  text: string;
  fileType: GuideFileType;
};

function getExtension(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot >= 0 ? filename.slice(dot + 1).toLowerCase() : "";
}

/**
 * Extract plain text from a guide file buffer.
 * Supports PDF (via pdf-parse), TXT, and MD (raw UTF-8).
 */
export async function parseGuideFile(
  buffer: Buffer,
  filename: string,
): Promise<ParsedGuideFile> {
  if (buffer.byteLength > MAX_FILE_SIZE) {
    throw new Error(`File too large (${(buffer.byteLength / 1024 / 1024).toFixed(1)} MB). Max is 10 MB.`);
  }

  const ext = getExtension(filename);
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw new Error(`Unsupported file type ".${ext}". Upload a PDF, TXT, or MD file.`);
  }

  const fileType = ext as GuideFileType;

  if (fileType === "pdf") {
    const parser = new PDFParse({ data: buffer });
    try {
      const result = await parser.getText();
      const text = result.text.trim();
      if (!text) {
        throw new Error("Could not extract text from this PDF. It may be a scanned document.");
      }
      return { text, fileType };
    } finally {
      await parser.destroy();
    }
  }

  // TXT / MD — plain UTF-8
  const text = buffer.toString("utf-8").trim();
  if (!text) {
    throw new Error("The file is empty.");
  }
  return { text, fileType };
}

export { MAX_FILE_SIZE, ALLOWED_EXTENSIONS };
