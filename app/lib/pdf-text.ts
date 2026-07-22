import { getDocumentProxy } from "unpdf";
import type { PageSlice } from "@/app/lib/ai-prompts";

type PdfDocument = Awaited<ReturnType<typeof getDocumentProxy>>;

/**
 * Extract selectable text from a page range of an already-parsed PDF. The slice
 * is 1-indexed and inclusive (see `pageSliceFor`); a null `end` reads to the last
 * page. Bounds are clamped to the document, so an out-of-range slice just yields
 * what exists. Shared by the PDF extraction and summary routes so both honor
 * {{source_text}} / {{paper}} page ranges the same way.
 */
export async function readPdfPagesFromDocument(
  document: PdfDocument,
  slice: PageSlice,
  maxChars = 32000,
): Promise<{ text: string; firstPage: number; lastPage: number; totalPages: number }> {
  const totalPages = document.numPages;
  const firstPage = Math.min(totalPages, Math.max(1, slice.start));
  const lastPage = Math.min(totalPages, slice.end === null ? totalPages : Math.max(firstPage, slice.end));
  const pages: string[] = [];
  for (let pageNumber = firstPage; pageNumber <= lastPage; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    const pageText = content.items
      .map((item) => ("str" in item ? item.str : ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    pages.push(pageText);
    page.cleanup();
  }
  return { text: pages.join("\n\n").slice(0, maxChars), firstPage, lastPage, totalPages };
}

/** Parse raw PDF bytes and read a page range from them. */
export async function readPdfPages(
  bytes: Uint8Array,
  slice: PageSlice,
  maxChars = 32000,
): Promise<{ text: string; firstPage: number; lastPage: number; totalPages: number }> {
  const document = await getDocumentProxy(bytes);
  return readPdfPagesFromDocument(document, slice, maxChars);
}
