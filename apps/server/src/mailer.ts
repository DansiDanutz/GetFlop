import type { Logger } from './http/errors.js';

export interface Mail {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
}

export interface Mailer {
  send(mail: Mail): Promise<void>;
}

/** Dev/test mailer: keeps messages in memory and logs them (no delivery). */
export class MemoryMailer implements Mailer {
  readonly outbox: Mail[] = [];
  constructor(private readonly logger?: Logger) {}
  async send(mail: Mail): Promise<void> {
    this.outbox.push(mail);
    this.logger?.info(`[mail] to=${mail.to} subject="${mail.subject}"\n${mail.text}`);
  }
  lastTo(to: string): Mail | undefined {
    return [...this.outbox].reverse().find((m) => m.to === to);
  }
}
