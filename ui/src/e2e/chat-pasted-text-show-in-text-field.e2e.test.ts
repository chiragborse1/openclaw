import { readFile } from "node:fs/promises";
import type { Locator } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { waitForCommittedComposerDraft } from "./settle.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI pasted text chips",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

const pastedText = `Quarterly launch plan\n\n  Preserve indentation 🦞\n${"x".repeat(1100)}`;
const contextOptions = {
  locale: "en-US",
  reducedMotion: "reduce" as const,
  serviceWorkers: "block" as const,
  permissions: ["clipboard-read", "clipboard-write"],
  viewport: { height: 900, width: 1280 },
};

async function paste(composer: Locator) {
  await composer.evaluate((element, text) => {
    const clipboard = new DataTransfer();
    clipboard.setData("text/plain", text);
    element.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: clipboard,
      }),
    );
  }, pastedText);
}

suite.define(() => {
  it("opens the exact pasted text by keyboard, copies it, and returns it to the text field", async () => {
    await suite.withPage(contextOptions, async ({ page }) => {
      const gateway = await installMockGateway(page);
      await page.goto(`${suite.server.baseUrl}chat`);
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      await composer.waitFor({ state: "visible" });
      await paste(composer);
      const chip = page.getByRole("button", { name: "Pasted text", exact: true });
      await chip.focus();
      await page.keyboard.press("Enter");
      const preview = page.getByRole("region", { name: "Pasted text", exact: true });
      await preview.waitFor({ state: "visible" });
      const content = preview.locator(".chat-pasted-text__content");
      await expect.poll(() => content.textContent()).toBe(pastedText);
      expect(await content.evaluate((element) => getComputedStyle(element).fontFamily)).toMatch(
        /mono/i,
      );
      await preview.getByRole("button", { name: "Copy", exact: true }).click();
      await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(pastedText);
      await preview.getByRole("button", { name: "Show in text field", exact: true }).click();
      await expect.poll(() => page.locator(".chat-attachment-thumb").count()).toBe(0);
      await expect.poll(() => composer.inputValue()).toBe(pastedText);
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
    });
  });

  it.each([
    { name: "recorded paste", legacy: false },
    { name: "legacy paste without origin", legacy: true },
  ])("restores a $name draft as a chip and sends unchanged name and bytes", async ({ legacy }) => {
    await suite.withPage(contextOptions, async ({ page }) => {
      const sessionKey = "agent:main:main";
      const gateway = await installMockGateway(page, { sessionKey });
      await page.goto(`${suite.server.baseUrl}chat?session=${encodeURIComponent(sessionKey)}`);
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      await composer.waitFor({ state: "visible" });
      await paste(composer);
      const scopeKey = `chat:v3:${sessionKey}\u0000agent:main`;
      await waitForCommittedComposerDraft(page, scopeKey, "", 1);
      const fileName = await page.evaluate(
        async ({ scopeKey: storedScopeKey, legacy: restoreLegacy }) => {
          const database = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open("openclaw-control-ui");
            request.addEventListener("success", () => resolve(request.result), { once: true });
            request.addEventListener(
              "error",
              () => reject(request.error ?? new Error("Could not open composer draft database")),
              { once: true },
            );
          });
          try {
            return await new Promise<string>((resolve, reject) => {
              const transaction = database.transaction(
                "composerDrafts",
                restoreLegacy ? "readwrite" : "readonly",
              );
              const store = transaction.objectStore("composerDrafts");
              const request = store.getAll() as IDBRequest<
                Array<{
                  scopeKey: string;
                  attachments: Array<{ fileName: string; origin?: string }>;
                }>
              >;
              let savedFileName: string | undefined;
              request.addEventListener(
                "success",
                () => {
                  const draft = request.result.find((record) => record.scopeKey === storedScopeKey);
                  const attachment = draft?.attachments[0];
                  if (!draft || !attachment) {
                    transaction.abort();
                    return;
                  }
                  savedFileName = attachment.fileName;
                  if (restoreLegacy) {
                    // Reproduce the persisted shape written before origin metadata existed.
                    delete attachment.origin;
                    store.put(draft);
                  }
                },
                { once: true },
              );
              transaction.addEventListener(
                "complete",
                () =>
                  savedFileName
                    ? resolve(savedFileName)
                    : reject(new Error("Missing persisted attachment")),
                { once: true },
              );
              transaction.addEventListener(
                "abort",
                () => reject(transaction.error ?? new Error("Draft fixture transaction aborted")),
                { once: true },
              );
              transaction.addEventListener(
                "error",
                () => reject(transaction.error ?? new Error("Draft fixture transaction failed")),
                { once: true },
              );
            });
          } finally {
            database.close();
          }
        },
        { scopeKey, legacy },
      );
      await page.reload();
      const chip = page.getByRole("button", { name: "Pasted text", exact: true });
      await chip.click();
      const preview = page.getByRole("region", { name: "Pasted text", exact: true });
      await expect
        .poll(() => preview.locator(".chat-pasted-text__content").textContent())
        .toBe(pastedText);
      await composer.click();
      await page.getByRole("button", { name: "Send message", exact: true }).click();
      await expect.poll(async () => (await gateway.getRequests("chat.send")).length).toBe(1);
      const params = (await gateway.getRequests("chat.send"))[0]!.params;
      expect(params).toEqual(
        expect.objectContaining({
          attachments: [
            {
              type: "file",
              mimeType: "text/plain",
              fileName,
              ...(!legacy ? { origin: "paste" } : {}),
              content: Buffer.from(pastedText).toString("base64"),
            },
          ],
        }),
      );
      expect(fileName).toMatch(/^pasted-text-\d+\.txt$/);
    });
  });

  it("keeps a newly uploaded lookalike filename as a file and sends file origin", async () => {
    await suite.withPage(contextOptions, async ({ page }) => {
      const gateway = await installMockGateway(page);
      await page.goto(`${suite.server.baseUrl}chat`);
      await page.locator(".agent-chat__file-input").setInputFiles({
        name: "pasted-text-123.txt",
        mimeType: "text/plain",
        buffer: Buffer.from(pastedText),
      });
      await page
        .locator(".chat-attachment-file__name", { hasText: "pasted-text-123.txt" })
        .waitFor();
      expect(await page.getByRole("button", { name: "Pasted text", exact: true }).count()).toBe(0);
      await page.getByRole("button", { name: "Send message", exact: true }).click();
      await expect.poll(async () => (await gateway.getRequests("chat.send")).length).toBe(1);
      expect((await gateway.getRequests("chat.send"))[0]!.params).toEqual(
        expect.objectContaining({
          attachments: [
            {
              type: "file",
              mimeType: "text/plain",
              fileName: "pasted-text-123.txt",
              origin: "file",
              content: Buffer.from(pastedText).toString("base64"),
            },
          ],
        }),
      );
    });
  });

  it("projects persisted origins and legacy names into ordered chips and ordinary file cards", async () => {
    await suite.withPage(contextOptions, async ({ page }) => {
      const comment =
        "Selected text:\nReview this\n\nUser comment:\nKeep spacing.\n\nSource session: agent:main:main\nSelected text UTF-16 length: 11\nDOM text UTF-16 range: [0, 11)";
      const fact = (text: string, fileName: string, origin?: "paste" | "file") => ({
        url: `data:text/plain;base64,${Buffer.from(text).toString("base64")}`,
        contentType: "text/plain",
        fileName,
        ...(origin ? { origin } : {}),
      });
      const retryUrl = `${suite.server.baseUrl}pasted-note-retry.txt`;
      let reads = 0;
      await page.route(retryUrl, (route) => {
        reads += 1;
        return route.fulfill({
          status: reads === 1 ? 503 : 200,
          contentType: "text/plain; charset=utf-8",
          body: reads === 1 ? "Temporarily unavailable" : pastedText,
        });
      });
      await installMockGateway(page, {
        historyMessages: [
          {
            role: "user",
            content: "",
            timestamp: 1,
            __openclaw: {
              media: [
                fact(comment, "selection-comment.txt", "file"),
                { ...fact(pastedText, "renamed-note.txt", "paste"), url: retryUrl },
                fact("Legacy pasted text", "pasted-text-123.txt"),
              ],
            },
          },
          {
            role: "assistant",
            content: [{ type: "text", text: "Next attachments" }],
            timestamp: 2,
          },
          {
            role: "user",
            content: "",
            timestamp: 3,
            __openclaw: {
              media: [
                fact("Chosen file", "pasted-text-123.txt", "file"),
                fact("Ordinary historical text", "pasted-text-other.txt"),
              ],
            },
          },
        ],
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      const chips = page.locator(".chat-thread-inner .chat-selection-annotations__chip");
      await expect.poll(() => chips.count()).toBe(3);
      const labels = (await chips.allTextContents()).map((label) => label.trim());
      expect(labels[0]).toMatch(/comment/i);
      expect(labels.slice(1)).toEqual(["Pasted text", "Pasted text"]);
      const cards = page.locator(".chat-thread-inner .chat-assistant-attachment-card__title");
      await expect
        .poll(async () => (await cards.allTextContents()).map((label) => label.trim()))
        .toEqual(["pasted-text-123.txt", "pasted-text-other.txt"]);
      const shell = page
        .locator(".chat-bubble")
        .filter({ has: page.locator("openclaw-chat-pasted-text") });
      expect(await shell.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(
        "rgba(0, 0, 0, 0)",
      );
      await chips.nth(1).click();
      const preview = page
        .getByRole("region", { name: "Pasted text", exact: true })
        .filter({ visible: true });
      const retry = preview.getByRole("button", { name: "Retry", exact: true });
      await retry.waitFor();
      const download = preview.getByRole("link", { name: "Download text", exact: true });
      expect(await download.getAttribute("href")).toBe(retryUrl);
      expect(await download.getAttribute("download")).toBe("renamed-note.txt");
      await retry.click();
      await expect
        .poll(() => preview.locator(".chat-pasted-text__content").textContent())
        .toBe(pastedText);
      expect(reads).toBe(2);
      expect((await chips.allTextContents()).map((label) => label.trim())).toEqual(labels);
    });
  });

  it("downloads every byte of an oversized persisted inline paste when preview is unavailable", async () => {
    await suite.withPage(contextOptions, async ({ page }) => {
      const text = "  Preserve the original UTF-8 text 🦞\n".repeat(8_000);
      const bytes = Buffer.from(text, "utf8");
      const fileName = "pasted-text-987.txt";
      expect(bytes.length).toBeGreaterThan(256 * 1024);
      await installMockGateway(page, {
        historyMessages: [
          {
            role: "user",
            content: "",
            timestamp: 1,
            __openclaw: {
              media: [
                {
                  url: `data:text/plain;base64,${bytes.toString("base64")}`,
                  contentType: "text/plain",
                  fileName,
                  origin: "paste",
                  sizeBytes: bytes.length,
                },
              ],
            },
          },
        ],
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      await page.getByRole("button", { name: "Pasted text", exact: true }).click();
      const preview = page
        .getByRole("region", { name: "Pasted text", exact: true })
        .filter({ visible: true });
      await preview
        .getByText(
          "Could not preview this text. Text previews require UTF-8 content up to 256 KiB.",
          { exact: true },
        )
        .waitFor();
      const link = preview.getByRole("link", { name: "Download text", exact: true });
      expect(await link.getAttribute("download")).toBe(fileName);
      const [download] = await Promise.all([page.waitForEvent("download"), link.click()]);
      expect(download.suggestedFilename()).toBe(fileName);
      expect(await download.failure()).toBeNull();
      const file = await download.path();
      expect(file).not.toBeNull();
      expect(await readFile(file!)).toEqual(bytes);
    });
  });
});
