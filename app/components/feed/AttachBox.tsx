"use client";

import { BookOpen, Check, ChevronDown, Cpu, FileText, Image as ImageIcon, LoaderCircle, Paperclip, Search, Send, X } from "lucide-react";
import { type ClipboardEvent as ReactClipboardEvent, type DragEvent as ReactDragEvent, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ActionButton } from "@/app/components/ui/controls";

/** A library paper the user can attach (its PDF/HTML is sent to the agent). */
export interface LibraryPaper {
  id: string;
  title: string;
  localPath?: string | null;
  htmlSnapshotPath?: string | null;
}

export interface AttachSubmit {
  text: string;
  files: File[];
  paperIds: string[];
  /** The Bedrock model to run this feed with ("" = the default). */
  model: string;
}

/** A pickable agent model (from the Bedrock catalog, as in Settings). */
export interface FeedModelOption {
  id: string;
  label: string;
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
  hint,
  leadingAction,
  models = [],
  initialModel = "",
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
  hint?: ReactNode;
  /** Optional control shown in the tools row (e.g. a Stop button while running). */
  leadingAction?: ReactNode;
  /** Selectable agent models; empty hides the picker. */
  models?: FeedModelOption[];
  /** The feed's current model id ("" = the default). */
  initialModel?: string;
  /** The configured default model's label (Settings → AI model). */
  defaultModelLabel?: string;
  onSubmit: (payload: AttachSubmit) => Promise<boolean>;
}) {
  const [text, setText] = useState(initialText);
  const [model, setModel] = useState(initialModel);
  const [files, setFiles] = useState<File[]>([]);
  const [papers, setPapers] = useState<LibraryPaper[]>(initialPapers);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState("");
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const trayRef = useRef<HTMLDivElement>(null);

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
  const overlayOpen = pickerOpen || zoomedImage !== null || editingText !== null;
  useEffect(() => {
    if (!overlayOpen) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setZoomedImage((current) => {
        if (current !== null) return null;
        setEditingText((editing) => {
          if (editing !== null) return null;
          setPickerOpen(false);
          return editing;
        });
        return current;
      });
    }
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [overlayOpen]);

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
  previewsRef.current = previews;
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
    const cleared = await onSubmit({ text: text.trim(), files: [...files, ...textFiles], paperIds: papers.map((p) => p.id), model });
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

      {hasAttachments ? (
        <div className="feed-attach-tray" ref={trayRef}>
          {papers.map((paper) => (
            <span key={paper.id} className="feed-chip">
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
              <span key={`${file.name}-${index}`} className="feed-chip">
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

      <div className="feed-dock-input">
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            // Enter sends; Alt/Shift/Cmd/Ctrl+Enter inserts a newline instead.
            if (event.key === "Enter" && !event.altKey && !event.shiftKey && !event.metaKey && !event.ctrlKey) {
              void submit(event);
            }
          }}
          placeholder={placeholder}
          rows={compact ? 2 : 3}
          autoFocus={autoFocus}
        />

        <div className="feed-dock-actions">
          <div className="feed-dock-tools">
            <input ref={fileInputRef} type="file" multiple hidden onChange={(event) => { addFiles(event.target.files); event.target.value = ""; }} />
            <button type="button" className="feed-tool-btn" onClick={() => fileInputRef.current?.click()} aria-label="Attach a file"><Paperclip size={16} /></button>
            <button type="button" className={`feed-tool-btn ${pickerOpen ? "is-active" : ""}`} onClick={() => setPickerOpen((open) => !open)} aria-label="Attach a paper from your library"><BookOpen size={16} /></button>
            {models.length ? (
              <span className="feed-model-select">
                <Cpu size={13} aria-hidden="true" />
                <select value={model} onChange={(event) => setModel(event.target.value)} aria-label="Agent model">
                  <option value="">{defaultModelLabel ? `${defaultModelLabel} (default)` : "Default model"}</option>
                  {models.map((option) => <option value={option.id} key={option.id}>{option.label}</option>)}
                </select>
                <ChevronDown size={12} aria-hidden="true" />
              </span>
            ) : null}
            {leadingAction}
          </div>
          <div className="feed-dock-send">
            {hint ? <span className="feed-dock-hint">{hint}</span> : null}
            <ActionButton type="submit" variant="primary" size={compact ? "small" : undefined} disabled={!canSubmit} icon={submitting ? <LoaderCircle className="spin" size={15} /> : <Send size={15} />}><span className="feed-send-label">{submitLabel}</span><kbd className="feed-send-kbd">↵</kbd></ActionButton>
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
              <input value={pickerQuery} onChange={(event) => setPickerQuery(event.target.value)} placeholder="Search your library…" autoFocus />
            </div>
            <div className="feed-picker-list">
              {library
                .filter((paper) => paper.title.toLowerCase().includes(pickerQuery.trim().toLowerCase()))
                .slice(0, 60)
                .map((paper) => {
                  const attached = papers.some((item) => item.id === paper.id);
                  return (
                    <button type="button" key={paper.id} className={`feed-picker-item ${attached ? "is-attached" : ""}`} onClick={() => togglePaper(paper)}>
                      {attached ? <Check size={14} /> : <BookOpen size={14} />}
                      <span>{paper.title}</span>
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
