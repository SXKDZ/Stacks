"use client";

import { BookOpen, Check, Cpu, FileText, GripHorizontal, Image as ImageIcon, LoaderCircle, Paperclip, Search, Send, X } from "lucide-react";
import { type ClipboardEvent as ReactClipboardEvent, type DragEvent as ReactDragEvent, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ActionButton, type SelectOption } from "@/app/components/ui/controls";
import { RunSettingsMenu } from "@/app/components/feed/RunSettingsMenu";
import { MarkdownCodeEditor } from "@/app/components/ui/MarkdownCodeEditor";

/** A library paper the user can attach (its PDF/HTML is sent to the agent). */
import { matchesSearch, paperMetaLine, paperSearchValues } from "@/app/lib/paper-meta";
import { EFFORT_LEVELS, effortLabel, effortSetting, type EffortSetting } from "@/app/lib/effort";

export interface LibraryPaper {
  id: string;
  title: string;
  localPath?: string | null;
  htmlSnapshotPath?: string | null;
  // Shown as the picker's second line, matching the collection cards. The feed
  // already loads full papers from /api/library, so these need no extra request.
  authors?: Array<{ displayName: string }>;
  venueAcronym?: string | null;
  venueName?: string | null;
  year?: number | null;
}

export interface AttachSubmit {
  text: string;
  files: File[];
  paperIds: string[];
  /** The Bedrock model to run this feed with ("" = the default). */
  model: string;
  /** Reasoning effort for this feed ("" = the global Settings value). */
  effort: string;
}

/** A pickable agent model (from the Bedrock catalog, as in Settings). */
export interface FeedModelOption {
  id: string;
  label: string;
}

/** The agent-model options for the feed composer/reply picker, with the
 *  configured default named explicitly at the top. */
function modelSelectOptions(models: FeedModelOption[], defaultModelLabel: string): SelectOption[] {
  const defaultLabel = defaultModelLabel ? `${defaultModelLabel} (default)` : "Default model";
  return [
    { value: "", label: defaultLabel, text: defaultLabel },
    ...models.map((option) => ({ value: option.id, label: option.label, text: option.label })),
  ];
}

/** The model's name for the collapsed trigger, without the "(default)" suffix:
 *  the trigger has no room for it and the open menu already says which is default. */
function modelTriggerText(model: string, models: FeedModelOption[], defaultModelLabel: string): string {
  return models.find((option) => option.id === model)?.label || defaultModelLabel || "Default model";
}

/** Pull files out of a paste or a drag-drop (Finder), including clipboard images. */
function filesFromTransfer(data: DataTransfer | null): File[] {
  if (!data) return [];
  if (data.files?.length) {
    return Array.from(data.files);
  }
  return Array.from(data.items ?? [])
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file));
}

/**
 * A composer with text plus file and library-paper attachments. Shared by the
 * new-feed composer and the reply box so both support uploads, library papers,
 * clipboard paste, and drag-drop from Finder. Owns its own attachment state and
 * clears it after a successful submit.
 */
export function AttachBox({
  library,
  placeholder,
  submitLabel,
  submitting,
  autoFocus = false,
  compact = false,
  initialText = "",
  initialPapers = [],
  leadingAction,
  models = [],
  initialModel = "",
  initialEffort = "",
  defaultEffortLabel = "",
  defaultModelLabel = "",
  onSubmit,
}: {
  library: LibraryPaper[];
  placeholder: string;
  submitLabel: string;
  submitting: boolean;
  autoFocus?: boolean;
  compact?: boolean;
  initialText?: string;
  initialPapers?: LibraryPaper[];
  /** Optional control shown beside the submit button (e.g. Stop while running). */
  leadingAction?: ReactNode;
  /** Selectable agent models; empty hides the picker. */
  models?: FeedModelOption[];
  /** The feed's current model id ("" = the default). */
  initialModel?: string;
  /** The feed's current reasoning effort ("" = the global default). */
  initialEffort?: string;
  /** The global effort from Settings, named in the "default" option. */
  defaultEffortLabel?: EffortSetting;
  /** The configured default model's label (Settings → AI model). */
  defaultModelLabel?: string;
  onSubmit: (payload: AttachSubmit) => Promise<boolean>;
}) {
  const [text, setText] = useState(initialText);
  const [model, setModel] = useState(initialModel);
  const [effort, setEffort] = useState<string>(initialEffort);
  // The composer's initialModel arrives after mount (the last-used model is read
  // from localStorage), so adopt a changed initialModel — but only while the user
  // hasn't picked one yet, so a late default can't clobber an active choice. The
  // ref tracks the last prop value we synced from, distinguishing a prop change
  // from a user selection.
  const syncedModelRef = useRef(initialModel);
  useEffect(() => {
    if (initialModel !== syncedModelRef.current) {
      syncedModelRef.current = initialModel;
      setModel((current) => (current === "" ? initialModel : current));
    }
  }, [initialModel]);
  const [files, setFiles] = useState<File[]>([]);
  const [papers, setPapers] = useState<LibraryPaper[]>(initialPapers);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState("");
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const trayRef = useRef<HTMLDivElement>(null);
  const pickerSearchRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelResizeDrag = useRef<{ pointerId: number; startY: number; startHeight: number } | null>(null);
  const [panelHeight, setPanelHeight] = useState<number | null>(null);

  const minimumPanelHeight = compact ? 150 : 210;

  function clampPanelHeight(nextHeight: number): number {
    const viewportMaximum = typeof window === "undefined" ? 680 : Math.min(680, window.innerHeight * 0.72);
    return Math.round(Math.min(Math.max(minimumPanelHeight, viewportMaximum), Math.max(minimumPanelHeight, nextHeight)));
  }

  function currentPanelHeight(): number {
    return panelHeight ?? panelRef.current?.getBoundingClientRect().height ?? minimumPanelHeight;
  }

  function startPanelResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    panelResizeDrag.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startHeight: currentPanelHeight(),
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  function movePanelResize(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = panelResizeDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    // The composer is bottom-docked: moving its top edge upward makes it taller.
    setPanelHeight(clampPanelHeight(drag.startHeight + drag.startY - event.clientY));
  }

  function endPanelResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (panelResizeDrag.current?.pointerId !== event.pointerId) return;
    panelResizeDrag.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
  }

  function resizePanelWithKeyboard(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown" && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const step = event.shiftKey ? 40 : 20;
    if (event.key === "Home") setPanelHeight(null);
    else if (event.key === "End") setPanelHeight(clampPanelHeight(680));
    else setPanelHeight(clampPanelHeight(currentPanelHeight() + (event.key === "ArrowUp" ? step : -step)));
  }

  // Pasted long text becomes an editable text attachment (chip), not textarea fill.
  const [texts, setTexts] = useState<Array<{ id: string; name: string; content: string }>>([]);
  const [zoomedImage, setZoomedImage] = useState<string | null>(null);
  const [editingText, setEditingText] = useState<{ id: string; name: string; content: string } | null>(null);
  // Hover image preview. The attachment tray is a height-capped scroll box
  // (overflow-y:auto), so an absolutely-positioned preview inside it would be
  // clipped. Anchor a fixed-position preview to the hovered chip and portal it
  // to the body so it floats above the tray's clip.
  const [hoverPreview, setHoverPreview] = useState<{ url: string; left: number; bottom: number } | null>(null);

  function showPreview(url: string, target: HTMLElement) {
    const rect = target.getBoundingClientRect();
    setHoverPreview({ url, left: rect.left, bottom: window.innerHeight - rect.top + 8 });
  }

  const hasAttachments = files.length > 0 || papers.length > 0 || texts.length > 0;

  // Esc closes whichever overlay is open (library picker, zoomed image, or the
  // pasted-text editor), innermost first.
  // Move focus into the picker's search box when it opens. `autoFocus` on a
  // conditionally-rendered input is racy (the composer textarea can win the
  // focus), which left keystrokes landing in the composer behind the modal.
  useEffect(() => {
    if (pickerOpen) {
      const frame = requestAnimationFrame(() => pickerSearchRef.current?.focus());
      return () => cancelAnimationFrame(frame);
    }
  }, [pickerOpen]);

  const overlayOpen = pickerOpen || zoomedImage !== null || editingText !== null;
  useEffect(() => {
    if (!overlayOpen) return;
    // The effect re-subscribes whenever any overlay opens/closes, so these state
    // values are current inside the handler. Close the innermost overlay first
    // with a single state update per branch (no side effects in an updater).
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      if (zoomedImage !== null) {
        setZoomedImage(null);
      } else if (editingText !== null) {
        setEditingText(null);
      } else {
        setPickerOpen(false);
      }
    }
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [overlayOpen, zoomedImage, editingText]);

  // Keep the newest chip in view when the (height-capped, scrollable) tray grows.
  useEffect(() => {
    const tray = trayRef.current;
    if (tray) {
      tray.scrollTop = tray.scrollHeight;
    }
  }, [files.length, papers.length]);

  // Object URLs for image previews, one per image file. The ref lets us revoke
  // URLs for removed files (and all of them on unmount) without stale closures.
  const [previews, setPreviews] = useState<Map<File, string>>(new Map());
  const previewsRef = useRef(previews);
  useEffect(() => { previewsRef.current = previews; }, [previews]);
  useEffect(() => {
    setPreviews((current) => {
      const next = new Map<File, string>();
      for (const file of files) {
        if (file.type.startsWith("image/")) {
          next.set(file, current.get(file) ?? URL.createObjectURL(file));
        }
      }
      for (const [file, url] of current) {
        if (!next.has(file)) URL.revokeObjectURL(url);
      }
      return next;
    });
  }, [files]);
  useEffect(() => () => { previewsRef.current.forEach((url) => URL.revokeObjectURL(url)); }, []);
  const canSubmit = (text.trim().length > 0 || hasAttachments) && !submitting;

  function addFiles(list: Iterable<File> | null) {
    if (!list) return;
    const added = Array.from(list);
    if (added.length) setFiles((current) => [...current, ...added]);
  }

  function togglePaper(paper: LibraryPaper) {
    setPapers((current) =>
      current.some((item) => item.id === paper.id)
        ? current.filter((item) => item.id !== paper.id)
        : [...current, paper],
    );
  }

  async function submit(event: FormEvent | ReactKeyboardEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    // Text attachments ride along as .txt files the agent reads from its dir.
    const textFiles = texts.map((entry, index) =>
      new File([entry.content], `pasted-${index + 1}.txt`, { type: "text/plain" }),
    );
    const cleared = await onSubmit({ text: text.trim(), files: [...files, ...textFiles], paperIds: papers.map((p) => p.id), model, effort });
    if (cleared) {
      setText("");
      setFiles([]);
      setPapers([]);
      setTexts([]);
      setPickerOpen(false);
      setPickerQuery("");
    }
  }

  function addText(content: string, name = "Pasted text") {
    setTexts((current) => [...current, { id: `txt-${current.length}-${content.length}`, name, content }]);
  }

  function handlePaste(event: ReactClipboardEvent) {
    const pasted = filesFromTransfer(event.clipboardData);
    if (pasted.length) {
      event.preventDefault();
      addFiles(pasted);
      return;
    }
    // A very long paste is treated as a text attachment rather than filling the
    // input, so the composer stays readable. Short pastes fall through normally.
    const pastedText = event.clipboardData?.getData("text/plain") ?? "";
    if (pastedText.length > 1500) {
      event.preventDefault();
      addText(pastedText);
    }
  }

  function handleDrop(event: ReactDragEvent) {
    const dropped = filesFromTransfer(event.dataTransfer);
    if (dropped.length) {
      event.preventDefault();
      addFiles(dropped);
    }
    setDragging(false);
  }

  return (
    <form
      className={`feed-dock ${compact ? "is-compact" : ""} ${dragging ? "is-dragging" : ""}`}
      onSubmit={submit}
      onPaste={handlePaste}
      onDragOver={(event) => { if (event.dataTransfer?.types.includes("Files")) { event.preventDefault(); setDragging(true); } }}
      onDragLeave={(event) => { if (event.currentTarget === event.target) setDragging(false); }}
      onDrop={handleDrop}
    >
      {dragging ? <div className="feed-drop-hint"><Paperclip size={18} /> Drop files to attach</div> : null}

      <div
        ref={panelRef}
        className="feed-dock-input is-panel-resizable"
        style={panelHeight === null ? undefined : { height: `${panelHeight}px` }}
      >
        <div
          className="feed-panel-resize-handle"
          role="separator"
          aria-label={compact ? "Resize reply panel" : "Resize new feed panel"}
          aria-orientation="horizontal"
          aria-valuemin={minimumPanelHeight}
          aria-valuemax={680}
          aria-valuenow={Math.round(panelHeight ?? minimumPanelHeight)}
          tabIndex={0}
          onPointerDown={startPanelResize}
          onPointerMove={movePanelResize}
          onPointerUp={endPanelResize}
          onPointerCancel={endPanelResize}
          onKeyDown={resizePanelWithKeyboard}
        >
          <GripHorizontal aria-hidden="true" />
        </div>
        {hasAttachments ? (
          <div className="feed-attach-tray" ref={trayRef}>
            {papers.map((paper) => (
              <span key={paper.id} className="feed-chip" title={paper.title}>
                <BookOpen size={12} />
                <span className="feed-chip-label">{paper.title}</span>
                <button type="button" onClick={() => togglePaper(paper)} aria-label={`Remove ${paper.title}`}><X size={12} /></button>
              </span>
            ))}
            {texts.map((entry) => (
              <span key={entry.id} className="feed-chip">
                <button type="button" className="feed-chip-open" onClick={() => setEditingText(entry)} title="Edit text">
                  <FileText size={12} />
                  <span className="feed-chip-label">{entry.name}</span>
                </button>
                <button type="button" onClick={() => setTexts((current) => current.filter((item) => item.id !== entry.id))} aria-label={`Remove ${entry.name}`}><X size={12} /></button>
              </span>
            ))}
            {files.map((file, index) => {
              const preview = previews.get(file);
              return (
                <span key={`${file.name}-${index}`} className="feed-chip" title={file.name || "image"}>
                  {preview ? (
                    <button
                      type="button"
                      className="feed-chip-open"
                      onClick={() => setZoomedImage(preview)}
                      onMouseEnter={(event) => showPreview(preview, event.currentTarget)}
                      onMouseLeave={() => setHoverPreview(null)}
                      title="View image"
                    >
                      <span className="feed-chip-preview"><ImageIcon size={12} /></span>
                      <span className="feed-chip-label">{file.name || "image"}</span>
                    </button>
                  ) : (
                    <><FileText size={12} /><span className="feed-chip-label">{file.name}</span></>
                  )}
                  <button type="button" onClick={() => setFiles((current) => current.filter((_, i) => i !== index))} aria-label={`Remove ${file.name || "image"}`}><X size={12} /></button>
                </span>
              );
            })}
          </div>
        ) : null}
        <MarkdownCodeEditor
          className="feed-composer-editor"
          value={text}
          onChange={setText}
          onKeyDown={(event) => {
            // Enter sends; Alt/Shift/Cmd/Ctrl+Enter inserts a newline instead.
            if (event.key === "Enter" && !event.altKey && !event.shiftKey && !event.metaKey && !event.ctrlKey) {
              void submit(event);
            }
          }}
          placeholder={placeholder}
          ariaLabel={compact ? "Reply to agent" : "New feed instruction"}
          rows={compact ? 3 : 6}
          autoFocus={autoFocus}
        />

        <div className="feed-dock-actions">
          <div className="feed-dock-tools">
            <input ref={fileInputRef} type="file" multiple hidden onChange={(event) => { addFiles(event.target.files); event.target.value = ""; }} />
            <button type="button" className="feed-tool-btn" onClick={() => fileInputRef.current?.click()} aria-label="Attach a file" title="Attach files"><Paperclip size={16} /></button>
            <button type="button" className={`feed-tool-btn ${pickerOpen ? "is-active" : ""}`} onClick={() => setPickerOpen((open) => !open)} aria-label="Attach a paper from your library" title="Attach a paper from your library"><BookOpen size={16} /></button>
            {/* Model and effort share one trigger with a submenu each. Side by side
                they were wide enough to push the send group outside the composer
                while the agent ran, when the row also gains Stop and the submit
                label grows to "Interrupt & send". */}
            <RunSettingsMenu
              leadingIcon={<Cpu size={13} aria-hidden="true" />}
              groups={[
                ...(models.length
                  ? [{
                      key: "model",
                      label: "Model",
                      value: model,
                      options: modelSelectOptions(models, defaultModelLabel),
                      onChange: setModel,
                      triggerText: modelTriggerText(model, models, defaultModelLabel),
                    }]
                  : []),
                {
                  key: "effort",
                  label: "Effort",
                  value: effort,
                  // "" defers upward, so the option names what that resolves to: the
                  // level configured in Settings, or the model's own default when
                  // Settings leaves it unset. Just "Default" left that ambiguous.
                  options: [{ value: "", label: defaultEffortLabel ? `${effortLabel(defaultEffortLabel)} (from Settings)` : "Let the model decide" },
                            ...EFFORT_LEVELS.map((level) => ({ value: level, label: effortLabel(level) }))],
                  onChange: setEffort,
                  // Named only once it says something: deferring to a Settings value
                  // that is itself unset would spend trigger width on "Let the model
                  // decide", which is what the absence of a level already means.
                  triggerText: effortSetting(effort || defaultEffortLabel)
                    ? effortLabel(effortSetting(effort || defaultEffortLabel))
                    : undefined,
                },
              ]}
            />
          </div>
          <div className="feed-dock-send">
            {leadingAction}
            {/* The shortcut lives in the button's own tooltip: as a standing label it
                spent the row's best space on something the badge already implies. */}
            <ActionButton
              type="submit"
              variant="primary"
              size={compact ? "small" : undefined}
              disabled={!canSubmit}
              title="Enter sends, Option Enter starts a newline"
              icon={submitting ? <LoaderCircle className="spin" size={15} /> : <Send size={15} />}
            ><span className="feed-send-label">{submitLabel}</span><kbd className="feed-send-kbd">↵</kbd></ActionButton>
          </div>
        </div>
      </div>

      {pickerOpen ? (
        <div className="feed-picker-scrim" onClick={() => setPickerOpen(false)}>
          <div className="feed-picker" onClick={(event) => event.stopPropagation()}>
            <header className="feed-picker-head">
              <strong>Attach from your library</strong>
              <button type="button" className="feed-tool-btn" onClick={() => setPickerOpen(false)} aria-label="Close"><X size={16} /></button>
            </header>
            <div className="feed-picker-search">
              <Search size={14} />
              <input ref={pickerSearchRef} value={pickerQuery} onChange={(event) => setPickerQuery(event.target.value)} placeholder="Search title, author, venue, year…" />
            </div>
            <div className="feed-picker-list">
              {library
                // Findable by author, venue, and year as well as title: remembering
                // "the Kimi paper from NeurIPS" is as common as recalling the title.
                .filter((paper) => matchesSearch(paperSearchValues(paper), pickerQuery))
                .slice(0, 60)
                .map((paper) => {
                  const attached = papers.some((item) => item.id === paper.id);
                  return (
                    <button type="button" key={paper.id} className={`feed-picker-item ${attached ? "is-attached" : ""}`} onClick={() => togglePaper(paper)} title={paper.title}>
                      {attached ? <Check size={14} /> : <BookOpen size={14} />}
                      <span className="feed-picker-item-text">
                        <span className="feed-picker-item-title">{paper.title}</span>
                        <small className="feed-picker-item-meta">{paperMetaLine(paper)}</small>
                      </span>
                    </button>
                  );
                })}
              {library.length === 0 ? <p className="feed-picker-empty">Your library is empty.</p> : null}
            </div>
          </div>
        </div>
      ) : null}

      {zoomedImage ? (
        <div className="feed-picker-scrim" onClick={() => setZoomedImage(null)}>
          <img src={zoomedImage} alt="" className="feed-image-zoom" onClick={(event) => event.stopPropagation()} />
        </div>
      ) : null}

      {editingText ? (
        <div className="feed-picker-scrim" onClick={() => setEditingText(null)}>
          <div className="feed-picker feed-text-editor" onClick={(event) => event.stopPropagation()}>
            <header className="feed-picker-head">
              <strong>{editingText.name}</strong>
              <button type="button" className="feed-tool-btn" onClick={() => setEditingText(null)} aria-label="Close"><X size={16} /></button>
            </header>
            <textarea
              className="feed-text-editor-area"
              value={editingText.content}
              onChange={(event) => setEditingText((current) => (current ? { ...current, content: event.target.value } : current))}
              autoFocus
            />
            <div className="feed-picker-foot">
              <ActionButton
                variant="primary"
                size="small"
                onClick={() => {
                  setTexts((current) => current.map((item) => (item.id === editingText.id ? editingText : item)));
                  setEditingText(null);
                }}
              >Done</ActionButton>
            </div>
          </div>
        </div>
      ) : null}

      {hoverPreview
        ? createPortal(
            <img
              src={hoverPreview.url}
              alt=""
              className="feed-chip-hover-preview"
              style={{ left: hoverPreview.left, bottom: hoverPreview.bottom }}
            />,
            document.body,
          )
        : null}
    </form>
  );
}
