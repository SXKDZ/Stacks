import { metadataVisibility, type EditablePaperType } from "@/app/lib/paper-fields";

export type ExtractedMetadataField =
  | "title"
  | "authors"
  | "year"
  | "paperType"
  | "venueName"
  | "venueAcronym"
  | "category"
  | "preprintId"
  | "doi"
  | "url"
  | "abstract";

export function comparableMetadataValue(value: string): string {
  // Metadata comparisons must not change with the machine's locale. Locale-aware
  // casing can turn the same title into a conflict on one machine but not another.
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

export function isExtractedMetadataFieldApplicable(
  field: ExtractedMetadataField,
  paperType: EditablePaperType,
): boolean {
  const visible = metadataVisibility(paperType);
  switch (field) {
    case "venueName":
      return visible.venueName;
    case "venueAcronym":
      return visible.venueAcronym;
    case "category":
    case "preprintId":
      return visible.preprint;
    case "doi":
      return visible.doi;
    case "url":
      return visible.url;
    default:
      return true;
  }
}
