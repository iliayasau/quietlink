import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

// Test-only media injection. Never invokes the user's camera or microphone.
async function portraitInput(context: BrowserContext, name: string) {
  const bytes = await readFile(
    resolve(import.meta.dirname, "../docs/demo-media", name),
  );
  await context.addInitScript(
    (dataUrl) => {
      navigator.mediaDevices.getUserMedia = async () => {
        const portrait = new Image();
        portrait.src = dataUrl;
        await portrait.decode();
        const canvas = document.createElement("canvas");
        canvas.width = 1280;
        canvas.height = 720;
        const paint = () =>
          canvas
            .getContext("2d")!
            .drawImage(portrait, 0, 0, canvas.width, canvas.height);
        paint();
        const stream = canvas.captureStream(10);
        stream.getVideoTracks()[0].contentHint = "detail";
        // Repaint the static source so WebRTC sends frames throughout the call.
        const timer = window.setInterval(paint, 100);
        const audio = new AudioContext();
        await audio.resume();
        const silence = audio.createMediaStreamDestination();
        const oscillator = audio.createOscillator();
        const gain = audio.createGain();
        gain.gain.value = 0;
        oscillator.connect(gain).connect(silence);
        oscillator.start();
        stream.addTrack(silence.stream.getAudioTracks()[0]);
        for (const track of stream.getTracks()) {
          const stop = track.stop.bind(track);
          track.stop = () => {
            stop();
            if (
              stream.getTracks().every((item) => item.readyState === "ended")
            ) {
              clearInterval(timer);
              oscillator.stop();
              void audio.close();
            }
          };
        }
        return stream;
      };
    },
    `data:image/png;base64,${bytes.toString("base64")}`,
  );
}

async function login(page: Page, name: string) {
  await page.goto("/");
  await page.getByRole("link", { name: "Sign in to continue" }).click();
  await page.getByLabel("Test identity").selectOption(name);
  await page.getByRole("button", { name: "Continue to QuietLink" }).click();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
}

test("capture a local call with fictional adult demo portraits", async ({
  browser,
  baseURL,
}) => {
  const host = await browser.newContext({
    baseURL,
    viewport: { width: 1440, height: 1000 },
  });
  const guest = await browser.newContext({ baseURL });
  try {
    await portraitInput(host, "avery.png");
    await portraitInput(guest, "jordan.png");
    const page = await host.newPage();
    const other = await guest.newPage();
    await login(page, "Avery");
    await login(other, "Jordan");
    await page
      .getByRole("button", { name: "Enable camera & microphone" })
      .click();
    await page.getByRole("button", { name: "Create a private room" }).click();
    const invite = await page
      .getByLabel("Private invitation link")
      .inputValue();
    await other.goto(invite);
    await other
      .getByRole("button", { name: "Enable camera & microphone" })
      .click();
    await other.getByRole("button", { name: "Request to join" }).click();
    await page.getByRole("button", { name: "Accept", exact: true }).click();
    for (const participant of [page, other]) {
      await expect(participant.locator(".connection-label")).toHaveText(
        "Connected",
      );
      await expect
        .poll(() =>
          participant
            .locator('video[aria-label="Guest video"]')
            .evaluate(
              (video: HTMLVideoElement) =>
                video.readyState >= 2 &&
                video.videoWidth >= 1280 &&
                video.currentTime > 5,
            ),
        )
        .toBe(true);
    }
    for (const [label, width] of [
      ["desktop", 1440],
      ["tablet", 768],
      ["mobile", 390],
    ] as const) {
      await page.setViewportSize({ width, height: 1000 });
      await page.evaluate(() => document.fonts.ready);
      await expect(page.locator(".connection-label")).toHaveText("Connected");
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await expect(
        page.locator('video[aria-label="Your camera preview"]'),
      ).toBeVisible();
      await page.screenshot({
        path: resolve(
          import.meta.dirname,
          `../docs/screenshots/call-${label}.png`,
        ),
        fullPage: true,
        animations: "disabled",
      });
    }
    await page.getByRole("button", { name: "Leave", exact: true }).click();
  } finally {
    for (const context of [host, guest]) {
      const response = await context.request.get("/api/me");
      if (response.ok()) {
        const me = await response.json();
        await context.request.post("/api/logout", {
          headers: { Origin: baseURL!, "X-CSRF-Token": me.csrf },
          data: {},
        });
      }
      await context.close();
    }
  }
});
