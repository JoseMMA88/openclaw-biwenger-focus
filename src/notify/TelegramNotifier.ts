import type { FocusNotification, Notifier } from './Notifier.js';

interface TelegramNotifierOptions {
  botToken: string;
  chatId: string;
}

export class TelegramNotifier implements Notifier {
  private readonly botToken: string;
  private readonly chatId: string;

  constructor(options: TelegramNotifierOptions) {
    this.botToken = options.botToken;
    this.chatId = options.chatId;
  }

  async notify(event: FocusNotification): Promise<void> {
    const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;

    const body = {
      chat_id: this.chatId,
      text: event.text,
      disable_web_page_preview: true
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const payload = await response.text();
      throw new Error(`Telegram send failed (${response.status}): ${payload}`);
    }
  }
}
