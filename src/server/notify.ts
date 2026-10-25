import { marked } from "marked";
import type { SettingsStore } from "./settings.js";
import { Bus, errorMessage, log } from "./util.js";
import type { WorkIqService } from "./workiq.js";

export interface DesktopNotification {
  title: string;
  body: string;
  sessionId?: string;
  kind?: "automation" | "heartbeat" | "info" | "error";
}

/** Fans notifications out to the UI/Electron (desktop) and, optionally, the user's own mailbox. */
export class Notifier {
  constructor(
    private readonly bus: Bus,
    private readonly settings: SettingsStore,
    private readonly workiq: WorkIqService,
  ) {}

  desktop(n: DesktopNotification): void {
    if (!this.settings.get().notifications.desktop) return;
    this.bus.publish("notify", n);
  }

  /** Emails the signed-in user (and only them) via Work IQ → Graph /me/sendMail. */
  async emailSelf(subject: string, markdown: string): Promise<{ sent: boolean; reason?: string }> {
    if (!this.settings.get().notifications.email) return { sent: false, reason: "Email notifications are turned off in Settings." };
    const user = this.workiq.status.user;
    const address = user?.mail || user?.userPrincipalName;
    if (this.workiq.status.state !== "ready" || !address) {
      return { sent: false, reason: "Microsoft 365 (Work IQ) isn't connected, so I can't email you." };
    }
    const html =
      `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px">${await marked.parse(markdown)}` +
      `<p style="color:#888;font-size:12px">Sent by OpenScout on your PC.</p></div>`;
    try {
      const res = await this.workiq.call("do_action", {
        actionUrl: "/me/sendMail",
        jsonBody: {
          message: {
            subject: subject.slice(0, 200),
            body: { contentType: "HTML", content: html },
            toRecipients: [{ emailAddress: { address } }],
          },
          saveToSentItems: false,
        },
      });
      if (res.isError) return { sent: false, reason: JSON.stringify(res.structuredContent ?? res.content).slice(0, 300) };
      return { sent: true };
    } catch (err) {
      log("notify", "emailSelf failed:", errorMessage(err));
      return { sent: false, reason: errorMessage(err) };
    }
  }
}
