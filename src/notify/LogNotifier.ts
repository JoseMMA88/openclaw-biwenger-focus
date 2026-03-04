import { Logger } from '../logger.js';
import type { FocusNotification, Notifier } from './Notifier.js';

export class LogNotifier implements Notifier {
  private readonly logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  async notify(event: FocusNotification): Promise<void> {
    this.logger.info('focus_event', {
      action: 'focus_event',
      focus_id: event.focusId,
      event_type: event.eventType,
      message: event.text,
      payload: event.payload ?? null
    });
  }
}
