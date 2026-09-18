import { html, nothing, type PropertyValues, type TemplateResult } from "lit";
import { property, state } from "lit/decorators.js";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import type { ChatAttachment } from "../../../lib/chat/chat-types.ts";
import { copyToClipboard } from "../../../lib/clipboard.ts";
import { OpenClawLightDomContentsElement } from "../../../lit/openclaw-element.ts";
import { renderAttachmentPreviewChip } from "./chat-attachment-preview-chip.ts";
import { readAttachmentText } from "./chat-attachment-text-reader.ts";
import type { AssistantAttachmentItem, AttachmentItem } from "./chat-message-media.ts";

export function isPastedTextAttachment(
  attachment: Pick<ChatAttachment, "mimeType" | "fileName" | "origin">,
): boolean {
  const { mimeType, origin, fileName } = attachment;
  // Persisted history, drafts and outbox entries can predate explicit upload origins.
  return (
    mimeType.split(";", 1)[0]?.trim().toLowerCase() === "text/plain" &&
    (origin === "paste" || (origin === undefined && /^pasted-text-\d+\.txt$/.test(fileName ?? "")))
  );
}

export function isSentPastedTextAttachment(item: AssistantAttachmentItem): item is AttachmentItem {
  return (
    item.type === "attachment" &&
    item.attachment.kind === "document" &&
    isPastedTextAttachment({
      mimeType: item.attachment.mimeType ?? "",
      fileName: item.attachment.label,
      origin: item.attachment.origin,
    })
  );
}

class ChatPastedText extends OpenClawLightDomContentsElement {
  @property() src?: string;
  @property() downloadHref?: string;
  @property() fileName = "";
  @property({ attribute: false }) sizeBytes?: number;
  @property({ attribute: false }) pending = false;
  @property({ attribute: false }) scope = "";
  @property({ attribute: false }) actions: TemplateResult | typeof nothing = nothing;
  @property({ attribute: false }) onRetry?: () => void;
  @state() private revealed = false;
  @state() private text?: string | null;
  @state() private copyState?: "copied" | "failed";
  private key = "";
  private loading?: AbortController;

  override disconnectedCallback() {
    this.loading?.abort();
    this.key = "";
    super.disconnectedCallback();
  }

  protected override willUpdate(_changed: PropertyValues<this>) {
    const key = JSON.stringify([this.scope, this.src, this.sizeBytes, this.pending]);
    if (key !== this.key) {
      this.loading?.abort();
      this.loading = undefined;
      this.key = key;
      this.text = !this.src && !this.pending ? null : undefined;
      this.copyState = undefined;
    }
    if (this.revealed && this.src && !this.loading) {
      const controller = new AbortController();
      this.loading = controller;
      void readAttachmentText(this.src, this.sizeBytes, controller.signal).then(
        (text) => this.accept(text, controller),
        () => this.accept(null, controller),
      );
    }
  }

  private accept(text: string | null, controller: AbortController) {
    if (this.isConnected && this.loading === controller && !controller.signal.aborted) {
      this.text = text;
    }
  }

  private async copy() {
    const text = this.text;
    const key = this.key;
    if (!text) {
      return;
    }
    const current = () => this.isConnected && this.key === key;
    const copied = await copyToClipboard(text, current);
    if (current()) {
      this.copyState = copied ? "copied" : "failed";
    }
  }

  private retry() {
    this.loading?.abort();
    this.loading = undefined;
    this.text = undefined;
    this.onRetry?.();
  }

  protected override render() {
    const label = t("chat.attachments.pastedText");
    return renderAttachmentPreviewChip({
      label,
      regionLabel: label,
      icon: icons.fileText,
      openOnClick: true,
      onReveal: () => {
        this.revealed = true;
      },
      content: html`
        <div class="chat-pasted-text__actions">
          <button
            type="button"
            class="btn btn--sm"
            ?disabled=${!this.text}
            @click=${() => this.copy()}
          >
            ${icons.copy} ${t(this.copyState === "copied" ? "common.copied" : "common.copy")}
          </button>
          ${this.actions}
          ${
            this.text === null && (this.src || this.onRetry)
              ? html`<button type="button" class="btn btn--sm" @click=${() => this.retry()}>
                  ${t("common.retry")}
                </button>`
              : nothing
          }
          ${
            this.text === null && this.downloadHref
              ? html`<a
                  class="btn btn--sm"
                  href=${this.downloadHref}
                  download=${this.fileName}
                  target="_blank"
                  rel="noreferrer"
                  >${icons.download} ${t("chat.attachments.downloadPastedText")}</a
                >`
              : nothing
          }
          ${this.copyState === "failed" ? html`<span role="status">${t("common.copyFailed")}</span>` : nothing}
        </div>
        ${
          this.text === undefined
            ? html`<span class="muted" role="status">${t("common.loading")}</span>`
            : this.text === null
              ? html`<span class="muted" role="status"
                  >${t("chat.attachments.pastedTextUnavailable")}</span
                >`
              : html`<pre class="chat-pasted-text__content" dir="auto">${this.text}</pre>`
        }
      `,
    });
  }
}

customElements.define("openclaw-chat-pasted-text", ChatPastedText);
