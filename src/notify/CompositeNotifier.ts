import type { FocusNotification, Notifier } from './Notifier.js';

export class CompositeNotifier implements Notifier {
  private readonly notifiers: Notifier[];

  constructor(notifiers: Notifier[]) {
    this.notifiers = notifiers;
  }

  async notify(event: FocusNotification): Promise<void> {
    await Promise.all(this.notifiers.map(async (notifier) => notifier.notify(event)));
  }
}
