import type { AuctionSnapshot } from '../domain/focus.js';
import type { MarketDailySummary } from '../domain/market.js';
import { Logger } from '../logger.js';
import type { Notifier } from '../notify/Notifier.js';
import { nowSec } from '../utils/time.js';
import { MarketRepository } from '../db/MarketRepository.js';

export class MarketReportService {
  private readonly repo: MarketRepository;
  private readonly notifier: Notifier;
  private readonly logger: Logger;
  private readonly tz: string;
  private readonly scheduleHour: number;
  private readonly scheduleMinute: number;
  private readonly topLimit: number;

  constructor(options: {
    repo: MarketRepository;
    notifier: Notifier;
    logger: Logger;
    tz: string;
    scheduleHour: number;
    scheduleMinute: number;
    topLimit: number;
  }) {
    this.repo = options.repo;
    this.notifier = options.notifier;
    this.logger = options.logger;
    this.tz = options.tz;
    this.scheduleHour = options.scheduleHour;
    this.scheduleMinute = options.scheduleMinute;
    this.topLimit = options.topLimit;
  }

  observeAuctions(auctions: AuctionSnapshot[], atSec = nowSec()): void {
    this.repo.upsertAuctions(auctions, atSec);
  }

  isDailyReportDue(atSec = nowSec()): boolean {
    const current = this.getClock(atSec);
    const scheduledMinuteOfDay = this.scheduleHour * 60 + this.scheduleMinute;
    const currentMinuteOfDay = current.hour * 60 + current.minute;

    if (currentMinuteOfDay < scheduledMinuteOfDay) {
      return false;
    }

    return !this.repo.hasReportForDate(current.dateKey);
  }

  async emitDailyReport(auctions: AuctionSnapshot[], atSec = nowSec()): Promise<MarketDailySummary | null> {
    const clock = this.getClock(atSec);
    if (this.repo.hasReportForDate(clock.dateKey)) {
      return null;
    }

    const summary = this.buildSummary(auctions, atSec, clock.dateKey);
    const text = this.renderSummary(summary);

    this.repo.recordReport(
      clock.dateKey,
      JSON.stringify(summary),
      auctions.map((entry) => entry.playerId),
      atSec
    );

    await this.notifier.notify({
      focusId: `market-${clock.dateKey}`,
      eventType: 'market_daily_report',
      text,
      payload: {
        report_date: summary.reportDate,
        active_count: summary.activeCount,
        new_today_count: summary.newTodayCount,
        ended_since_last_report_count: summary.endedSinceLastReport.length
      }
    });

    this.logger.info('Market daily report emitted', {
      action: 'market_daily_report_emitted',
      report_date: summary.reportDate,
      active_count: summary.activeCount,
      new_today_count: summary.newTodayCount,
      ended_since_last_report_count: summary.endedSinceLastReport.length
    });

    return summary;
  }

  getStatus(atSec = nowSec()): {
    nowDate: string;
    scheduleHour: number;
    scheduleMinute: number;
    dueNow: boolean;
    lastReportDate: string | null;
    lastReportAt: number | null;
  } {
    const clock = this.getClock(atSec);
    const last = this.repo.getLastReport();

    return {
      nowDate: clock.dateKey,
      scheduleHour: this.scheduleHour,
      scheduleMinute: this.scheduleMinute,
      dueNow: this.isDailyReportDue(atSec),
      lastReportDate: last?.reportDate ?? null,
      lastReportAt: last?.createdAt ?? null
    };
  }

  private buildSummary(auctions: AuctionSnapshot[], atSec: number, reportDate: string): MarketDailySummary {
    const activeById = new Map<number, AuctionSnapshot>();
    for (const auction of auctions) {
      activeById.set(auction.playerId, auction);
    }

    const activeIds = auctions.map((entry) => entry.playerId);
    const activeSnapshots = this.repo.getPlayersByIds(activeIds);
    const recentSnapshots = this.repo.listPlayersSeenSince(atSec - 172800);

    const newToday = recentSnapshots
      .filter((player) => this.getDateKeyFromEpoch(player.firstSeenAt) === reportDate)
      .sort((a, b) => b.firstSeenAt - a.firstSeenAt);

    const topRisers = activeSnapshots
      .map((player) => {
        const fromPrice = player.firstSeenPrice;
        const toPrice = player.lastSeenPrice;
        if (fromPrice === null || toPrice === null) return null;
        const rise = toPrice - fromPrice;
        if (rise <= 0) return null;
        return {
          playerId: player.playerId,
          playerName: player.playerName,
          fromPrice,
          toPrice,
          rise
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
      .sort((a, b) => b.rise - a.rise)
      .slice(0, this.topLimit);

    const ended = this.repo
      .listEndedSinceLastReport(activeIds, this.topLimit)
      .map((entry) => ({
        playerId: entry.playerId,
        playerName: entry.playerName,
        lastSeenPrice: entry.lastSeenPrice,
        lastSeenAt: entry.lastSeenAt
      }));

    return {
      reportDate,
      nowSec: atSec,
      activeCount: auctions.length,
      newTodayCount: newToday.length,
      newTodayTop: newToday.slice(0, this.topLimit).map((entry) => {
        const active = activeById.get(entry.playerId);
        return {
          playerId: entry.playerId,
          playerName: entry.playerName,
          price: active?.currentPrice ?? entry.lastSeenPrice,
          until: active?.until ?? entry.lastUntil
        };
      }),
      topRisers,
      endedSinceLastReport: ended
    };
  }

  private renderSummary(summary: MarketDailySummary): string {
    const lines: string[] = [];
    lines.push(`📊 Informe diario mercado (${summary.reportDate})`);
    lines.push(`• Activos ahora: ${summary.activeCount}`);
    lines.push(`• Nuevos hoy: ${summary.newTodayCount}`);

    if (summary.newTodayTop.length > 0) {
      lines.push('');
      lines.push('🆕 Nuevos destacados:');
      for (const entry of summary.newTodayTop.slice(0, 5)) {
        const price = entry.price === null ? 'N/D' : entry.price.toLocaleString('es-ES');
        lines.push(`- ${entry.playerName} (${price})`);
      }
    }

    if (summary.topRisers.length > 0) {
      lines.push('');
      lines.push('📈 Top subidas (desde que aparecieron):');
      for (const entry of summary.topRisers.slice(0, 5)) {
        lines.push(
          `- ${entry.playerName}: +${entry.rise.toLocaleString('es-ES')} (${entry.fromPrice.toLocaleString('es-ES')} → ${entry.toPrice.toLocaleString('es-ES')})`
        );
      }
    }

    if (summary.endedSinceLastReport.length > 0) {
      lines.push('');
      lines.push('🏁 Salieron desde el último informe:');
      for (const entry of summary.endedSinceLastReport.slice(0, 5)) {
        const price = entry.lastSeenPrice === null ? 'N/D' : entry.lastSeenPrice.toLocaleString('es-ES');
        lines.push(`- ${entry.playerName} (último precio: ${price})`);
      }
    }

    return lines.join('\n');
  }

  private getClock(atSec: number): { dateKey: string; hour: number; minute: number } {
    const date = new Date(atSec * 1000);
    const formatter = new Intl.DateTimeFormat('sv-SE', {
      timeZone: this.tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });

    const parts = formatter.formatToParts(date);
    const year = parts.find((part) => part.type === 'year')?.value ?? '1970';
    const month = parts.find((part) => part.type === 'month')?.value ?? '01';
    const day = parts.find((part) => part.type === 'day')?.value ?? '01';
    const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? '0');
    const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? '0');

    return {
      dateKey: `${year}-${month}-${day}`,
      hour,
      minute
    };
  }

  private getDateKeyFromEpoch(atSec: number): string {
    return this.getClock(atSec).dateKey;
  }
}
