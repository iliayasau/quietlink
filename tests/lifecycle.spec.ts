import { test, expect, type Page } from "@playwright/test";

const room = {
  id: "lifecycle",
  role: "guest",
  status: "admitted",
  host: "Avery",
  guest: "Jordan",
};
async function account(page: Page) {
  await page.route("**/api/me", (route) =>
    route.fulfill({
      json: {
        name: "Jordan",
        csrf: "test",
        iceServers: [],
        currentRoom: room,
      },
    }),
  );
  await page.route("**/api/rooms/lifecycle", (route) =>
    route.fulfill({ json: room }),
  );
}

declare global {
  interface Window {
    mediaTest: { tracks: MediaStreamTrack[]; release: () => void };
    signalTest: {
      message: (type: string, epoch?: number) => void;
      close: () => void;
      release: () => void;
      releaseOld: () => void;
      created: number;
      descriptions: number;
      answers: number;
      closed: number;
      sent: string[];
    };
  }
}

for (const status of [404, 401]) {
  test(`late camera permission stops all tracks after ${status}`, async ({
    page,
  }) => {
    await account(page);
    await page.addInitScript(() => {
      const original = navigator.mediaDevices.getUserMedia.bind(
        navigator.mediaDevices,
      );
      navigator.mediaDevices.getUserMedia = async (constraints) => {
        const media = await original(constraints);
        return new Promise((resolve) => {
          window.mediaTest = {
            tracks: media.getTracks(),
            release: () => resolve(media),
          };
        });
      };
    });
    await page.goto("/");
    await page
      .getByRole("button", { name: "Enable camera & microphone" })
      .click();
    await expect
      .poll(() => page.evaluate(() => window.mediaTest?.tracks.length ?? 0))
      .toBe(2);
    await page.route("**/api/rooms/lifecycle", (route) =>
      route.fulfill({ status, json: { error: "Ended" } }),
    );
    await expect(
      page.getByRole("button", { name: "Leave", exact: true }),
    ).toHaveCount(0);
    await page.evaluate(() => window.mediaTest.release());
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.mediaTest.tracks.every((t) => t.readyState === "ended"),
        ),
      )
      .toBe(true);
    await expect(
      page.getByRole("button", { name: "Mute microphone", exact: true }),
    ).toBeDisabled();
    await expect(page.locator("video")).toHaveCount(0);
  });
}

for (const boundary of [
  "close",
  "reset",
  "overflow",
  "pending-reset",
  "late-reset",
] as const) {
  test(`delayed negotiation discards stale work on ${boundary}`, async ({
    page,
  }) => {
    await account(page);
    await page.addInitScript(() => {
      const h = (window.signalTest = {
        message: (_type: string, _epoch = 1) => {},
        close: () => {},
        release: () => {},
        releaseOld: () => {},
        created: 0,
        descriptions: 0,
        answers: 0,
        closed: 0,
        sent: [] as string[],
      });
      class Socket {
        static OPEN = 1;
        readyState = 1;
        onmessage: ((event: { data: string }) => void) | null = null;
        onclose: ((event: { code: number }) => void) | null = null;
        constructor() {
          h.message = (type, epoch = 1) =>
            this.onmessage?.({
              data: JSON.stringify({ type, epoch, sdp: "v=0" }),
            });
          h.close = () => this.close();
        }
        send(value: string) {
          h.sent.push(value);
        }
        close(code = 1000) {
          if (code !== 1000 && (code < 3000 || code > 4999))
            throw new DOMException("Invalid close code", "InvalidAccessError");
          this.readyState = 3;
          h.closed++;
          this.onclose?.({ code: 1008 });
        }
      }
      class Peer {
        connectionState = "new";
        remoteDescription = null;
        constructor() {
          h.created++;
        }
        addTrack() {}
        close() {}
        setRemoteDescription() {
          h.descriptions++;
          return new Promise<void>((resolve) => {
            h.release = resolve;
          });
        }
        async createAnswer() {
          h.answers++;
          return { type: "answer", sdp: "v=0" };
        }
        async setLocalDescription() {}
        async addIceCandidate() {}
      }
      window.WebSocket = Socket as unknown as typeof WebSocket;
      window.RTCPeerConnection = Peer as unknown as typeof RTCPeerConnection;
    });
    await page.goto("/");
    await page
      .getByRole("button", { name: "Enable camera & microphone" })
      .click();
    await expect(page.locator(".connection-label")).toHaveText(
      "Opening the room",
    );
    await page.evaluate(() => {
      window.signalTest.message("reset");
      window.signalTest.message("offer");
    });
    await expect
      .poll(() => page.evaluate(() => window.signalTest.descriptions))
      .toBe(1);
    await page.evaluate((boundary) => {
      const h = window.signalTest;
      h.releaseOld = h.release;
      h.message("offer"); // Queued behind the unresolved remote description.
      if (boundary === "close") h.close();
      else if (boundary !== "overflow") h.message("reset", 2);
      else for (let i = 0; i < 40; i++) h.message("offer");
      if (boundary !== "pending-reset" && boundary !== "late-reset")
        h.release();
    }, boundary);
    // Flush the continuation through a browser task before checking no stale work ran.
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(
      await page.evaluate(() => ({
        created: window.signalTest.created,
        descriptions: window.signalTest.descriptions,
        answers: window.signalTest.answers,
      })),
    ).toEqual({
      created: boundary === "close" || boundary === "overflow" ? 1 : 2,
      descriptions: 1,
      answers: 0,
    });
    if (boundary === "close" || boundary === "overflow") {
      expect(await page.evaluate(() => window.signalTest.closed)).toBe(1);
      await expect(page.locator(".connection-label")).toHaveText(
        "Connection ended. Retry to reconnect.",
      );
    } else {
      await page.evaluate(() => window.signalTest.message("offer", 2));
      await expect
        .poll(() => page.evaluate(() => window.signalTest.descriptions))
        .toBe(2);
      // In pending-reset the first promise is never released, even at teardown.
      if (boundary === "late-reset") {
        await page.evaluate(() => window.signalTest.releaseOld());
        await page.evaluate(
          () => new Promise((resolve) => setTimeout(resolve, 0)),
        );
        await page.evaluate(() => window.signalTest.message("offer", 2));
        await page.evaluate(
          () => new Promise((resolve) => setTimeout(resolve, 0)),
        );
        // The old drain's finally must not unlock the active epoch's drain.
        expect(await page.evaluate(() => window.signalTest.descriptions)).toBe(
          2,
        );
      }
      await page.evaluate(() => window.signalTest.release());
      await expect
        .poll(() => page.evaluate(() => window.signalTest.answers))
        .toBe(1);
      expect(
        await page.evaluate(() =>
          window.signalTest.sent
            .map((s) => JSON.parse(s))
            .filter((m) => m.type === "answer")
            .map((m) => m.epoch),
        ),
      ).toEqual([2]);
      if (boundary === "late-reset") {
        await expect
          .poll(() => page.evaluate(() => window.signalTest.descriptions))
          .toBe(3);
        await page.evaluate(() => window.signalTest.release());
        await expect
          .poll(() => page.evaluate(() => window.signalTest.answers))
          .toBe(2);
      }
    }
  });
}
