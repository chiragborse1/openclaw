import { html, type TemplateResult } from "lit";
import { scrollState } from "../../../components/scroll-state.ts";
import "../../../components/tooltip.ts";
import "../../../styles/chat/selection-annotations.css";

export function renderAttachmentPreviewChip(options: {
  label: string;
  regionLabel: string;
  icon: TemplateResult;
  content: TemplateResult;
  onReveal?: () => void;
  openOnClick?: boolean;
}) {
  return html`<openclaw-tooltip
    class="chat-comment-preview"
    placement="top-start"
    auto-size
    .describe=${false}
    .openOnClick=${options.openOnClick ?? false}
  >
    <span
      class="chat-attachment-thumb chat-attachment-thumb--file chat-selection-annotations__chip"
      role="button"
      tabindex="0"
      @pointerenter=${options.onReveal}
      @focusin=${options.onReveal}
      @click=${options.openOnClick ? options.onReveal : undefined}
      @keydown=${(event: KeyboardEvent) => {
        if (
          options.openOnClick &&
          (event.key === "Enter" || event.key === " ") &&
          event.currentTarget instanceof HTMLElement
        ) {
          event.preventDefault();
          event.currentTarget.click();
        }
      }}
    >
      <span class="chat-attachment-file">
        <span aria-hidden="true">${options.icon}</span>
        ${options.label}
      </span>
    </span>
    <div
      slot="content"
      class="chat-comment-preview__scroll"
      tabindex="0"
      role="region"
      aria-label=${options.regionLabel}
      ${scrollState()}
    >
      ${options.content}
    </div>
  </openclaw-tooltip>`;
}
