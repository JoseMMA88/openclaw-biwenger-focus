export interface FocusNotification {
  focusId: string;
  eventType: string;
  text: string;
  payload?: Record<string, unknown>;
}

export interface Notifier {
  notify(event: FocusNotification): Promise<void>;
}
