import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { Logger } from '../logger.js';
import { asRecord } from '../utils/types.js';

interface ClientOptions {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  logger: Logger;
}

export class McpBiwengerClient {
  private readonly options: ClientOptions;
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private connecting: Promise<void> | null = null;

  constructor(options: ClientOptions) {
    this.options = options;
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    return this.withReconnect(async () => {
      const client = await this.getClient();
      const result = await client.callTool({ name, arguments: args });
      return this.extractPayload(result);
    });
  }

  async listTools(): Promise<string[]> {
    return this.withReconnect(async () => {
      const client = await this.getClient();
      const response = await client.listTools();
      return response.tools.map((tool) => tool.name);
    });
  }

  async close(): Promise<void> {
    const transport = this.transport;
    this.transport = null;
    this.client = null;
    this.connecting = null;

    if (transport) {
      await transport.close();
    }
  }

  private async withReconnect<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (!this.isRecoverable(error)) {
        throw error;
      }

      this.options.logger.warn('MCP connection dropped, reconnecting', {
        action: 'mcp_reconnect',
        error: this.errorMessage(error)
      });

      await this.resetConnection();
      return operation();
    }
  }

  private async getClient(): Promise<Client> {
    if (this.client) return this.client;

    if (!this.connecting) {
      this.connecting = this.connect();
    }

    await this.connecting;
    this.connecting = null;

    if (!this.client) {
      throw new Error('MCP client unavailable after connect.');
    }

    return this.client;
  }

  private async connect(): Promise<void> {
    const transport = new StdioClientTransport({
      command: this.options.command,
      args: this.options.args,
      cwd: this.options.cwd,
      env: this.sanitizeEnv(this.options.env)
    });

    const client = new Client(
      {
        name: 'openclaw-biwenger-focus',
        version: '0.1.0'
      },
      {
        capabilities: {}
      }
    );

    await client.connect(transport);
    this.transport = transport;
    this.client = client;

    this.options.logger.info('Connected to biwenger MCP', {
      action: 'mcp_connected',
      command: this.options.command,
      args: this.options.args
    });
  }

  private async resetConnection(): Promise<void> {
    try {
      await this.close();
    } finally {
      this.connecting = null;
    }
  }

  private extractPayload(result: unknown): Record<string, unknown> {
    const resultRecord = asRecord(result);
    const isError = resultRecord.isError === true;
    const structured = asRecord(resultRecord.structuredContent);
    if (Object.keys(structured).length > 0) {
      if (isError || structured.ok === false) {
        throw new Error(this.readError(structured, resultRecord));
      }
      return structured;
    }

    const content = Array.isArray(resultRecord.content) ? resultRecord.content : [];
    const firstText = content.find((entry) => asRecord(entry).type === 'text');
    const firstTextRecord = firstText ? asRecord(firstText) : null;
    const firstTextValue = firstTextRecord && typeof firstTextRecord.text === 'string'
      ? firstTextRecord.text
      : '';

    if (!firstText) {
      if (isError) {
        throw new Error('MCP call failed without error payload.');
      }
      return {};
    }

    try {
      const parsed = asRecord(JSON.parse(firstTextValue));
      if (isError || parsed.ok === false) {
        throw new Error(this.readError(parsed, resultRecord));
      }
      return parsed;
    } catch (error) {
      if (isError) {
        throw new Error(firstTextValue);
      }

      if (error instanceof Error) {
        throw new Error(`Invalid JSON payload from MCP: ${error.message}`);
      }

      throw new Error('Invalid JSON payload from MCP.');
    }
  }

  private readError(payload: Record<string, unknown>, result: Record<string, unknown>): string {
    const message = payload.error;
    if (typeof message === 'string' && message.length > 0) {
      return message;
    }

    if (result.isError === true) {
      const content = Array.isArray(result.content) ? result.content : [];
      const firstText = content.find((entry) => asRecord(entry).type === 'text');
      const textRecord = firstText ? asRecord(firstText) : null;
      if (textRecord && typeof textRecord.text === 'string') return textRecord.text;
    }

    return 'MCP tool execution error';
  }

  private sanitizeEnv(env: NodeJS.ProcessEnv | undefined): Record<string, string> | undefined {
    if (!env) return undefined;

    const safeEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
      if (typeof value === 'string') {
        safeEnv[key] = value;
      }
    }
    return safeEnv;
  }

  private isRecoverable(error: unknown): boolean {
    const message = this.errorMessage(error).toLowerCase();
    return (
      message.includes('connection')
      || message.includes('closed')
      || message.includes('econn')
      || message.includes('broken pipe')
      || message.includes('transport')
      || message.includes('write after end')
    );
  }

  private errorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    return String(error);
  }
}
