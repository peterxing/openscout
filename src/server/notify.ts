import { marked } from "marked";
import type { M365Service } from "./m365.js";
import type { SettingsStore } from "./settings.js";
import { Bus, errorMessage, log } from "./util.js";

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
    private readonly m365: M365Service,
  ) {}

  desktop(n: DesktopNotification): void {
    if (!this.settings.get().notifications.desktop) return;
    this.bus.publish("notify", n);
  }

  /** Emails the signed-in user (and only them) through Microsoft Graph /me/sendMail. */
  async emailSelf(subject: string, markdown: string): Promise<{ sent: boolean; reason?: string }> {
    if (!this.settings.get().notifications.email) return { sent: false, reason: "Email notifications are turned off in Settings." };
    const status = this.m365.status();
    const address = status.user?.mail || status.user?.userPrincipalName;
    if (status.state !== "ready" || !address) {
      return { sent: false, reason: "Microsoft 365 isn't connected, so I can't email you." };
    }
    const html =
      `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px">${await marked.parse(markdown)}` +
      `<p style="color:#888;font-size:12px">Sent by OpenScout on your PC.</p></div>`;
    try {
      const res = await this.m365.action("/me/sendMail", {
        message: {
          subject: subject.slice(0, 200),
          body: { contentType: "HTML", content: html },
          toRecipients: [{ emailAddress: { address } }],
        },
        saveToSentItems: false,
      });
      return res.ok ? { sent: true } : { sent: false, reason: res.text.slice(0, 300) };
    } catch (err) {
      log("notify", "emailSelf failed:", errorMessage(err));
      return { sent: false, reason: errorMessage(err) };
    }
  }
}
