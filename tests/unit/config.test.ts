import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/config.js';

describe('loadConfig', () => {
  it('reads market report toggle from OpenClaw plugin entry config', () => {
    const home = mkdtempSync(join(tmpdir(), 'biwenger-focus-config-'));
    const configDir = join(home, '.openclaw');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'openclaw.json'), JSON.stringify({
      plugins: {
        entries: {
          'biwenger-focus': {
            enabled: true,
            config: {
              db_path: '/tmp/biwenger-focus-test.db',
              market_report_enabled: false
            }
          }
        }
      }
    }));

    try {
      const config = loadConfig({}, { HOME: home });

      expect(config.marketReportEnabled).toBe(false);
      expect(config.dbPath).toBe('/tmp/biwenger-focus-test.db');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('lets MARKET_REPORT_ENABLED override OpenClaw config file', () => {
    const home = mkdtempSync(join(tmpdir(), 'biwenger-focus-config-'));
    const configDir = join(home, '.openclaw');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'openclaw.json'), JSON.stringify({
      plugins: {
        entries: {
          'biwenger-focus': {
            config: {
              market_report_enabled: true
            }
          }
        }
      }
    }));

    try {
      const config = loadConfig({}, {
        HOME: home,
        MARKET_REPORT_ENABLED: 'false'
      });

      expect(config.marketReportEnabled).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('does not overwrite file config false with undefined runtime config values', () => {
    const home = mkdtempSync(join(tmpdir(), 'biwenger-focus-config-'));
    const configDir = join(home, '.openclaw');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'openclaw.json'), JSON.stringify({
      plugins: {
        entries: {
          'biwenger-focus': {
            config: {
              market_report_enabled: false
            }
          }
        }
      }
    }));

    try {
      const config = loadConfig({
        market_report_enabled: undefined
      }, {
        HOME: home
      });

      expect(config.marketReportEnabled).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
