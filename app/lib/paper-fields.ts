/**
 * Which fields the add/edit paper form shows for a given paper type.
 *
 * Shared so the form's render and its submit handler read the same rule. They have
 * to agree: a field the submit reads but the form never rendered arrives as empty
 * and overwrites the stored value, and a field the form rendered but the submit
 * skips is silently discarded.
 */

export type EditablePaperType = "conference" | "journal" | "workshop" | "preprint" | "website" | "other";

export const paperTypeOptions: Array<{ value: EditablePaperType; label: string }> = [
  { value: "conference", label: "Conference paper" },
  { value: "journal", label: "Journal article" },
  { value: "workshop", label: "Workshop paper" },
  { value: "preprint", label: "Preprint" },
  { value: "website", label: "Website" },
  { value: "other", label: "Other" },
];

export function editablePaperType(value: string): EditablePaperType {
  const match = paperTypeOptions.find((option) => option.value === value);
  return match?.value ?? "other";
}

/**
 * Which bibliographic fields a paper type calls for.
 *
 * Only fields that are meaningless for a type are hidden: a website has no volume
 * or page range, a journal article has no preprint category.
 *
 * The two local-file fields (PDF, HTML snapshot) are deliberately absent from this
 * rule, because they are never hidden. They are independent artefacts that any
 * record can hold, and the same paper may be worth keeping both for. Gating them by
 * type meant snapshotting a website and then switching the type to a paper stranded
 * the snapshot: the file stayed on disk and stayed listed in the detail panel, with
 * no field left to inspect, replace, or clear it through.
 */
export function metadataVisibility(type: EditablePaperType) {
  const conferenceLike = type === "conference" || type === "workshop";
  const other = type === "other";
  return {
    // A website/blog still has a "venue" (the site or publisher name), so show it.
    venueName: conferenceLike || type === "journal" || type === "preprint" || type === "website" || other,
    venueAcronym: conferenceLike || type === "journal" || other,
    volumeIssue: type === "journal" || other,
    pages: conferenceLike || type === "journal" || other,
    doi: type !== "website",
    preprint: type === "preprint" || other,
    url: conferenceLike || type === "preprint" || type === "website" || other,
  };
}
